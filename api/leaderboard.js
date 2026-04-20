import { neon } from '@neondatabase/serverless';

const KNOWN_GAMES = new Set([
  'asteroid-blitz', 'bookshelf-escape', 'coin-flip', 'cyber-pong',
  'dice-roll', 'football', 'hex-sweep', 'memory-matrix',
  'neon-breaker', 'pipe-flow', 'pixel-jumper', 'rhythm-pulse',
  'river-run', 'slash-fury', 'snake-neon', 'stellar-dash',
  'tower-stack', 'void-dancer'
]);

const MAX_NAME_LEN = 20;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const sql = neon(process.env.DATABASE_URL);

  if (req.method === 'GET') {
    const game = req.query.game;
    if (!game || !KNOWN_GAMES.has(game)) {
      res.status(400).json({ error: 'Unknown game' });
      return;
    }
    const rows = await sql`
      SELECT player, score, created_at
      FROM scores
      WHERE game_id = ${game}
      ORDER BY score DESC, created_at ASC
      LIMIT 10
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === 'POST') {
    const { game, player, score } = req.body || {};
    if (!game || !KNOWN_GAMES.has(game)) {
      res.status(400).json({ error: 'Unknown game' });
      return;
    }
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 9_999_999) {
      res.status(400).json({ error: 'Invalid score' });
      return;
    }
    const name = String(player || 'Anonymous').trim().slice(0, MAX_NAME_LEN) || 'Anonymous';
    await sql`
      INSERT INTO scores (game_id, player, score)
      VALUES (${game}, ${name}, ${score})
    `;
    res.status(201).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
