// server.js - API para scraper on-demand
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

// Función principal de scraping
async function scrapeProfile(profileUrl, maxPosts = CONFIG.MAX_POSTS) {
  let browser;
  
  try {
    log(`Iniciando scraping de: ${profileUrl}`);
    
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
    
    // Login
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
    
    log('Login exitoso');
    
    // Navegar al perfil
    const activityUrl = `${profileUrl}/recent-activity/all/`;
    await page.goto(activityUrl, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.PAGE_TIMEOUT
    });
    
    await delay(5000);
    
    // Scroll para cargar posts
    log('Cargando posts...');
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await delay(2500);
    }
    
    await delay(3000);
    
    // Extraer posts
    const posts = await page.evaluate((maxPosts) => {
      const results = [];
      
      const selectors = [
        'div.feed-shared-update-v2',
        'li.profile-creator-shared-feed-update__container',
        'div[data-urn*="activity"]',
        'article.feed-shared-update-v2'
      ];
      
      let postElements = [];
      for (const selector of selectors) {
        postElements = document.querySelectorAll(selector);
        if (postElements.length > 0) break;
      }
      
      for (let i = 0; i < Math.min(postElements.length, maxPosts); i++) {
        const post = postElements[i];
        
        try {
          const contentSelectors = [
            '.feed-shared-update-v2__description',
            '.update-components-text',
            '.break-words',
            '.feed-shared-text'
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
          
          const timeEl = post.querySelector('time');
          const date = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();
          
          const linkEl = post.querySelector('a[href*="/posts/"]');
          let postUrl = linkEl ? linkEl.href : '';
          
          if (!postUrl) {
            const urn = post.getAttribute('data-urn');
            if (urn) postUrl = `https://www.linkedin.com/feed/update/${urn}`;
          }
          
          if (!postUrl) continue;
          
          let likes = 0;
          const socialCounts = post.querySelector('.social-details-social-counts');
          if (socialCounts) {
            const match = socialCounts.innerText.match(/(\d+[\d,\.]*)/);
            if (match) likes = parseInt(match[1].replace(/[,\.]/g, ''));
          }
          
          results.push({
            content: content.substring(0, 1000),
            date,
            postUrl,
            likes,
            comments: 0,
            hasMedia: post.querySelector('img[src*="media"]') !== null
          });
          
        } catch (err) {
          console.error('Error extrayendo post:', err);
        }
      }
      
      return results;
    }, maxPosts);
    
    log(`Encontrados ${posts.length} posts`);
    
    return {
      success: true,
      profileUrl,
      postsFound: posts.length,
      posts
    };
    
  } catch (error) {
    log(`Error en scraping: ${error.message}`, 'error');
    return {
      success: false,
      error: error.message
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Guardar en Airtable (opcional)
async function saveToAirtable(profileUrl, posts, group = 'On-Demand') {
  const saved = [];
  
  for (const post of posts) {
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
            'Author Profile URL': profileUrl,
            'Group': group,
            'Post Content': post.content,
            'Post Date': post.date,
            'Post URL': post.postUrl,
            'Likes': post.likes || 0,
            'Comments': post.comments || 0,
            'Has Media': post.hasMedia || false
          }
        }]);
        
        saved.push(post.postUrl);
      }
      
      await delay(500);
    } catch (error) {
      log(`Error guardando post: ${error.message}`, 'error');
    }
  }
  
  return saved;
}

// ========================================
// ENDPOINTS DE LA API
// ========================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Scrape on-demand (sin guardar en Airtable)
app.post('/api/scrape', authenticate, async (req, res) => {
  try {
    const { profileUrl, maxPosts } = req.body;
    
    if (!profileUrl) {
      return res.status(400).json({ error: 'profileUrl es requerido' });
    }
    
    // Validar URL de LinkedIn
    if (!profileUrl.includes('linkedin.com/in/')) {
      return res.status(400).json({ error: 'URL inválida de LinkedIn' });
    }
    
    log(`Nueva solicitud de scraping: ${profileUrl}`);
    
    const result = await scrapeProfile(profileUrl, maxPosts || CONFIG.MAX_POSTS);
    
    res.json(result);
    
  } catch (error) {
    log(`Error en endpoint: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Scrape y guardar en Airtable
app.post('/api/scrape-and-save', authenticate, async (req, res) => {
  try {
    const { profileUrl, maxPosts, group } = req.body;
    
    if (!profileUrl) {
      return res.status(400).json({ error: 'profileUrl es requerido' });
    }
    
    log(`Scraping y guardado: ${profileUrl}`);
    
    const scrapeResult = await scrapeProfile(profileUrl, maxPosts || CONFIG.MAX_POSTS);
    
    if (!scrapeResult.success) {
      return res.status(500).json(scrapeResult);
    }
    
    const savedUrls = await saveToAirtable(profileUrl, scrapeResult.posts, group);
    
    res.json({
      ...scrapeResult,
      savedToAirtable: savedUrls.length,
      savedUrls
    });
    
  } catch (error) {
    log(`Error: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// Scrape múltiples perfiles
app.post('/api/scrape-batch', authenticate, async (req, res) => {
  try {
    const { profiles } = req.body;
    
    if (!Array.isArray(profiles) || profiles.length === 0) {
      return res.status(400).json({ error: 'profiles debe ser un array no vacío' });
    }
    
    log(`Scraping batch de ${profiles.length} perfiles`);
    
    const results = [];
    
    for (const profile of profiles) {
      const result = await scrapeProfile(profile.url, profile.maxPosts);
      results.push({
        profileUrl: profile.url,
        ...result
      });
      
      // Delay entre perfiles
      await delay(30000);
    }
    
    res.json({
      success: true,
      totalProfiles: profiles.length,
      results
    });
    
  } catch (error) {
    log(`Error en batch: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// INICIAR SERVIDOR
// ========================================

app.listen(CONFIG.PORT, () => {
  log(`Servidor escuchando en puerto ${CONFIG.PORT}`);
  log('Endpoints disponibles:');
  log('  GET  /health');
  log('  POST /api/scrape');
  log('  POST /api/scrape-and-save');
  log('  POST /api/scrape-batch');
  log(`API Secret requerido: Bearer ${CONFIG.API_SECRET}`);
});
