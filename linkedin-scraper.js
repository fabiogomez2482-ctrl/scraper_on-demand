// linkedin-scraper-hybrid.js
// Solución semi-automática con recordatorios para renovar cookies

const puppeteer = require('puppeteer');
const Airtable = require('airtable');
const cron = require('node-cron');

const CONFIG = {
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  LINKEDIN_EMAIL: process.env.LINKEDIN_EMAIL,
  LINKEDIN_PASSWORD: process.env.LINKEDIN_PASSWORD,
  
  MAX_POSTS_PER_PROFILE: 10,
  DELAY_BETWEEN_PROFILES: 60000,
  DELAY_BETWEEN_ACTIONS: 2000,
  PAGE_TIMEOUT: 90000,
  MAX_RETRIES: 3,
  
  // Días antes de avisar que cookies expirarán
  COOKIE_WARNING_DAYS: 5,
  
  // Email para notificaciones (opcional)
  NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL,
  
  CRON_SCHEDULE: '0 */6 * * *',
};

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
// GESTIÓN DE COOKIES Y ESTADO
// ========================================

async function checkCookieExpiration() {
  try {
    if (!process.env.LINKEDIN_COOKIES) {
      log('⚠️ No hay cookies configuradas', 'warning');
      return { expired: true, daysLeft: 0 };
    }
    
    const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    const liAtCookie = cookies.find(c => c.name === 'li_at');
    
    if (!liAtCookie || !liAtCookie.expires) {
      log('Cookie li_at no encontrada o sin fecha de expiración', 'warning');
      return { expired: false, daysLeft: 30 }; // Asumir 30 días por defecto
    }
    
    const expiryDate = new Date(liAtCookie.expires * 1000);
    const now = new Date();
    const daysLeft = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));
    
    log(`📅 Cookies expiran en ${daysLeft} días (${expiryDate.toLocaleDateString()})`);
    
    if (daysLeft <= 0) {
      return { expired: true, daysLeft: 0 };
    }
    
    if (daysLeft <= CONFIG.COOKIE_WARNING_DAYS) {
      log(`⚠️ ADVERTENCIA: Las cookies expirarán pronto (${daysLeft} días)`, 'warning');
      await sendCookieWarning(daysLeft);
    }
    
    return { expired: false, daysLeft };
    
  } catch (error) {
    log(`Error verificando cookies: ${error.message}`, 'error');
    return { expired: false, daysLeft: null };
  }
}

async function sendCookieWarning(daysLeft) {
  try {
    // Guardar en Airtable como recordatorio (solo si la tabla existe)
    try {
      await base('System Logs').create([{
        fields: {
          'Type': 'Cookie Warning',
          'Message': `Las cookies de LinkedIn expirarán en ${daysLeft} días. Renovarlas pronto.`,
          'Date': new Date().toISOString(),
          'Priority': daysLeft <= 2 ? 'High' : 'Medium'
        }
      }]);
      log('📧 Notificación de expiración guardada en Airtable', 'success');
    } catch (e) {
      // Si la tabla no existe, solo loggear
      log(`⚠️ Las cookies expiran en ${daysLeft} días. Tabla System Logs no configurada.`, 'warning');
    }
    
    // TODO: Aquí podrías integrar un webhook a Slack, Discord, email, etc.
    // Por ejemplo:
    // await fetch(process.env.SLACK_WEBHOOK_URL, {
    //   method: 'POST',
    //   body: JSON.stringify({
    //     text: `🔔 LinkedIn cookies expiran en ${daysLeft} días!`
    //   })
    // });
    
  } catch (error) {
    log(`Error enviando notificación: ${error.message}`, 'warning');
  }
}

