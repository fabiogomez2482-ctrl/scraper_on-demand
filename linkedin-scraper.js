// linkedin-scraper.js
const puppeteer = require('puppeteer');
const Airtable = require('airtable');
const cron = require('node-cron');

// ========================================
// CONFIGURACIÓN
// ========================================
const CONFIG = {
  // Airtable
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  
  // LinkedIn Credentials
  LINKEDIN_EMAIL: process.env.LINKEDIN_EMAIL,
  LINKEDIN_PASSWORD: process.env.LINKEDIN_PASSWORD,
  
  // Scraping Config
  MAX_POSTS_PER_PROFILE: 10,
  DELAY_BETWEEN_PROFILES: 60000,
  DELAY_BETWEEN_ACTIONS: 2000,
  PAGE_TIMEOUT: 90000, // 90 segundos
  MAX_RETRIES: 3,
  
  // Cron Schedule (cada 6 horas)
  CRON_SCHEDULE: '0 */6 * * *',
};

// ========================================
// INICIALIZAR AIRTABLE
// ========================================
const base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(CONFIG.AIRTABLE_BASE_ID);

// ========================================
// UTILIDADES
// ========================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const log = (message, type = 'info') => {
  const timestamp = new Date().toISOString();
  const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️';
  console.log(`${prefix} [${timestamp}] ${message}`);
};

// ========================================
// FUNCIONES DE AIRTABLE
// ========================================

async function getActiveProfiles() {
  try {
    const records = await base('Sources')
      .select({
        filterByFormula: '{Status} = "Active"',
        fields: ['Name', 'Profile URL', 'Group', 'Priority']
      })
      .all();
    
    return records.map(record => ({
      id: record.id,
      name: record.get('Name'),
      profileUrl: record.get('Profile URL'),
      group: record.get('Group'),
      priority: record.get('Priority')
    }));
  } catch (error) {
    log(`Error obteniendo perfiles: ${error.message}`, 'error');
    return [];
  }
}

async function postExists(postUrl) {
  try {
    const records = await base('LinkedIn Posts')
      .select({
        filterByFormula: `{Post URL} = "${postUrl}"`,
        maxRecords: 1
      })
      .all();
    
    return records.length > 0;
  } catch (error) {
    log(`Error verificando post: ${error.message}`, 'error');
    return false;
  }
}

