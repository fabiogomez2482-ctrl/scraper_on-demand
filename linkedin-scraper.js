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

// Obtener perfiles activos para monitorear
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

// Verificar si un post ya existe
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

// Guardar post en Airtable
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

// Login a LinkedIn
async function loginToLinkedIn(page) {
  try {
    log('Iniciando sesión en LinkedIn...');
    
    await page.goto('https://www.linkedin.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await delay(CONFIG.DELAY_BETWEEN_ACTIONS);
    
    // Ingresar email
    await page.type('#username', CONFIG.LINKEDIN_EMAIL, { delay: 100 });
    await delay(1000);
    
    // Ingresar password
    await page.type('#password', CONFIG.LINKEDIN_PASSWORD, { delay: 100 });
    await delay(1000);
    
    // Click en login
    await page.click('button[type="submit"]');
    
    // Esperar a que cargue el feed
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    
    log('Login exitoso', 'success');
    return true;
  } catch (error) {
    log(`Error en login: ${error.message}`, 'error');
    return false;
  }
}

// Extraer posts de un perfil
async function scrapeProfilePosts(page, profileUrl, authorName, group) {
  try {
    log(`Extrayendo posts de: ${authorName}`);
    
    // Ir al perfil y a la sección de actividad
    const activityUrl = `${profileUrl}/recent-activity/all/`;
    await page.goto(activityUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await delay(CONFIG.DELAY_BETWEEN_ACTIONS);
    
    // Scroll para cargar posts
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await delay(2000);
    }
    
    // Extraer posts
    const posts = await page.evaluate((maxPosts) => {
      const postElements = document.querySelectorAll('.feed-shared-update-v2');
      const results = [];
      
      for (let i = 0; i < Math.min(postElements.length, maxPosts); i++) {
        const post = postElements[i];
        
        try {
          // Contenido
          const contentElement = post.querySelector('.feed-shared-update-v2__description');
          const content = contentElement ? contentElement.innerText.trim() : '';
          
          // Fecha
          const timeElement = post.querySelector('.feed-shared-actor__sub-description time');
          const date = timeElement ? timeElement.getAttribute('datetime') : '';
          
          // URL del post
          const linkElement = post.querySelector('.feed-shared-control-menu__trigger');
          const postUrl = linkElement ? linkElement.closest('article').querySelector('a[href*="/posts/"]')?.href : '';
          
          // Métricas
          const likesElement = post.querySelector('.social-details-social-counts__reactions-count');
          const likes = likesElement ? parseInt(likesElement.innerText.replace(/\D/g, '')) || 0 : 0;
          
          const commentsElement = post.querySelector('.social-details-social-counts__comments');
          const comments = commentsElement ? parseInt(commentsElement.innerText.replace(/\D/g, '')) || 0 : 0;
          
          // Media
          const imageElement = post.querySelector('.feed-shared-image__image-link img');
          const videoElement = post.querySelector('video');
          const hasMedia = !!(imageElement || videoElement);
          const mediaUrl = imageElement ? imageElement.src : (videoElement ? videoElement.poster : '');
          
          if (content && postUrl) {
            results.push({
              content,
              date,
              postUrl,
              likes,
              comments,
              shares: 0, // LinkedIn no muestra shares directamente
              hasMedia,
              mediaUrl
            });
          }
        } catch (err) {
          console.error('Error extrayendo post individual:', err);
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
        '--window-size=1920x1080'
      ]
    });
    
    const page = await browser.newPage();
    
    // Configurar viewport y user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
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
        
        // Delay entre perfiles
        log(`Esperando ${CONFIG.DELAY_BETWEEN_PROFILES / 1000}s antes del siguiente perfil...`);
        await delay(CONFIG.DELAY_BETWEEN_PROFILES);
        
      } catch (error) {
        log(`Error procesando perfil ${profile.name}: ${error.message}`, 'error');
        continue;
      }
    }
    
    log(`✅ Scraping completado. Total posts nuevos: ${totalNewPosts}`, 'success');
    
  } catch (error) {
    log(`Error general: ${error.message}`, 'error');
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
log('Aplicación iniciada');
runScraper();

// Programar ejecución con cron
cron.schedule(CONFIG.CRON_SCHEDULE, () => {
  log('Ejecutando tarea programada...');
  runScraper();
});

log(`Cron programado: ${CONFIG.CRON_SCHEDULE} (cada 6 horas)`);