async function logScraperRun(success, postsScraped, error = null) {
  try {
    // Solo si la tabla existe
    try {
      await base('Scraper Runs').create([{
        fields: {
          'Date': new Date().toISOString(),
          'Success': success,
          'Posts Scraped': postsScraped,
          'Error': error || '',
          'Status': success ? 'Completed' : 'Failed'
        }
      }]);
    } catch (e) {
      // Tabla opcional, no es crítico
      log(`Tabla Scraper Runs no configurada (opcional)`, 'warning');
    }
  } catch (err) {
    // Silencioso, no es crítico
  }
}

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
    await base('LinkedIn Posts').create([{
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
    }]);
    return true;
  } catch (error) {
    log(`Error guardando post: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// NAVEGACIÓN ROBUSTA
// ========================================

async function safeGoto(page, url, options = {}) {
  const defaultOptions = {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.PAGE_TIMEOUT
  };
  
  const mergedOptions = { ...defaultOptions, ...options };
  
  for (let i = 0; i < CONFIG.MAX_RETRIES; i++) {
    try {
      const response = await page.goto(url, mergedOptions);
      if (response && response.ok()) {
        return true;
      }
    } catch (error) {
      if (i < CONFIG.MAX_RETRIES - 1) {
        await delay((i + 1) * 5000);
      }
    }
  }
  
  return false;
}

async function loadCookies(page) {
  try {
    if (!process.env.LINKEDIN_COOKIES) {
      return false;
    }
    
    const cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return false;
    }
    
    const loaded = await safeGoto(page, 'https://www.linkedin.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    if (!loaded) return false;
    
    await delay(2000);
    
    const existingCookies = await page.cookies();
    if (existingCookies.length > 0) {
      await page.deleteCookie(...existingCookies);
    }
    
    await page.setCookie(...cookies);
    
    return true;
    
  } catch (error) {
    log(`Error cargando cookies: ${error.message}`, 'error');
    return false;
  }
}

async function checkIfLoggedIn(page) {
  try {
    const checks = await page.evaluate(() => {
      return {
        hasGlobalNav: document.querySelector('nav.global-nav') !== null,
        hasProfileIcon: document.querySelector('[data-control-name="nav.settings"]') !== null,
        hasFeedContent: document.querySelector('.feed-shared-update-v2') !== null,
        hasSearchBar: document.querySelector('input[placeholder*="Search"]') !== null,
        hasMessaging: document.querySelector('[data-control-name="nav.messaging"]') !== null,
        url: window.location.href
      };
    });
    
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
    
    return positiveChecks >= 2 || (positiveChecks >= 1 && urlCheck);
    
  } catch (error) {
    return false;
  }
}

// ========================================
// LOGIN
// ========================================

async function loginWithCookies(page) {
  try {
    log('🍪 Intentando login con cookies...');
    
    const cookiesLoaded = await loadCookies(page);
    if (!cookiesLoaded) return false;
    
    const navigated = await safeGoto(page, 'https://www.linkedin.com/feed/');
    if (!navigated) return false;
    
    await delay(5000);
    
    const isLoggedIn = await checkIfLoggedIn(page);
    
    if (isLoggedIn) {
      log('✅ Login con cookies exitoso!', 'success');
      return true;
    }
    
    log('⚠️ Cookies no válidas - necesitan renovarse', 'warning');
    await sendCookieWarning(0);
    return false;
    
  } catch (error) {
    log(`Error en login: ${error.message}`, 'error');
    return false;
  }
}

async function loginToLinkedIn(page) {
  try {
    // Verificar expiración de cookies antes de intentar
    const cookieStatus = await checkCookieExpiration();
    
    if (cookieStatus.expired) {
      log('❌ Las cookies han expirado. Por favor renuévalas.', 'error');
      log('💡 Ejecuta: node get-linkedin-cookies.js', 'warning');
      return false;
    }
    
    // Intentar login con cookies
    const success = await loginWithCookies(page);
    
    if (!success) {
      log('❌ Login falló. Acciones necesarias:', 'error');
      log('1. Ejecuta: node get-linkedin-cookies.js', 'warning');
      log('2. Actualiza la variable LINKEDIN_COOKIES', 'warning');
      log('3. Redeploya el scraper', 'warning');
    }
    
    return success;
    
  } catch (error) {
    log(`Error crítico en login: ${error.message}`, 'error');
    return false;
  }
}

// ========================================
// SCRAPING
// ========================================

async function scrapeProfilePosts(page, profileUrl, authorName, group) {
  try {
    log(`📊 Extrayendo posts de: ${authorName}`);
    
    const activityUrl = `${profileUrl}/recent-activity/all/`;
    const navigated = await safeGoto(page, activityUrl);
    
    if (!navigated) {
      log(`No se pudo cargar perfil de ${authorName}`, 'error');
      return 0;
    }
    
    await delay(5000); // Esperar más para que cargue el JavaScript
    
    // Scroll gradual para cargar posts
    log('Scrolleando para cargar contenido...');
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await delay(2500);
    }
    
    await delay(3000); // Esperar final
    
    // Debug: Ver qué hay en la página
    const pageInfo = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        bodyLength: document.body.innerText.length,
        hasContent: document.body.innerText.includes('post') || document.body.innerText.includes('activity')
      };
    });
    
    log(`Debug - URL: ${pageInfo.url}, Title: ${pageInfo.title}`);
    
    // Extraer posts con selectores actualizados 2025
    const posts = await page.evaluate((maxPosts) => {
      const results = [];
      
      // Selectores actualizados para LinkedIn 2025
      const selectors = [
        'div.feed-shared-update-v2',
        'li.profile-creator-shared-feed-update__container',
        'div.feed-shared-update-v2__content',
        'div[data-urn*="activity"]',
        'div[data-id*="activity"]',
        'article.feed-shared-update-v2',
        'li.profile-creator-shared-feed-update',
        '.scaffold-finite-scroll__content > div',
        'div.feed-shared-actor__container'
      ];
      
      let postElements = [];
      let usedSelector = '';
      
      for (const selector of selectors) {
        postElements = document.querySelectorAll(selector);
        if (postElements.length > 0) {
          usedSelector = selector;
          console.log(`✓ Encontrados ${postElements.length} elementos con: ${selector}`);
          break;
        }
      }
      
      if (postElements.length === 0) {
        console.log('⚠️ No se encontraron posts con ningún selector');
        console.log('HTML preview:', document.body.innerHTML.substring(0, 500));
        return [];
      }
      
      for (let i = 0; i < Math.min(postElements.length, maxPosts); i++) {
        const post = postElements[i];
        
        try {
          // Múltiples estrategias para encontrar contenido
          const contentSelectors = [
            '.feed-shared-update-v2__description',
            '.update-components-text',
            '.feed-shared-inline-show-more-text',
            '.break-words',
            '.feed-shared-text',
            '[data-test-id="main-feed-activity-card__commentary"]',
            '.feed-shared-text__text-view'
          ];
          
          let content = '';
          for (const sel of contentSelectors) {
            const el = post.querySelector(sel);
            if (el && el.innerText && el.innerText.trim().length > 10) {
              content = el.innerText.trim();
              break;
            }
          }
          
          // Si no hay contenido, intentar buscar en todo el post
          if (!content) {
            const spans = post.querySelectorAll('span[dir="ltr"]');
            for (const span of spans) {
              if (span.innerText && span.innerText.trim().length > 20) {
                content = span.innerText.trim();
                break;
              }
            }
          }
          
          if (!content || content.length < 10) {
            console.log(`Post ${i}: Sin contenido suficiente`);
            continue;
          }
          
          // Buscar fecha
          const timeSelectors = ['time', '[datetime]', '.feed-shared-actor__sub-description'];
          let date = new Date().toISOString();
          
          for (const sel of timeSelectors) {
            const timeEl = post.querySelector(sel);
            if (timeEl) {
              date = timeEl.getAttribute('datetime') || timeEl.innerText || date;
              break;
            }
          }
          
          // Buscar URL del post
          let postUrl = '';
          const linkSelectors = [
            'a[href*="/posts/"]',
            'a[href*="/activity-"]',
            'a[data-control-name="update"]',
            'a.app-aware-link'
          ];
          
          for (const sel of linkSelectors) {
            const linkEl = post.querySelector(sel);
            if (linkEl && linkEl.href) {
              postUrl = linkEl.href;
              break;
            }
          }
          
          // Si no hay URL, intentar construir desde data-urn
          if (!postUrl) {
            const urn = post.getAttribute('data-urn') || post.getAttribute('data-id');
            if (urn) {
              postUrl = `https://www.linkedin.com/feed/update/${urn}`;
            }
          }
          
          if (!postUrl) {
            console.log(`Post ${i}: Sin URL`);
            continue;
          }
          
          // Buscar métricas
          let likes = 0;
          let comments = 0;
          
          const reactionElements = post.querySelectorAll('[aria-label*="reaction"]');
          reactionElements.forEach(el => {
            const text = el.innerText || el.getAttribute('aria-label') || '';
            const match = text.match(/(\d+[\d,\.]*)/);
            if (match) {
              const num = parseInt(match[1].replace(/[,\.]/g, ''));
              if (text.toLowerCase().includes('comment')) {
                comments = num;
              } else {
                likes = num;
              }
            }
          });
          
          // Detectar media
          const hasImage = post.querySelector('img[src*="media"], img[src*="dms/image"]') !== null;
          const hasVideo = post.querySelector('video, [data-test-id="video"]') !== null;
          const hasMedia = hasImage || hasVideo;
          
          results.push({
            content: content.substring(0, 1000), // Limitar a 1000 caracteres
            date,
            postUrl,
            likes,
            comments,
            shares: 0,
            hasMedia,
            mediaUrl: ''
          });
          
          console.log(`✓ Post ${i} extraído: ${content.substring(0, 50)}...`);
          
        } catch (err) {
          console.error(`Error extrayendo post ${i}:`, err.message);
        }
      }
      
      return results;
    }, CONFIG.MAX_POSTS_PER_PROFILE);
    
    log(`Encontrados ${posts.length} posts`);
    
    if (posts.length === 0) {
      log('No se encontraron posts. Posibles razones:', 'warning');
      log('1. El perfil no tiene actividad reciente', 'warning');
      log('2. El perfil es privado o no visible', 'warning');
      log('3. LinkedIn cambió su estructura HTML', 'warning');
    }
    
    let newPostsCount = 0;
    for (const post of posts) {
      const exists = await postExists(post.postUrl);
      
      if (!exists) {
        const saved = await savePost({
          authorName,
          authorProfileUrl: profileUrl,
          group,
          ...post
        });
        
        if (saved) newPostsCount++;
        await delay(500);
      }
    }
    
    log(`✅ ${newPostsCount} posts nuevos guardados`, 'success');
    return newPostsCount;
    
  } catch (error) {
    log(`Error scraping ${authorName}: ${error.message}`, 'error');
    return 0;
  }
}