async function savePost(postData) {
  try {
    await base('LinkedIn Posts').create([
      {
        fields: {
          'Author Name': postData.authorName,
          'Author Profile URL': postData.authorProfileUrl,
          'Group': postData.group,
          'Post Content': postData.content,
          'Post Date': postData.date,
          'Post URL': postData.postUrl,
          'Likes': postData.likes || 0,
          'Comments': postData.comments || 0,
          'Shares': postData.shares || 0,
          'Has Media': postData.hasMedia || false,
          'Media URL': postData.mediaUrl || '',
          'Status': 'New'
        }
      }
    ]);
    log(`Post guardado: ${postData.authorName}`, 'success');
    return true;
  } catch (error) {
    log(`Error guardando post: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// FUNCIONES DE NAVEGACIÓN ROBUSTAS
// ========================================

async function safeGoto(page, url, options = {}) {
  const defaultOptions = {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.PAGE_TIMEOUT
  };
  
  const mergedOptions = { ...defaultOptions, ...options };
  
  for (let i = 0; i < CONFIG.MAX_RETRIES; i++) {
    try {
      log(`Navegando a: ${url} (intento ${i + 1}/${CONFIG.MAX_RETRIES})`);
      
      const response = await page.goto(url, mergedOptions);
      
      if (response && response.ok()) {
        log(`✓ Página cargada exitosamente`);
        return true;
      }
      
      log(`Respuesta no OK: ${response ? response.status() : 'null'}`, 'warning');
      
    } catch (error) {
      log(`Error en intento ${i + 1}: ${error.message}`, 'warning');
      
      if (i < CONFIG.MAX_RETRIES - 1) {
        const waitTime = (i + 1) * 5000;
        log(`Esperando ${waitTime/1000}s antes de reintentar...`);
        await delay(waitTime);
      }
    }
  }
  
  return false;
}

async function loadCookies(page) {
  try {
    if (!process.env.LINKEDIN_COOKIES) {
      log('No hay cookies configuradas');
      return false;
    }
    
    const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    
    if (!Array.isArray(cookies) || cookies.length === 0) {
      log('Formato de cookies inválido', 'error');
      return false;
    }
    
    log(`Cargando ${cookies.length} cookies...`);
    
    // Ir a LinkedIn primero
    const loaded = await safeGoto(page, 'https://www.linkedin.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    if (!loaded) {
      log('No se pudo cargar LinkedIn para establecer cookies', 'error');
      return false;
    }
    
    await delay(2000);
    
    // Limpiar cookies existentes
    const existingCookies = await page.cookies();
    if (existingCookies.length > 0) {
      await page.deleteCookie(...existingCookies);
    }
    
    // Establecer nuevas cookies
    await page.setCookie(...cookies);
    
    log('Cookies establecidas exitosamente', 'success');
    return true;
    
  } catch (error) {
    log(`Error cargando cookies: ${error.message}`, 'error');
    return false;
  }
}

async function checkIfLoggedIn(page) {
  try {
    // Múltiples formas de verificar si estamos logueados
    const checks = await page.evaluate(() => {
      return {
        hasGlobalNav: document.querySelector('nav.global-nav') !== null,
        hasProfileIcon: document.querySelector('[data-control-name="nav.settings"]') !== null,
        hasFeedContent: document.querySelector('.feed-shared-update-v2') !== null,
        hasSearchBar: document.querySelector('input[placeholder*="Search"]') !== null,
        hasMessaging: document.querySelector('[data-control-name="nav.messaging"]') !== null,
        url: window.location.href,
        bodyText: document.body.innerText.substring(0, 200)
      };
    });
    
    log(`Verificación de login: ${JSON.stringify(checks)}`);
    
    // Si tenemos al menos 2 de estos elementos, estamos logueados
    const positiveChecks = [
      checks.hasGlobalNav,
      checks.hasProfileIcon,
      checks.hasFeedContent,
      checks.hasSearchBar,
      checks.hasMessaging
    ].filter(Boolean).length;
    
    const urlCheck = checks.url.includes('/feed') || 
                    checks.url.includes('/mynetwork') ||
                    checks.url.includes('/in/');
    
    const isLoggedIn = positiveChecks >= 2 || (positiveChecks >= 1 && urlCheck);
    
    log(`Checks positivos: ${positiveChecks}/5, URL válida: ${urlCheck}`);
    
    return isLoggedIn;
    
  } catch (error) {
    log(`Error verificando login: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// FUNCIONES DE LOGIN
// ========================================

async function loginWithCookies(page) {
  try {
    log('🍪 Intentando login con cookies...');
    
    const cookiesLoaded = await loadCookies(page);
    if (!cookiesLoaded) {
      return false;
    }
    
    // Navegar al feed
    const navigated = await safeGoto(page, 'https://www.linkedin.com/feed/');
    if (!navigated) {
      log('No se pudo navegar al feed', 'warning');
      return false;
    }
    
    await delay(5000); // Esperar a que cargue
    
    // Verificar si estamos logueados
    const isLoggedIn = await checkIfLoggedIn(page);
    
    if (isLoggedIn) {
      log('✅ Login con cookies exitoso!', 'success');
      return true;
    }
    
    log('Cookies no válidas o expiradas', 'warning');
    return false;
    
  } catch (error) {
    log(`Error en login con cookies: ${error.message}`, 'error');
    return false;
  }
}

async function loginWithCredentials(page) {
  try {
    log('🔑 Intentando login con credenciales...');
    
    // Ir a página de login
    const navigated = await safeGoto(page, 'https://www.linkedin.com/login');
    if (!navigated) {
      throw new Error('No se pudo cargar la página de login');
    }
    
    await delay(3000);
    
    // Verificar si ya estamos logueados
    const alreadyLoggedIn = await checkIfLoggedIn(page);
    if (alreadyLoggedIn) {
      log('Ya estábamos logueados!', 'success');
      return true;
    }
    
    // Buscar formulario de login
    const hasLoginForm = await page.evaluate(() => {
      return document.querySelector('#username') !== null;
    });
    
    if (!hasLoginForm) {
      log('No se encontró el formulario de login', 'warning');
      return false;
    }
    
    log('Formulario encontrado, ingresando credenciales...');
    
    // Ingresar email
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.click('#username', { clickCount: 3 }); // Seleccionar todo
    await delay(500);
    await page.type('#username', CONFIG.LINKEDIN_EMAIL, { delay: 100 });
    
    await delay(1500);
    
    // Ingresar password
    await page.click('#password', { clickCount: 3 });
    await delay(500);
    await page.type('#password', CONFIG.LINKEDIN_PASSWORD, { delay: 100 });
    
    await delay(2000);
    
    log('Enviando formulario...');
    
    // Click en submit
    await page.click('button[type="submit"]');
    
    // Esperar navegación o cambio de URL
    await Promise.race([
      page.waitForNavigation({ 
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.PAGE_TIMEOUT 
      }).catch(() => null),
      delay(10000)
    ]);
    
    await delay(5000);
    
    const currentUrl = page.url();
    log(`URL después de submit: ${currentUrl}`);
    
    // Verificar resultado
    if (currentUrl.includes('/checkpoint/challenge')) {
      log('❌ LinkedIn requiere verificación (2FA/Captcha)', 'error');
      log('Recomendación: Desactiva 2FA o usa cookies de una sesión verificada', 'warning');
      return false;
    }
    
    if (currentUrl.includes('/login')) {
      log('❌ Login falló - verifica credenciales', 'error');
      return false;
    }
    
    // Verificar si estamos logueados
    const isLoggedIn = await checkIfLoggedIn(page);
    
    if (isLoggedIn) {
      log('✅ Login con credenciales exitoso!', 'success');
      
      // Guardar cookies para futura referencia
      const cookies = await page.cookies();
      log('\n💾 NUEVAS COOKIES (Guárdalas en LINKEDIN_COOKIES):');
      console.log(JSON.stringify(cookies, null, 2));
      
      return true;
    }
    
    log('Estado de login incierto', 'warning');
    return false;
    
  } catch (error) {
    log(`Error en login con credenciales: ${error.message}`, 'error');
    return false;
  }
}

async function loginToLinkedIn(page) {
  try {
    log('🚀 Iniciando proceso de login...');
    
    // Estrategia 1: Cookies
    if (process.env.LINKEDIN_COOKIES) {
      const cookieSuccess = await loginWithCookies(page);
      if (cookieSuccess) {
        return true;
      }
    }
    
    // Estrategia 2: Credenciales
    if (CONFIG.LINKEDIN_EMAIL && CONFIG.LINKEDIN_PASSWORD) {
      const credentialSuccess = await loginWithCredentials(page);
      if (credentialSuccess) {
        return true;
      }
    }
    
    log('❌ Todas las estrategias de login fallaron', 'error');
    return false;
    
  } catch (error) {
    log(`❌ Error crítico en login: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// FUNCIONES DE SCRAPING
// ========================================

async function scrapeProfilePosts(page, profileUrl, authorName, group) {
  try {
    log(`📊 Extrayendo posts de: ${authorName}`);
    
    const activityUrl = `${profileUrl}/recent-activity/all/`;
    
    const navigated = await safeGoto(page, activityUrl);
    if (!navigated) {
      log(`No se pudo cargar el perfil de ${authorName}`, 'error');
      return 0;
    }
    
    await delay(CONFIG.DELAY_BETWEEN_ACTIONS);
    
    // Esperar contenido
    try {
      await page.waitForSelector('div.feed-shared-update-v2, li.profile-creator-shared-feed-update__container, div[data-urn]', {
        timeout: 15000
      });
      log('Contenido detectado');
    } catch (e) {
      log('Timeout esperando posts, intentando extraer de todas formas...', 'warning');
    }
    
    // Scroll
    log('Scrolleando...');
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await delay(2000);
    }
    
    await delay(2000);
    
    // Extraer posts
    const posts = await page.evaluate((maxPosts) => {
      const results = [];
      
      const selectors = [
        'div.feed-shared-update-v2',
        'li.profile-creator-shared-feed-update__container',
        'div[data-urn]',
        'article',
        '.occludable-update',
        '[data-id^="urn:li:activity"]'
      ];
      
      let postElements = [];
      for (const selector of selectors) {
        postElements = document.querySelectorAll(selector);
        if (postElements.length > 0) {
          console.log(`✓ ${postElements.length} posts con: ${selector}`);
          break;
        }
      }
      
      if (postElements.length === 0) {
        console.log('⚠️ No se encontraron posts');
        return [];
      }
      
      for (let i = 0; i < Math.min(postElements.length, maxPosts); i++) {
        const post = postElements[i];
        
        try {
          const contentSelectors = [
            '.feed-shared-update-v2__description',
            '.update-components-text',
            '.feed-shared-inline-show-more-text',
            '.break-words',
            'span[dir="ltr"]',
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
          
          const timeElement = post.querySelector('time') || post.querySelector('[datetime]');
          const date = timeElement ? (timeElement.getAttribute('datetime') || timeElement.innerText) : new Date().toISOString();
          
          let postUrl = '';
          const linkElement = post.querySelector('a[href*="/posts/"]') || 
                             post.querySelector('a[href*="activity"]') ||
                             post.querySelector('a[data-control-name="update"]');
          
          if (linkElement) {
            postUrl = linkElement.href;
          } else {
            const urn = post.getAttribute('data-urn') || post.getAttribute('data-id');
            if (urn) {
              postUrl = `https://www.linkedin.com/feed/update/${urn}`;
            }
          }
          
          if (!postUrl) continue;
          
          let likes = 0;
          let comments = 0;
          
          const socialCounts = post.querySelector('.social-details-social-counts');
          if (socialCounts) {
            const likesText = socialCounts.innerText;
            const likesMatch = likesText.match(/(\d+[\d,\.]*)/);
            if (likesMatch) {
              likes = parseInt(likesMatch[1].replace(/[,\.]/g, ''));
            }
          }
          
          const commentButton = post.querySelector('[aria-label*="comment"]');
          if (commentButton) {
            const commentText = commentButton.innerText;
            const commentMatch = commentText.match(/(\d+)/);
            if (commentMatch) {
              comments = parseInt(commentMatch[1]);
            }
          }
          
          const imageElement = post.querySelector('img[src*="media"]') ||
                              post.querySelector('.update-components-image img');
          const videoElement = post.querySelector('video');
          const hasMedia = !!(imageElement || videoElement);
          const mediaUrl = imageElement ? imageElement.src : (videoElement ? videoElement.poster : '');
          
          results.push({
            content,
            date,
            postUrl,
            likes,
            comments,
            shares: 0,
            hasMedia,
            mediaUrl
          });
          
        } catch (err) {
          console.error('Error extrayendo post:', err.message);
        }
      }
      
      return results;
    }, CONFIG.MAX_POSTS_PER_PROFILE);
    
    log(`Encontrados ${posts.length} posts`);
    
    let newPostsCount = 0;
    for (const post of posts) {
      const exists = await postExists(post.postUrl);
      
      if (!exists) {
        const postData = {
          authorName,
          authorProfileUrl: profileUrl,
          group,
          content: post.content,
          date: post.date,
          postUrl: post.postUrl,
          likes: post.likes,
          comments: post.comments,
          shares: post.shares,
          hasMedia: post.hasMedia,
          mediaUrl: post.mediaUrl
        };
        
        const saved = await savePost(postData);
        if (saved) newPostsCount++;
        
        await delay(500);
      }
    }
    
    log(`✅ ${newPostsCount} posts nuevos guardados`, 'success');
    return newPostsCount;
    
  } catch (error) {
    log(`Error en scraping de ${authorName}: ${error.message}`, 'error');
    return 0;
  }
}

