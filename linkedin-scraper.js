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
  DELAY_BETWEEN_PROFILES: 60000, // 60 segundos
  DELAY_BETWEEN_ACTIONS: 2000, // 2 segundos
  PAGE_TIMEOUT: 60000, // Aumentado a 60 segundos
  
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
  const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
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
    log(`Post guardado: ${postData.authorName} - ${postData.postUrl}`, 'success');
    return true;
  } catch (error) {
    log(`Error guardando post: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// FUNCIONES DE SCRAPING
// ========================================

async function loginToLinkedIn(page) {
  try {
    log('Iniciando sesión en LinkedIn...');
    
    // Intentar con cookies primero
    const cookiesLoaded = await loadCookies(page);
    
    if (cookiesLoaded) {
      log('Intentando login con cookies...');
      
      try {
        // Ir al feed con timeout más largo y estrategia diferente
        await page.goto('https://www.linkedin.com/feed/', {
          waitUntil: 'domcontentloaded', // Cambiado de networkidle2
          timeout: CONFIG.PAGE_TIMEOUT
        });
        
        await delay(5000); // Esperar más tiempo
        
        const currentUrl = page.url();
        log(`URL actual: ${currentUrl}`);
        
        // Verificar si estamos logueados
        const isLoggedIn = await page.evaluate(() => {
          // Buscar elementos que solo aparecen cuando estás logueado
          return document.querySelector('nav.global-nav') !== null ||
                 document.querySelector('[data-control-name="nav.settings"]') !== null ||
                 document.querySelector('.feed-shared-update-v2') !== null;
        });
        
        if (isLoggedIn && (currentUrl.includes('/feed') || currentUrl.includes('/mynetwork'))) {
          log('Login con cookies exitoso', 'success');
          return true;
        } else {
          log('Cookies no válidas o sesión expirada, intentando login tradicional...');
        }
      } catch (error) {
        log(`Error con cookies: ${error.message}. Intentando login tradicional...`);
      }
    }
    
    // Si las cookies no funcionaron, login tradicional
    log('Intentando login tradicional...');
    
    await page.goto('https://www.linkedin.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.PAGE_TIMEOUT
    });
    
    await delay(3000);
    
    // Verificar que estamos en la página de login
    const isLoginPage = await page.evaluate(() => {
      return document.querySelector('#username') !== null;
    });
    
    if (!isLoginPage) {
      log('No se encontró el formulario de login - posiblemente ya estamos logueados');
      const currentUrl = page.url();
      if (currentUrl.includes('/feed') || currentUrl.includes('/mynetwork')) {
        return true;
      }
      return false;
    }
    
    log('Formulario de login encontrado, ingresando credenciales...');
    
    // Ingresar credenciales con mayor delay
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.click('#username');
    await delay(1000);
    await page.type('#username', CONFIG.LINKEDIN_EMAIL, { delay: 100 });
    
    await delay(1500);
    
    await page.click('#password');
    await delay(1000);
    await page.type('#password', CONFIG.LINKEDIN_PASSWORD, { delay: 100 });
    
    await delay(2000);
    
    log('Credenciales ingresadas, enviando formulario...');
    
    // Click en submit y esperar navegación
    await Promise.all([
      page.waitForNavigation({ 
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.PAGE_TIMEOUT 
      }).catch(err => log(`Advertencia en navegación: ${err.message}`)),
      page.click('button[type="submit"]')
    ]);
    
    await delay(5000);
    
    const finalUrl = page.url();
    log(`URL después de login: ${finalUrl}`);
    
    // Verificar diferentes escenarios
    if (finalUrl.includes('/feed') || finalUrl.includes('/mynetwork')) {
      log('Login exitoso', 'success');
      
      // Guardar cookies para futuros usos
      await saveCookies(page);
      
      return true;
    } else if (finalUrl.includes('/checkpoint/challenge')) {
      log('LinkedIn requiere verificación de seguridad (captcha/2FA)', 'error');
      log('Por favor, inicia sesión manualmente en LinkedIn y exporta las cookies', 'error');
      return false;
    } else if (finalUrl.includes('/login')) {
      log('Login falló - posiblemente credenciales incorrectas', 'error');
      return false;
    } else {
      log(`Login incierto - URL inesperada: ${finalUrl}`, 'error');
      
      // Intentar verificar si estamos logueados de todas formas
      const isLoggedIn = await page.evaluate(() => {
        return document.querySelector('nav.global-nav') !== null;
      });
      
      return isLoggedIn;
    }
    
  } catch (error) {
    log(`Error en login: ${error.message}`, 'error');
    return false;
  }
}

async function loadCookies(page) {
  try {
    if (!process.env.LINKEDIN_COOKIES) {
      log('No hay cookies configuradas');
      return false;
    }
    
    const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    
    // Validar que las cookies tengan el formato correcto
    if (!Array.isArray(cookies) || cookies.length === 0) {
      log('Formato de cookies inválido');
      return false;
    }
    
    // Ir a LinkedIn primero para establecer el dominio
    await page.goto('https://www.linkedin.com', {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.PAGE_TIMEOUT
    });
    
    await page.setCookie(...cookies);
    log('Cookies cargadas exitosamente');
    return true;
  } catch (error) {
    log(`Error cargando cookies: ${error.message}`, 'error');
    return false;
  }
}

async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    log('💾 Cookies guardadas (cópialas para LINKEDIN_COOKIES):');
    console.log(JSON.stringify(cookies, null, 2));
  } catch (error) {
    log(`Error guardando cookies: ${error.message}`, 'error');
  }
}

async function scrapeProfilePosts(page, profileUrl, authorName, group) {
  try {
    log(`Extrayendo posts de: ${authorName}`);
    
    // Ir directamente a la actividad reciente
    const activityUrl = `${profileUrl}/recent-activity/all/`;
    
    await page.goto(activityUrl, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.PAGE_TIMEOUT
    });
    
    await delay(CONFIG.DELAY_BETWEEN_ACTIONS);
    
    // Esperar a que se cargue contenido
    try {
      await page.waitForSelector('div.feed-shared-update-v2, li.profile-creator-shared-feed-update__container, div[data-urn]', {
        timeout: 15000
      });
    } catch (e) {
      log('Advertencia: No se detectaron selectores de posts estándar, intentando de todas formas...');
    }
    
    // Scroll para cargar posts
    log('Scrolleando para cargar posts...');
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await delay(2000);
    }
    
    await delay(2000); // Esperar final del scroll
    
    // Extraer posts
    const posts = await page.evaluate((maxPosts) => {
      const results = [];
      
      // Selectores múltiples para diferentes versiones de LinkedIn
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
          console.log(`✓ Encontrados ${postElements.length} posts con selector: ${selector}`);
          break;
        }
      }
      
      if (postElements.length === 0) {
        console.log('⚠️ No se encontraron posts con ningún selector');
        return [];
      }
      
      for (let i = 0; i < Math.min(postElements.length, maxPosts); i++) {
        const post = postElements[i];
        
        try {
          // Extraer contenido de texto
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
          
          // Si no hay contenido, saltar
          if (!content) {
            continue;
          }
          
          // Extraer fecha
          const timeElement = post.querySelector('time') || post.querySelector('[datetime]');
          const date = timeElement ? (timeElement.getAttribute('datetime') || timeElement.innerText) : new Date().toISOString();
          
          // Extraer URL del post
          let postUrl = '';
          const linkElement = post.querySelector('a[href*="/posts/"]') || 
                             post.querySelector('a[href*="activity"]') ||
                             post.querySelector('a[data-control-name="update"]');
          
          if (linkElement) {
            postUrl = linkElement.href;
          } else {
            // Generar URL desde data-urn
            const urn = post.getAttribute('data-urn') || post.getAttribute('data-id');
            if (urn) {
              postUrl = `https://www.linkedin.com/feed/update/${urn}`;
            }
          }
          
          // Si no hay URL válida, saltar
          if (!postUrl) {
            continue;
          }
          
          // Extraer métricas de engagement
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
          
          // Buscar comentarios
          const commentButton = post.querySelector('[aria-label*="comment"]');
          if (commentButton) {
            const commentText = commentButton.innerText;
            const commentMatch = commentText.match(/(\d+)/);
            if (commentMatch) {
              comments = parseInt(commentMatch[1]);
            }
          }
          
          // Detectar media
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
          console.error('Error extrayendo post individual:', err.message);
        }
      }
      
      return results;
    }, CONFIG.MAX_POSTS_PER_PROFILE);
    
    log(`Encontrados ${posts.length} posts de ${authorName}`);
    
    // Guardar posts en Airtable
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
        
        await delay(500); // Delay entre guardados
      }
    }
    
    log(`Guardados ${newPostsCount} posts nuevos de ${authorName}`, 'success');
    return newPostsCount;
    
  } catch (error) {
    log(`Error scraping perfil ${authorName}: ${error.message}`, 'error');
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
    // Obtener perfiles activos
    const profiles = await getActiveProfiles();
    
    if (profiles.length === 0) {
      log('No hay perfiles activos para monitorear');
      return;
    }
    
    log(`Perfiles a monitorear: ${profiles.length}`);
    
    // Iniciar navegador
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    
    const page = await browser.newPage();
    
    // Configurar viewport y user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Ocultar webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });
    
    // Login a LinkedIn
    const loginSuccess = await loginToLinkedIn(page);
    
    if (!loginSuccess) {
      throw new Error('No se pudo iniciar sesión en LinkedIn');
    }
    
    // Scraping de cada perfil
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
        
        // Delay entre perfiles para evitar rate limiting
        if (profiles.indexOf(profile) < profiles.length - 1) {
          log(`Esperando ${CONFIG.DELAY_BETWEEN_PROFILES / 1000}s antes del siguiente perfil...`);
          await delay(CONFIG.DELAY_BETWEEN_PROFILES);
        }
        
      } catch (error) {
        log(`Error procesando perfil ${profile.name}: ${error.message}`, 'error');
        continue;
      }
    }
    
    log(`✅ Scraping completado. Total posts nuevos: ${totalNewPosts}`, 'success');
    
  } catch (error) {
    log(`❌ Error general: ${error.message}`, 'error');
    console.error(error.stack);
  } finally {
    if (browser) {
      await browser.close();
      log('Navegador cerrado');
    }
  }
}

// ========================================
// EJECUCIÓN
// ========================================

// Ejecutar inmediatamente al iniciar
log('📱 Aplicación iniciada');

// Ejecutar con manejo de errores
runScraper().catch(err => {
  log(`Error fatal: ${err.message}`, 'error');
  process.exit(1);
});

// Programar ejecución con cron
cron.schedule(CONFIG.CRON_SCHEDULE, () => {
  log('⏰ Ejecutando tarea programada...');
  runScraper().catch(err => {
    log(`Error en tarea programada: ${err.message}`, 'error');
  });
});

log(`⏱️ Cron programado: ${CONFIG.CRON_SCHEDULE} (cada 6 horas)`);