// ========================================
// FUNCIÓN PRINCIPAL
// ========================================

async function runScraper() {
  log('🚀 Iniciando scraper de LinkedIn...');
  
  let browser;
  let success = false;
  let totalNewPosts = 0;
  let error = null;
  
  try {
    // Verificar estado de cookies al inicio
    await checkCookieExpiration();
    
    const profiles = await getActiveProfiles();
    
    if (profiles.length === 0) {
      log('No hay perfiles activos', 'warning');
      return;
    }
    
    log(`📋 Perfiles a monitorear: ${profiles.length}`);
    
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
    
    const loginSuccess = await loginToLinkedIn(page);
    
    if (!loginSuccess) {
      throw new Error('No se pudo iniciar sesión - cookies inválidas o expiradas');
    }
    
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
          await delay(CONFIG.DELAY_BETWEEN_PROFILES);
        }
        
      } catch (err) {
        log(`Error en perfil ${profile.name}: ${err.message}`, 'error');
      }
    }
    
    success = true;
    log(`✅ Scraping completado. ${totalNewPosts} posts nuevos`, 'success');
    
  } catch (err) {
    error = err.message;
    log(`❌ Error: ${error}`, 'error');
  } finally {
    if (browser) {
      await browser.close();
    }
    
    // Log del run
    await logScraperRun(success, totalNewPosts, error);
  }
}

// ========================================
// EJECUCIÓN
// ========================================

log('📱 Aplicación iniciada');
log('🔔 Sistema de monitoreo de cookies activo');

runScraper().catch(err => {
  log(`Error fatal: ${err.message}`, 'error');
});

cron.schedule(CONFIG.CRON_SCHEDULE, () => {
  log('⏰ Ejecutando tarea programada...');
  runScraper().catch(err => {
    log(`Error: ${err.message}`, 'error');
  });
});

log(`⏱️ Cron: ${CONFIG.CRON_SCHEDULE}`);
