// server.js - API para scraper on-demand (Optimizado con sesión única)
const express = require('express');
const puppeteer = require('puppeteer');
const Airtable = require('airtable');

const app = express();
app.use(express.json());

const CONFIG = {
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  API_SECRET: process.env.API_SECRET || 'your-secret-key',
  PAGE_TIMEOUT: 90000,
  MAX_POSTS: 10,
  DELAY_BETWEEN_URLS: 30000, // 30 segundos entre URLs
  PORT: process.env.PORT || 3000
};

const base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(CONFIG.AIRTABLE_BASE_ID);

// Middleware de autenticación
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || authHeader !== `Bearer ${CONFIG.API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}

// Utilidades
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const log = (message, type = 'info') => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
};

// Detectar tipo de URL
function detectUrlType(url) {
  if (url.includes('/in/')) {
    return 'profile';
  } else if (url.includes('/company/')) {
    return 'company';
  }
  return 'unknown';
}

// Normalizar URL
function normalizeUrl(url) {
  url = url.trim().replace(/\/$/, '');
  
  const type = detectUrlType(url);
  
  if (type === 'profile') {
    if (!url.includes('/recent-activity/')) {
      return `${url}/recent-activity/all/`;
    }
    return url;
  } else if (type === 'company') {
    if (!url.includes('/posts/')) {
      return `${url}/posts/`;
    }
    return url;
  }
  
  return url;
}

// Extraer nombre del autor
function extractAuthorName(url) {
  const urlType = detectUrlType(url);
  
  if (urlType === 'profile') {
    const match = url.match(/linkedin\.com\/in\/([^\/]+)/);
    return match ? match[1].replace(/-/g, ' ') : 'Unknown';
  } else if (urlType === 'company') {
    const match = url.match(/linkedin\.com\/company\/([^\/]+)/);
    return match ? match[1].replace(/-/g, ' ') : 'Unknown Company';
  }
  
  return 'Unknown';
}

// Función para cargar cookies
async function loadCookies(page) {
  try {
    if (!process.env.LINKEDIN_COOKIES) {
      return false;
    }
    
    const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    await page.goto('https://www.linkedin.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);
    await page.setCookie(...cookies);
    return true;
  } catch (error) {
    log(`Error cargando cookies: ${error.message}`, 'error');
    return false;
  }
}

// Función para verificar login
async function checkIfLoggedIn(page) {
  try {
    const checks = await page.evaluate(() => {
      return {
        hasGlobalNav: document.querySelector('nav.global-nav') !== null,
        hasProfileIcon: document.querySelector('[data-control-name="nav.settings"]') !== null,
        url: window.location.href
      };
    });
    
    return checks.hasGlobalNav || checks.hasProfileIcon || 
           checks.url.includes('/feed') || checks.url.includes('/in/');
  } catch (error) {
    return false;
  }
}

// Extraer posts según tipo
async function extractPosts(page, urlType, maxPosts) {
  return await page.evaluate((urlType, maxPosts) => {
    const results = [];
    
    // Selectores comunes
    const selectors = [
      'div.feed-shared-update-v2',
      'li.profile-creator-shared-feed-update__container',
      'li[data-test-update-container]',
      'div[data-urn*="activity"]',
      'article.feed-shared-update-v2',
      'article'
    ];
    
    let postElements = [];
    for (const selector of selectors) {
      postElements = document.querySelectorAll(selector);
      if (postElements.length > 0) break;
    }
    
    for (let i = 0; i < Math.min(postElements.length, maxPosts); i++) {
      const post = postElements[i];
      
      try {
        // Contenido del post
        const contentSelectors = [
          '.feed-shared-update-v2__description',
          '.update-components-text',
          '.break-words',
          '.feed-shared-text',
          'div[dir="ltr"]'
        ];
        
        let content = '';
        for (const sel of contentSelectors) {
          const el = post.querySelector(sel);
          if (el && el.innerText && el.innerText.trim().length > 10) {
            content = el.innerText.trim();
            break;
          }
        }
        
        if (!content) continue;
        
        // Fecha
        const timeEl = post.querySelector('time');
        const date = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();
        
        // URL del post
        const linkEl = post.querySelector('a[href*="/posts/"]') ||
                       post.querySelector('a[href*="/feed/update/"]');
        let postUrl = linkEl ? linkEl.href : '';
        
        if (!postUrl) {
          const urn = post.getAttribute('data-urn');
          if (urn) postUrl = `https://www.linkedin.com/feed/update/${urn}`;
        }
        
        if (!postUrl) continue;
        
        // Métricas
        let likes = 0;
        let comments = 0;
        
        // Intentar obtener likes de botones con aria-label
        const reactionButton = post.querySelector('button[aria-label*="reaction"]');
        if (reactionButton) {
          const match = reactionButton.getAttribute('aria-label').match(/(\d+[\d,\.]*)/);
          if (match) likes = parseInt(match[1].replace(/[,\.]/g, ''));
        }
        
        // Intentar obtener comments de botones con aria-label
        const commentButton = post.querySelector('button[aria-label*="comment"]');
        if (commentButton) {
          const match = commentButton.getAttribute('aria-label').match(/(\d+[\d,\.]*)/);
          if (match) comments = parseInt(match[1].replace(/[,\.]/g, ''));
        }
        
        // Backup: buscar en social counts
        if (likes === 0) {
          const socialCounts = post.querySelector('.social-details-social-counts');
          if (socialCounts) {
            const text = socialCounts.innerText;
            const match = text.match(/(\d+[\d,\.]*)/);
            if (match) likes = parseInt(match[1].replace(/[,\.]/g, ''));
          }
        }
        
        // Detectar media
        const hasMedia = post.querySelector('img[src*="media"]') !== null || 
                        post.querySelector('video') !== null;
        
        results.push({
          content: content.substring(0, 1000),
          date,
          postUrl,
          likes,
          comments,
          hasMedia,
          type: urlType
        });
        
      } catch (err) {
        console.error('Error extrayendo post:', err);
      }
    }
    
    return results;
  }, urlType, maxPosts);
}

