// ============================================================
//  bot.js  –  Mineflayer bot with HTTP dashboard
// ============================================================

require('dotenv').config();

const mineflayer  = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { GoalBlock, GoalXZ }     = require('mineflayer-pathfinder').goals;
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const readline    = require('readline');
const https       = require('https');
const crypto      = require('crypto');
const express     = require('express');
const loggers     = require('./logging.js');

const logger = loggers.logger;

// ── Viewer state ────────────────────────────────────────────
let viewerFirstPerson = false;
let viewerServer      = null;

function startViewer(bot) {
    const launch = () => {
        try {
            viewerServer = mineflayerViewer(bot, {
                port: 3007,
                firstPerson: viewerFirstPerson,
                // Bind to all interfaces so the viewer is reachable from outside
                host: '0.0.0.0'
            });
            logger.info(`Prismarine viewer started on :3007 (${viewerFirstPerson ? 'first' : 'third'} person)`);
        } catch (e) {
            logger.error('Viewer failed to start: ' + e.message);
        }
    };

    if (viewerServer) {
        try {
            viewerServer.close(() => { viewerServer = null; launch(); });
        } catch (_) {
            viewerServer = null;
            launch();
        }
    } else {
        launch();
    }
}

// ── Discord webhook helper ───────────────────────────────────
function postToWebhook(webhookUrl, content) {
    if (!webhookUrl || !webhookUrl.startsWith('http')) return;
    const body = JSON.stringify({ content });
    try {
        const url  = new URL(webhookUrl);
        const opts = {
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = https.request(opts);
        req.on('error', e => logger.error(`Webhook error: ${e.message}`));
        req.write(body);
        req.end();
    } catch (e) {
        logger.error(`Webhook URL parse error: ${e.message}`);
    }
}

// ── Scoreboard ───────────────────────────────────────────────
function formatScoreboard(bot) {
    const scoreboards = bot.scoreboard;
    const sidebar = Object.values(scoreboards).find(sb => sb && sb.position === 1);
    if (!sidebar) return null;

    const title = sidebar.title
        ? sidebar.title.replace(/§./g, '')
        : 'Scoreboard';

    const items = Object.values(sidebar.itemsMap || {})
        .sort((a, b) => b.value - a.value)
        .map(item => {
            const name = (item.displayName || item.name || '').replace(/§./g, '');
            return `${name}: ${item.value}`;
        });

    return `**${title}**\n\`\`\`\n${items.join('\n')}\n\`\`\``;
}

function startScoreboardReporter(bot) {
    let config;
    try { config = require('./settings.json'); } catch (_) { return; }

    const sbConfig = config.scoreboard;
    if (!sbConfig || !sbConfig.enabled) return;

    const intervalMs = (sbConfig.interval || 60) * 1000;
    const webhookUrl  = sbConfig.webhook;
    logger.info(`Scoreboard reporter started (every ${sbConfig.interval}s)`);

    setInterval(() => {
        try {
            const message = formatScoreboard(bot);
            if (message) {
                postToWebhook(webhookUrl, message);
                logger.info('Scoreboard sent to Discord');
            } else {
                logger.warn('No sidebar scoreboard found');
            }
        } catch (err) {
            logger.error(`Scoreboard reporter error: ${err.message}`);
        }
    }, intervalMs);
}

// ── Express / dashboard ──────────────────────────────────────
const app  = express();
const port = process.env.PORT || 3000;

// Trust proxy headers if behind reverse proxy (Nginx, Apache, etc.)
app.set('trust proxy', 1);

const WEB_PASSWORD      = process.env.WEB_PASSWORD || 'admin';
const WEB_PASSWORD_HASH = crypto.createHash('sha256').update(WEB_PASSWORD).digest('hex');
const sessions          = new Set();
const chatLog           = [];
const MAX_CHAT_LOG      = 300;
const sseClients        = [];

function pushChatEntry(entry) {
    chatLog.push(entry);
    if (chatLog.length > MAX_CHAT_LOG) chatLog.shift();
    const data = `data: ${JSON.stringify(entry)}\n\n`;
    // Write to all connected SSE clients; remove dead ones
    for (let i = sseClients.length - 1; i >= 0; i--) {
        try {
            sseClients[i].write(data);
        } catch (_) {
            sseClients.splice(i, 1);
        }
    }
}

function parseCookies(req) {
    const out = {};
    const rc  = req.headers.cookie;
    if (rc) rc.split(';').forEach(c => {
        const [k, ...v] = c.split('=');
        out[k.trim()] = decodeURIComponent(v.join('=').trim());
    });
    return out;
}

function requireAuth(req, res, next) {
    const { session } = parseCookies(req);
    if (session && sessions.has(session)) return next();
    const isApi =
        (req.headers.accept && req.headers.accept.includes('application/json')) ||
        (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) ||
        ['/send', '/chatlog', '/events', '/toggle-view', '/status'].includes(req.path);
    if (isApi) return res.status(401).json({ ok: false, error: 'Not authenticated' });
    res.redirect('/login');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Login page ───────────────────────────────────────────────
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:'Segoe UI',sans-serif}
  .card{background:#1a1d2e;border:1px solid #2a2d3e;border-radius:12px;padding:40px 36px;width:100%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
  .logo{text-align:center;margin-bottom:28px}
  h1{color:#e2e8f0;font-size:22px;font-weight:600;text-align:center;margin-bottom:6px}
  p{color:#64748b;font-size:13px;text-align:center;margin-bottom:28px}
  label{display:block;color:#94a3b8;font-size:12px;font-weight:500;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
  input[type=password]{width:100%;background:#0f1117;border:1px solid #2a2d3e;border-radius:8px;color:#e2e8f0;font-size:15px;padding:11px 14px;outline:none;transition:border .2s}
  input[type=password]:focus{border-color:#6366f1}
  button{width:100%;margin-top:20px;background:#6366f1;border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:15px;font-weight:600;padding:12px;transition:background .2s}
  button:hover{background:#4f46e5}
  .error{background:#2d1b1b;border:1px solid #7f1d1d;border-radius:8px;color:#fca5a5;font-size:13px;padding:10px 14px;margin-bottom:20px;text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="48" height="48" rx="12" fill="#1e2035"/>
      <rect x="14" y="10" width="20" height="20" rx="4" fill="#6366f1"/>
      <rect x="10" y="30" width="28" height="8" rx="4" fill="#4f46e5"/>
    </svg>
    <h1>Minecraft Bot</h1>
    <p>Enter your password to access the dashboard</p>
  </div>
  <div id="errorBox" style="display:none" class="error">Incorrect password. Try again.</div>
  <div id="networkErrorBox" style="display:none" class="error">Network or crypto error. Check console.</div>
  <div>
    <label for="pw">Password</label>
    <input type="password" id="pw" placeholder="••••••••" autofocus autocomplete="current-password">
    <button id="loginBtn" type="button">Sign In</button>
  </div>
</div>
<script>
// SHA256 implementation that works in non-secure contexts (http://ip:port)
// Falls back to built-in crypto.subtle when available
async function sha256(str) {
    // Try native crypto.subtle first (works on https/localhost)
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
    }
    
    // Fallback: Pure JavaScript SHA256 implementation
    function rotateRight(n, x) { return (x >>> n) | (x << (32 - n)); }
    function choose(x, y, z) { return (x & y) ^ (~x & z); }
    function majority(x, y, z) { return (x & y) ^ (x & z) ^ (y & z); }
    function sha256Sigma0(x) { return rotateRight(2, x) ^ rotateRight(13, x) ^ rotateRight(22, x); }
    function sha256Sigma1(x) { return rotateRight(6, x) ^ rotateRight(11, x) ^ rotateRight(25, x); }
    function sha256Gamma0(x) { return rotateRight(7, x) ^ rotateRight(18, x) ^ (x >>> 3); }
    function sha256Gamma1(x) { return rotateRight(17, x) ^ rotateRight(19, x) ^ (x >>> 10); }
    
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let msg = unescape(encodeURIComponent(str));
    let len = msg.length;
    let words = [];
    for (let i = 0; i < len; i++) {
        words[i >> 2] |= (msg.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
    }
    words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
    words[((len + 64 >> 9) << 4) + 15] = len * 8;
    
    for (let i = 0; i < words.length; i += 16) {
        let w = new Array(64);
        for (let j = 0; j < 16; j++) w[j] = words[i + j] || 0;
        for (let j = 16; j < 64; j++) {
            w[j] = (sha256Gamma1(w[j - 2]) + w[j - 7] + sha256Gamma0(w[j - 15]) + w[j - 16]) | 0;
        }
        let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (let j = 0; j < 64; j++) {
            let T1 = (h + sha256Sigma1(e) + choose(e, f, g) + K[j] + w[j]) | 0;
            let T2 = (sha256Sigma0(a) + majority(a, b, c)) | 0;
            h = g; g = f; f = e; e = (d + T1) | 0; d = c; c = b; b = a; a = (T1 + T2) | 0;
        }
        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

async function doLogin() {
    const pw = document.getElementById('pw').value;
    if (!pw) return;
    
    document.getElementById('errorBox').style.display = 'none';
    document.getElementById('networkErrorBox').style.display = 'none';
    document.getElementById('loginBtn').disabled = true;
    document.getElementById('loginBtn').textContent = 'Signing in...';
    
    try {
        const hash = await sha256(pw);
        const res  = await fetch('/login', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ hash })
        });
        const data = await res.json();
        if (data.ok) {
            location.href = '/';
        } else {
            document.getElementById('errorBox').style.display = 'block';
            document.getElementById('pw').value = '';
            document.getElementById('pw').focus();
        }
    } catch (err) {
        console.error('Login error:', err);
        document.getElementById('networkErrorBox').style.display = 'block';
    } finally {
        document.getElementById('loginBtn').disabled = false;
        document.getElementById('loginBtn').textContent = 'Sign In';
    }
}
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
</script>
</body></html>`);
});

// ── Login endpoint with conditional secure cookies ────────────
app.post('/login', (req, res) => {
    const { hash } = req.body;
    if (hash && hash.toLowerCase() === WEB_PASSWORD_HASH) {
        const token = crypto.randomBytes(32).toString('hex');
        sessions.add(token);
        
        // Detect if connection is secure (direct HTTPS or behind proxy)
        const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        const secureFlag = isSecure ? '; Secure' : '';
        
        res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax${secureFlag}`);
        return res.json({ ok: true });
    }
    res.json({ ok: false });
});

// ── Logout endpoint with conditional secure cookies ───────────
app.post('/logout', (req, res) => {
    const { session } = parseCookies(req);
    if (session) sessions.delete(session);
    
    // Detect if connection is secure (direct HTTPS or behind proxy)
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const secureFlag = isSecure ? '; Secure' : '';
    
    res.setHeader('Set-Cookie', `session=; HttpOnly; Path=/; SameSite=Lax${secureFlag}; Max-Age=0`);
    res.redirect('/login');
});

// ── Main dashboard ───────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;color:#e2e8f0;font-family:'Segoe UI',sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
  header{background:#1a1d2e;border-bottom:1px solid #2a2d3e;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
  header h1{font-size:17px;font-weight:600;color:#e2e8f0;display:flex;align-items:center;gap:10px}
  .dot{width:9px;height:9px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px #22c55e;animation:pulse 2s infinite;flex-shrink:0}
  .dot.red{background:#ef4444;box-shadow:0 0 6px #ef4444}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .status{font-size:12px;color:#64748b;font-weight:400;margin-left:4px}
  .hdr-right{display:flex;align-items:center;gap:10px}
  .bot-info{font-size:12px;color:#64748b}
  button.logout{background:#2a2d3e;border:1px solid #3a3d4e;border-radius:7px;color:#94a3b8;cursor:pointer;font-size:13px;padding:7px 16px;transition:all .2s}
  button.logout:hover{background:#3a3d4e;color:#e2e8f0}
  .tabs{display:flex;gap:4px;padding:12px 24px 0;background:#1a1d2e;border-bottom:1px solid #2a2d3e;flex-shrink:0}
  .tab-btn{background:none;border:none;border-bottom:2px solid transparent;color:#64748b;cursor:pointer;font-size:14px;font-weight:500;padding:8px 16px 10px;transition:all .2s}
  .tab-btn:hover{color:#e2e8f0}
  .tab-btn.active{border-bottom-color:#6366f1;color:#e2e8f0}
  .panel{flex:1;display:none;flex-direction:column;padding:20px 24px;gap:16px;overflow:hidden;min-height:0}
  .panel.active{display:flex}
  /* Chat */
  .chatlog{flex:1;background:#1a1d2e;border:1px solid #2a2d3e;border-radius:10px;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:4px;min-height:0}
  .chatlog::-webkit-scrollbar{width:6px}
  .chatlog::-webkit-scrollbar-track{background:transparent}
  .chatlog::-webkit-scrollbar-thumb{background:#2a2d3e;border-radius:3px}
  .msg{font-size:13.5px;line-height:1.5;word-break:break-word;padding:2px 0}
  .msg .time{color:#475569;font-size:11px;margin-right:6px;font-family:monospace}
  .msg .user{color:#818cf8;font-weight:600}
  .msg .text{color:#cbd5e1}
  .msg.system .text{color:#64748b;font-style:italic}
  .msg.sent .user{color:#34d399}
  .send-row{display:flex;gap:10px;flex-shrink:0}
  .send-row input{flex:1;background:#1a1d2e;border:1px solid #2a2d3e;border-radius:8px;color:#e2e8f0;font-size:14px;padding:11px 14px;outline:none;transition:border .2s}
  .send-row input:focus{border-color:#6366f1}
  .send-row button{background:#6366f1;border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:14px;font-weight:600;padding:11px 22px;transition:background .2s;white-space:nowrap}
  .send-row button:hover{background:#4f46e5}
  .send-row button:disabled{background:#2a2d3e;color:#475569;cursor:not-allowed}
  /* Viewer */
  .viewer-wrap{flex:1;display:flex;flex-direction:column;gap:12px;min-height:0}
  .viewer-controls{display:flex;align-items:center;gap:12px;flex-shrink:0;flex-wrap:wrap}
  .view-toggle{background:#2a2d3e;border:1px solid #3a3d4e;border-radius:8px;color:#e2e8f0;cursor:pointer;font-size:13px;font-weight:500;padding:8px 18px;transition:all .2s}
  .view-toggle:hover{background:#3a3d4e}
  .view-toggle:disabled{opacity:.5;cursor:not-allowed}
  .view-label{font-size:13px;color:#64748b}
  .viewer-frame{flex:1;border:1px solid #2a2d3e;border-radius:10px;background:#0a0c14;min-height:200px;width:100%}
  .viewer-note{font-size:12px;color:#475569}
</style>
</head>
<body>
<header>
  <h1>
    <span class="dot" id="connDot"></span>
    Minecraft Bot
    <span class="status" id="statusText">• Connecting…</span>
  </h1>
  <div class="hdr-right">
    <span class="bot-info" id="botInfo"></span>
    <button class="logout" type="button" onclick="doLogout()">Logout</button>
  </div>
</header>
<nav class="tabs">
  <button class="tab-btn active" data-target="chatPanel">💬 Chat</button>
  <button class="tab-btn" data-target="viewerPanel">🎮 Viewer</button>
</nav>

<div id="chatPanel" class="panel active">
  <div class="chatlog" id="log"></div>
  <div class="send-row">
    <input type="text" id="msgInput" placeholder="Type a message or /command…" autofocus>
    <button id="sendBtn">Send</button>
  </div>
</div>

<div id="viewerPanel" class="panel">
  <div class="viewer-wrap">
    <div class="viewer-controls">
      <button class="view-toggle" id="toggleViewBtn">Switch to First Person</button>
      <span class="view-label" id="viewLabel">Current: Third Person</span>
      <span class="viewer-note">Viewer runs on port 3007</span>
    </div>
    <iframe class="viewer-frame" id="viewerFrame" src="" allowfullscreen></iframe>
  </div>
</div>

<script>
const log           = document.getElementById('log');
const input         = document.getElementById('msgInput');
const sendBtn       = document.getElementById('sendBtn');
const statusText    = document.getElementById('statusText');
const connDot       = document.getElementById('connDot');
const botInfo       = document.getElementById('botInfo');
const toggleViewBtn = document.getElementById('toggleViewBtn');
const viewLabel     = document.getElementById('viewLabel');
const viewerFrame   = document.getElementById('viewerFrame');

const viewerUrl = location.protocol + '//' + location.hostname + ':3007';

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.target).classList.add('active');
        if (btn.dataset.target === 'viewerPanel' && !viewerFrame.src) {
            viewerFrame.src = viewerUrl;
        }
    });
});

function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function addMsg(entry, scroll = true) {
    const div  = document.createElement('div');
    div.className = 'msg' +
        (entry.type === 'system' ? ' system' : '') +
        (entry.type === 'sent'   ? ' sent'   : '');
    const time = document.createElement('span');
    time.className   = 'time';
    time.textContent = fmtTime(entry.ts);
    const user = document.createElement('span');
    user.className   = 'user';
    user.textContent = entry.username ? '<' + entry.username + '> ' : '';
    const text = document.createElement('span');
    text.className   = 'text';
    text.textContent = entry.message;
    div.appendChild(time);
    if (entry.username) div.appendChild(user);
    div.appendChild(text);
    log.appendChild(div);
    if (scroll) log.scrollTop = log.scrollHeight;
}

// Load history
fetch('/chatlog').then(r => {
    if (r.status === 401) { location.href = '/login'; return null; }
    return r.json();
}).then(entries => {
    if (!entries) return;
    entries.forEach(e => addMsg(e, false));
    log.scrollTop = log.scrollHeight;
}).catch(() => {});

// Status polling (every 5 s)
function pollStatus() {
    fetch('/status').then(r => r.json()).then(d => {
        if (d.connected) {
            statusText.textContent = '• Connected';
            statusText.style.color = '#22c55e';
            connDot.classList.remove('red');
            botInfo.textContent    = d.username ? d.username + ' @ ' + d.server : '';
        } else {
            statusText.textContent = '• Disconnected';
            statusText.style.color = '#ef4444';
            connDot.classList.add('red');
            botInfo.textContent    = '';
        }
    }).catch(() => {});
}
pollStatus();
setInterval(pollStatus, 5000);

// SSE live chat
const es = new EventSource('/events');
es.onopen  = () => {
    statusText.textContent = '• Connected';
    statusText.style.color = '#22c55e';
    connDot.classList.remove('red');
};
es.onerror = () => {
    statusText.textContent = '• Disconnected';
    statusText.style.color = '#ef4444';
    connDot.classList.add('red');
};
es.onmessage = e => { try { addMsg(JSON.parse(e.data)); } catch(_){} };

// Send message
async function sendMessage() {
    const msg = input.value.trim();
    if (!msg) return;
    input.value     = '';
    sendBtn.disabled = true;
    try {
        const res  = await fetch('/send', {
            method:  'POST',
            headers: {'Content-Type':'application/json'},
            body:    JSON.stringify({ message: msg })
        });
 });
        if (res.status === 401) { location.href = '/login'; return; }
        const data = await res.json();
        if (!data.ok) addMsg({ ts: Date.now(), type: 'system', message: '⚠ ' + (data.error || 'Failed to send') });
    } catch (err) {
        addMsg({ ts: Date.now(), type: 'system', message: '⚠ Network error: ' + err.message });
    } finally {
        sendBtn.disabled = false;
        input.focus();
    }
}
sendBtn.addEventListener('click', sendMessage);
input.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

// Toggle viewer perspective
let isFirstPerson = false;
toggleViewBtn.addEventListener('click', async () => {
    toggleViewBtn.disabled = true;
    try {
        const res  = await fetch('/toggle-view', { method: 'POST', headers: {'Content-Type':'application/json'} });
        if (res.status === 401) { location.href = '/login'; return; }
        const data = await res.json();
        if (data.ok) {
            isFirstPerson             = data.firstPerson;
            toggleViewBtn.textContent = isFirstPerson ? 'Switch to Third Person' : 'Switch to First Person';
            viewLabel.textContent     = 'Current: ' + (isFirstPerson ? 'First Person' : 'Third Person');
            setTimeout(() => { viewerFrame.src = viewerUrl + '?' + Date.now(); }, 1400);
        } else {
            alert(data.error || 'Failed to toggle view');
        }
    } catch (err) {
        alert('Network error: ' + err.message);
    } finally {
        setTimeout(() => { toggleViewBtn.disabled = false; }, 1600);
    }
});

async function doLogout() {
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
}
</script>
</body></html>`);
});

// ── API endpoints ────────────────────────────────────────────
app.get('/chatlog', requireAuth, (_req, res) => res.json(chatLog));

app.get('/status', requireAuth, (_req, res) => {
    if (currentBot) {
        res.json({
            connected: true,
            username:  currentBot.username  || null,
            server:    process.env.SERVER_IP || null
        });
    } else {
        res.json({ connected: false });
    }
});

app.get('/events', requireAuth, (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');   // disable Nginx buffering if present
    res.flushHeaders();

    // Send a heartbeat comment every 25 s to keep the connection alive through proxies
    const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 25000);

    sseClients.push(res);
    req.on('close', () => {
        clearInterval(hb);
        const i = sseClients.indexOf(res);
        if (i !== -1) sseClients.splice(i, 1);
    });
});

app.post('/send', requireAuth, (req, res) => {
    const { message } = req.body;
    if (!message || !message.trim()) return res.json({ ok: false, error: 'Empty message' });
    if (!currentBot)                  return res.json({ ok: false, error: 'Bot not connected' });
    try {
        currentBot.chat(message.trim());
        pushChatEntry({ ts: Date.now(), type: 'sent', username: 'You', message: message.trim() });
        res.json({ ok: true });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

app.post('/toggle-view', requireAuth, (_req, res) => {
    if (!currentBot) return res.json({ ok: false, error: 'Bot not connected' });
    viewerFirstPerson = !viewerFirstPerson;
    startViewer(currentBot);
    res.json({ ok: true, firstPerson: viewerFirstPerson });
});

app.post('/logout', (req, res) => {
    const { session } = parseCookies(req);
    if (session) sessions.delete(session);
    
    // Detect if connection is secure (direct HTTPS or behind proxy)
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const secureFlag = isSecure ? '; Secure' : '';
    
    res.setHeader('Set-Cookie', `session=; HttpOnly; Path=/; SameSite=Lax${secureFlag}; Max-Age=0`);
    // Support both JSON and redirect callers
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json({ ok: true });
    }
    res.redirect('/login');
});

// Bind to 0.0.0.0 so the dashboard is reachable from any IP
app.listen(port, '0.0.0.0', () => {
    logger.info(`Dashboard listening on 0.0.0.0:${port}`);
});

// ── stdin passthrough ────────────────────────────────────────
let currentBot = null;

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
    const text = line.trim();
    if (!text) return;
    if (currentBot) {
        currentBot.chat(text);
        console.log(`[You] ${text}`);
    } else {
        console.log('Bot is not connected yet.');
    }
});

// ── Circle-walk helper ───────────────────────────────────────
function circleWalk(bot, radius) {
    return new Promise(() => {
        const { x, y, z } = bot.entity.position;
        const points = [
            [x + radius, y, z],
            [x,          y, z + radius],
            [x - radius, y, z],
            [x,          y, z - radius],
        ];
        let i = 0;
        setInterval(() => {
            if (i >= points.length) i = 0;
            bot.pathfinder.setGoal(new GoalXZ(points[i][0], points[i][2]));
            i++;
        }, 1000);
    });
}

// ── Bot creation ─────────────────────────────────────────────
function createBot() {
    const options = {
        host:     process.env.SERVER_IP,
        port:     process.env.SERVER_PORT   ? parseInt(process.env.SERVER_PORT)   : 25565,
        version:  process.env.SERVER_VERSION || '1.19',
        username: process.env.BOT_USERNAME,
        password: process.env.BOT_PASSWORD,
        auth:     process.env.BOT_TYPE      || 'mojang',
        // Suppress the client-side "respawn" dimension lookup that sometimes
        // throws when the registry hasn't fully loaded yet.
        checkTimeoutInterval: 30000,
        // Let the bot handle its own keepAlive
        keepAlive: true,
        // Disable color codes in chat so our logs are clean
    };

    let bot;
    try {
        bot       = mineflayer.createBot(options);
        currentBot = bot;
    } catch (err) {
        logger.error('Error creating bot: ' + err.message);
        return;
    }

    // ── Pathfinder setup ──────────────────────────────────────
    bot.loadPlugin(pathfinder);

    // Safe movement setup – wait until bot has version info
    function applyMovements() {
        try {
            const mcData     = require('minecraft-data')(bot.version);
            const defaultMove = new Movements(bot, mcData);
            bot.pathfinder.setMovements(defaultMove);
        } catch (e) {
            logger.warn('Movements setup deferred: ' + e.message);
        }
    }

    // ── Dimension / respawn stability fix ────────────────────
    // The vanilla mineflayer respawn handler can crash if `dimensionsByName`
    // isn't populated yet. We guard the listener and re-apply movements after
    // each dimension change so the pathfinder stays in sync.
    bot.on('game_state_changed', state => {
        logger.info(`Game state → ${state}`);
        if (state === 'respawn') {
            // Re-apply movements once the new dimension is loaded
            setImmediate(() => {
                try { applyMovements(); } catch (_) {}
            });
        }
    });

    // Also heal movements after any dimension/world switch
    bot.on('respawn', () => {
        setImmediate(() => {
            try { applyMovements(); } catch (_) {}
        });
    });

    // ── spawn ─────────────────────────────────────────────────
    bot.once('spawn', () => {
        logger.info('Bot joined the server');
        pushChatEntry({ ts: Date.now(), type: 'system', message: '✔ Bot joined the server' });
        if (process.env.WEBHOOK_URL) postToWebhook(process.env.WEBHOOK_URL, 'Bot joined the server');

        applyMovements();
        if (bot.settings) bot.settings.colorsEnabled = false;

        startViewer(bot);
        startScoreboardReporter(bot);

        // Auto-auth
        if (process.env.AUTO_AUTH_ENABLED === 'true') {
            logger.info('Auto-auth enabled');
            const pwd = process.env.AUTO_AUTH_PASSWORD;
            setTimeout(() => {
                bot.chat(`/register ${pwd} ${pwd}`);
                bot.chat(`/login ${pwd}`);
                logger.info('Authentication commands sent');
            }, 500);
        }

        // Auto chat messages
        if (process.env.CHAT_MESSAGES_ENABLED === 'true') {
            logger.info('Auto chat-messages enabled');
            let messages = [];
            try {
                messages = process.env.CHAT_MESSAGES
                    ? JSON.parse(process.env.CHAT_MESSAGES)
                    : [];
            } catch (_) {
                logger.warn('CHAT_MESSAGES env var is not valid JSON');
            }

            if (process.env.CHAT_MESSAGES_REPEAT === 'true') {
                const delay = process.env.CHAT_MESSAGES_REPEAT_DELAY
                    ? parseInt(process.env.CHAT_MESSAGES_REPEAT_DELAY)
                    : 60;
                let i = 0;
                setInterval(() => {
                    if (!messages.length) return;
                    bot.chat(String(messages[i]));
                    i = (i + 1) % messages.length;
                }, delay * 1000);
            } else {
                messages.forEach(msg => bot.chat(String(msg)));
            }
        }

        // Navigate to position
        if (process.env.POSITION_ENABLED === 'true') {
            const posX = parseInt(process.env.POSITION_X) || 0;
            const posY = parseInt(process.env.POSITION_Y) || 0;
            const posZ = parseInt(process.env.POSITION_Z) || 0;
            logger.info(`Moving to target (${posX}, ${posY}, ${posZ})`);
            bot.pathfinder.setGoal(new GoalBlock(posX, posY, posZ));
        }

        // Anti-AFK
        if (process.env.ANTI_AFK_ENABLED === 'true') {
            if (process.env.ANTI_AFK_SNEAK === 'true')
                bot.setControlState('sneak', true);

            if (process.env.ANTI_AFK_JUMP === 'true')
                bot.setControlState('jump', true);

            if (process.env.ANTI_AFK_HIT_ENABLED === 'true') {
                const hitDelay   = parseInt(process.env.ANTI_AFK_HIT_DELAY) || 1000;
                const attackMobs = process.env.ANTI_AFK_HIT_ATTACK_MOBS === 'true';
                setInterval(() => {
                    if (attackMobs) {
                        const entity = bot.nearestEntity(e =>
                            e.type !== 'object' && e.type !== 'player' &&
                            e.type !== 'global' && e.type !== 'orb'   && e.type !== 'other');
                        if (entity) { bot.attack(entity); return; }
                    }
                    bot.swingArm('right', true);
                }, hitDelay);
            }

            if (process.env.ANTI_AFK_ROTATE === 'true') {
                setInterval(() => {
                    bot.look(bot.entity.yaw + 1, bot.entity.pitch, true);
                }, 100);
            }

            if (process.env.ANTI_AFK_CIRCLE_WALK_ENABLED === 'true') {
                const radius = parseInt(process.env.ANTI_AFK_CIRCLE_WALK_RADIUS) || 2;
                circleWalk(bot, radius);
            }
        }
    });

    // ── Chat logging ──────────────────────────────────────────
    bot.on('chat', (username, message) => {
        if (process.env.CHAT_LOG === 'true') logger.info(`<${username}> ${message}`);
        if (username === bot.username) return;
        pushChatEntry({ ts: Date.now(), type: 'chat', username, message });
    });

    // Catch whispers / system messages too
    bot.on('message', (jsonMsg) => {
        const text = jsonMsg.toString().replace(/§./g, '').trim();
        if (!text) return;
        // Only forward messages that aren't normal chat (those come via 'chat' event above)
        if (jsonMsg.translate && jsonMsg.translate.startsWith('chat.type.text')) return;
        pushChatEntry({ ts: Date.now(), type: 'system', message: text });
    });

    bot.on('goal_reached', () => {
        if (process.env.POSITION_ENABLED === 'true')
            logger.info(`Arrived at target: ${bot.entity.position}`);
    });

    bot.on('death', () => {
        logger.warn(`Bot died and respawned at ${bot.entity.position}`);
        pushChatEntry({ ts: Date.now(), type: 'system', message: '☠ Bot died and respawned' });
    });

    bot.on('health', () => {
        if (bot.health <= 0) return; // covered by 'death'
        // Could extend here if desired
    });

    bot.on('kicked', reason => {
        let reasonText = '';
        try {
            const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
            reasonText   = parsed.text || (parsed.extra && parsed.extra[0] && parsed.extra[0].text) || '';
        } catch (_) {
            reasonText = String(reason);
        }
        reasonText = reasonText.replace(/§./g, '');
        logger.warn(`Bot was kicked. Reason: ${reasonText}`);
        pushChatEntry({ ts: Date.now(), type: 'system', message: `⚡ Kicked: ${reasonText}` });
        if (process.env.WEBHOOK_URL) postToWebhook(process.env.WEBHOOK_URL, `Bot kicked: ${reasonText}`);
    });

    bot.on('error', err => {
        logger.error(err.message);
    });

    bot.on('end', reason => {
        logger.info(`Bot disconnected (${reason || 'unknown'})`);
        pushChatEntry({ ts: Date.now(), type: 'system', message: `🔌 Disconnected: ${reason || ''}` });
        currentBot = null;

        if (process.env.AUTO_RECONNECT === 'true') {
            const delay = parseInt(process.env.AUTO_RECONNECT_DELAY) || 5000;
            logger.info(`Reconnecting in ${delay}ms…`);
            setTimeout(createBot, delay);
        }
    });
}

createBot();
