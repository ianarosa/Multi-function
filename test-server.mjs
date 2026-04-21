// Local dev server: serves static files + mocks /api/leaderboard in-memory.
// Usage: node test-server.mjs
import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR  = fileURLToPath(new URL('.', import.meta.url));
const PORT = 3000;

// In-memory scores store: { [game]: [{player, score, created_at}] }
const store = {};

function getTop10(game) {
  return (store[game] || [])
    .sort((a, b) => b.score - a.score || new Date(a.created_at) - new Date(b.created_at))
    .slice(0, 10);
}

function insertScore(game, player, score) {
  if (!store[game]) store[game] = [];
  const existing = store[game].find(r => r.player === player);
  if (existing) {
    if (score > existing.score) { existing.score = score; existing.created_at = new Date().toISOString(); }
  } else {
    store[game].push({ player, score, created_at: new Date().toISOString() });
  }
}

// Seed a few demo scores so the leaderboard isn't empty on first load
const GAMES = ['asteroid-blitz','snake-neon','neon-breaker','pixel-jumper','cyber-pong',
               'void-dancer','river-run','slash-fury','tower-stack','stellar-dash',
               'bookshelf-escape','coin-flip','dice-roll','football','hex-sweep',
               'memory-matrix','pipe-flow','rhythm-pulse'];
const NAMES = ['Alice','Bob','Carol','Dave','Eve'];
for (const g of GAMES) {
  for (let i = 0; i < 5; i++) {
    insertScore(g, NAMES[i], Math.floor(Math.random() * 9000) + 1000);
  }
}

const MIME = { '.html':'text/html','.js':'application/javascript',
               '.css':'text/css','.png':'image/png','.ico':'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API routes
  if (url.pathname === '/api/leaderboard') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET') {
      const game = url.searchParams.get('game') || '';
      res.writeHead(200);
      res.end(JSON.stringify(getTop10(game)));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { game, player, score } = JSON.parse(body);
          insertScore(game, player, Number(score));
          res.writeHead(201);
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'bad request' }));
        }
      });
      return;
    }
  }

  // Static file serving with clean-URL support
  let filePath = url.pathname;
  if (filePath === '/') filePath = '/index.html';
  // cleanUrls: /game-name → /game-name/index.html
  if (!path.extname(filePath)) {
    const withIndex = path.join(DIR, filePath, 'index.html');
    if (fs.existsSync(withIndex)) {
      filePath = path.join(filePath, 'index.html');
    } else {
      filePath = filePath + '.html';
    }
  }

  const abs = path.join(DIR, filePath);
  if (!abs.startsWith(DIR)) { res.writeHead(403); res.end(); return; }

  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(abs);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Dev server running at http://localhost:${PORT}\n`);
  console.log('  Games:');
  for (const g of GAMES) console.log(`    http://localhost:${PORT}/${g}`);
  console.log('\n  Scores are in-memory only (restart = reset).');
  console.log('  Press Ctrl+C to stop.\n');
});