// Scrape una URL dentro de una sesión existente
async function scrapeUrlInSession(page, url, maxPosts = CONFIG.MAX_POSTS) {
  try {
    const urlType = detectUrlType(url);
    const normalizedUrl = normalizeUrl(url);
    
    log(`Scraping ${urlType}: ${normalizedUrl}`);
    
    // Navegar a la URL
    await page.goto(normalizedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.PAGE_TIMEOUT
    });
    
    await delay(5000);
    
    // Scroll para cargar posts
    const scrolls = urlType === 'company' ? 10 : 8;
    
    for (let i = 0; i < scrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await delay(2500);
    }
    
    await delay(3000);
    
    // Extraer posts
    const posts = await extractPosts(page, urlType, maxPosts);
    
    log(`Encontrados ${posts.length} posts de ${urlType}`);
    
    return {
      success: true,
      url: normalizedUrl,
      urlType,
      authorName: extractAuthorName(url),
      postsFound: posts.length,
      posts
    };
    
  } catch (error) {
    log(`Error scraping ${url}: ${error.message}`, 'error');
    return {
      success: false,
      url,
      error: error.message,
      posts: []
    };
  }
}

// Función principal: scrape múltiples URLs en una sola sesión
async function scrapeMultipleUrls(urls, maxPostsPerUrl = CONFIG.MAX_POSTS) {
  let browser;
  
  try {
    log(`🚀 Iniciando sesión del navegador para ${urls.length} URLs`);
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1920x1080',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    
    // Login UNA SOLA VEZ
    log('Iniciando sesión en LinkedIn...');
    const cookiesLoaded = await loadCookies(page);
    if (!cookiesLoaded) {
      throw new Error('No se pudieron cargar las cookies');
    }
    
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.PAGE_TIMEOUT
    });
    
    await delay(5000);
    
    const isLoggedIn = await checkIfLoggedIn(page);
    if (!isLoggedIn) {
      throw new Error('Login falló - cookies inválidas');
    }
    
    log('✅ Login exitoso - Comenzando scraping de URLs');
    
    // Scrape cada URL en la misma sesión
    const results = [];
    
    for (let i = 0; i < urls.length; i++) {
      const urlData = typeof urls[i] === 'string' 
        ? { url: urls[i], maxPosts: maxPostsPerUrl }
        : urls[i];
      
      const url = urlData.url || urlData.profileUrl || urlData['Profile URL'];
      
      if (!url) {
        log(`URL ${i + 1} no válida, saltando...`, 'warn');
        results.push({
          success: false,
          error: 'URL no proporcionada',
          posts: []
        });
        continue;
      }
      
      // Validar URL
      const urlType = detectUrlType(url);
      if (urlType === 'unknown') {
        log(`URL ${i + 1} tipo desconocido: ${url}`, 'warn');
        results.push({
          success: false,
          url,
          error: 'Tipo de URL no soportado',
          posts: []
        });
        continue;
      }
      
      // Scrape la URL
      const result = await scrapeUrlInSession(
        page, 
        url, 
        urlData.maxPosts || maxPostsPerUrl
      );
      
      results.push(result);
      
      // Delay entre URLs (excepto la última)
      if (i < urls.length - 1) {
        log(`Esperando ${CONFIG.DELAY_BETWEEN_URLS / 1000}s antes de la siguiente URL...`);
        await delay(CONFIG.DELAY_BETWEEN_URLS);
      }
    }
    
    log(`✅ Scraping completado: ${results.filter(r => r.success).length}/${urls.length} exitosos`);
    
    return {
      success: true,
      totalUrls: urls.length,
      successfulUrls: results.filter(r => r.success).length,
      failedUrls: results.filter(r => !r.success).length,
      results
    };
    
  } catch (error) {
    log(`Error general: ${error.message}`, 'error');
    return {
      success: false,
      error: error.message,
      results: []
    };
  } finally {
    if (browser) {
      await browser.close();
      log('Navegador cerrado');
    }
  }
}