// ========================================
// FUNCIÓN PRINCIPAL
// ========================================
async function runScraper() {
  log('🚀 Iniciando scraper de LinkedIn...');
  
  let browser;
  
  try {
    const profiles = await getActiveProfiles();
    
    if (profiles.length === 0) {
      log('No hay perfiles activos para monitorear', 'warning');
      return;
    }
    
    log(`📋 Perfiles a monitorear: ${profiles.length}`);
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security'
      ]
    });
    
    const page = await browser.newPage();
    
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });
    
    // Configurar timeouts más largos para requests
    await page.setDefaultNavigationTimeout(CONFIG.PAGE_TIMEOUT);
    await page.setDefaultTimeout(CONFIG.PAGE_TIMEOUT);
    
    const loginSuccess = await loginToLinkedIn(page);
    
    if (!loginSuccess) {
      throw new Error('No se pudo iniciar sesión en LinkedIn');
    }
    
    let totalNewPosts = 0;
    
    for (const profile of profiles) {
      try {
        const newPosts = await scrapeProfilePosts(
          page,
          profile.profileUrl,
          profile.name,
          profile.group
        );
        
        totalNewPosts += newPosts;
        
        if (profiles.indexOf(profile) < profiles.length - 1) {
          log(`⏳ Esperando ${CONFIG.DELAY_BETWEEN_PROFILES / 1000}s...`);
          await delay(CONFIG.DELAY_BETWEEN_PROFILES);
        }
        
      } catch (error) {
        log(`Error en perfil ${profile.name}: ${error.message}`, 'error');
        continue;
      }
    }
    
    log(`✅ Scraping completado. Total: ${totalNewPosts} posts nuevos`, 'success');
    
  } catch (error) {
    log(`❌ Error crítico: ${error.message}`, 'error');
    console.error(error.stack);
  } finally {
    if (browser) {
      await browser.close();
      log('🔒 Navegador cerrado');
    }
  }
}

// ========================================
// EJECUCIÓN
// ========================================

log('📱 Aplicación iniciada');

runScraper().catch(err => {
  log(`Error fatal: ${err.message}`, 'error');
  process.exit(1);
});

cron.schedule(CONFIG.CRON_SCHEDULE, () => {
  log('⏰ Ejecutando tarea programada...');
  runScraper().catch(err => {
    log(`Error en tarea programada: ${err.message}`, 'error');
  });
});

log(`⏱️ Cron programado: ${CONFIG.CRON_SCHEDULE}`);