// Guardar resultados en Airtable
async function saveResultsToAirtable(results, defaultGroup = 'On-Demand') {
  const summary = {
    totalProcessed: 0,
    totalSaved: 0,
    byUrl: []
  };
  
  for (const result of results) {
    if (!result.success || !result.posts || result.posts.length === 0) {
      summary.byUrl.push({
        url: result.url,
        saved: 0,
        error: result.error
      });
      continue;
    }
    
    const saved = [];
    
    for (const post of result.posts) {
      try {
        // Verificar si existe
        const existing = await base('LinkedIn Posts')
          .select({
            filterByFormula: `{Post URL} = "${post.postUrl}"`,
            maxRecords: 1
          })
          .all();
        
        if (existing.length === 0) {
          await base('LinkedIn Posts').create([{
            fields: {
              'Author Name': result.authorName || extractAuthorName(result.url),
              'Author Profile URL': result.url,
              'Group': defaultGroup,
              'Post Content': post.content,
              'Post Date': post.date,
              'Post URL': post.postUrl,
              'Likes': post.likes || 0,
              'Comments': post.comments || 0,
              'Has Media': post.hasMedia || false,
              'Source Type': result.urlType === 'profile' ? 'Profile' : 'Company',
              'Status': 'New'
            }
          }]);
          
          saved.push(post.postUrl);
          summary.totalSaved++;
        }
        
        summary.totalProcessed++;
        await delay(500);
        
      } catch (error) {
        log(`Error guardando post: ${error.message}`, 'error');
      }
    }
    
    summary.byUrl.push({
      url: result.url,
      urlType: result.urlType,
      saved: saved.length,
      total: result.posts.length
    });
  }
  
  return summary;
}

// ========================================
// ENDPOINTS DE LA API
// ========================================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    supportedTypes: ['profile (/in/)', 'company (/company/)'],
    optimized: 'single-session for multiple URLs'
  });
});

// Scrape múltiples URLs (optimizado - una sola sesión)
app.post('/api/scrape', authenticate, async (req, res) => {
  try {
    let { urls, maxPosts } = req.body;
    
    // Aceptar tanto array como objeto con "Profile URL"
    if (!urls) {
      return res.status(400).json({ 
        error: 'Campo "urls" es requerido',
        example: {
          urls: [
            "https://www.linkedin.com/in/williamhgates/",
            "https://www.linkedin.com/company/mckinsey/posts/"
          ],
          maxPosts: 10
        }
      });
    }
    
    // Si recibe formato [{Profile URL: [...]}], extraer URLs
    if (Array.isArray(urls) && urls.length > 0 && urls[0]['Profile URL']) {
      urls = urls[0]['Profile URL'];
    }
    
    if (!Array.isArray(urls)) {
      urls = [urls];
    }
    
    if (urls.length === 0) {
      return res.status(400).json({ error: 'El array de URLs está vacío' });
    }
    
    log(`📥 Solicitud de scraping para ${urls.length} URLs`);
    
    const result = await scrapeMultipleUrls(urls, maxPosts || CONFIG.MAX_POSTS);
    
    res.json(result);
    
  } catch (error) {
    log(`Error en endpoint: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Scrape y guardar en Airtable
app.post('/api/scrape-and-save', authenticate, async (req, res) => {
  try {
    let { urls, maxPosts, group } = req.body;
    
    if (!urls) {
      return res.status(400).json({ error: 'urls es requerido' });
    }
    
    // Manejar formato [{Profile URL: [...]}]
    if (Array.isArray(urls) && urls.length > 0 && urls[0]['Profile URL']) {
      urls = urls[0]['Profile URL'];
    }
    
    if (!Array.isArray(urls)) {
      urls = [urls];
    }
    
    log(`📥 Scraping y guardado para ${urls.length} URLs`);
    
    const scrapeResult = await scrapeMultipleUrls(urls, maxPosts || CONFIG.MAX_POSTS);
    
    if (!scrapeResult.success) {
      return res.status(500).json(scrapeResult);
    }
    
    const saveResult = await saveResultsToAirtable(scrapeResult.results, group);
    
    res.json({
      ...scrapeResult,
      airtable: saveResult
    });
    
  } catch (error) {
    log(`Error: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// INICIAR SERVIDOR
// ========================================

app.listen(CONFIG.PORT, () => {
  log(`🚀 Servidor escuchando en puerto ${CONFIG.PORT}`);
  log('📋 Tipos de URL soportados:');
  log('  - Perfiles: linkedin.com/in/usuario/');
  log('  - Empresas: linkedin.com/company/nombre/posts/');
  log('');
  log('⚡ Optimización: Una sola sesión para múltiples URLs');
  log('');
  log('🔗 Endpoints disponibles:');
  log('  GET  /health');
  log('  POST /api/scrape');
  log('  POST /api/scrape-and-save');
  log('');
  log(`🔐 API Secret: Bearer ${CONFIG.API_SECRET}`);
});
