import { neon } from '@neondatabase/serverless';

const KNOWN_GAMES = new Set([
  'asteroid-blitz', 'bookshelf-escape', 'coin-flip', 'cyber-pong',
  'dice-roll', 'football', 'hex-sweep', 'memory-matrix',
  'neon-breaker', 'pipe-flow', 'pixel-jumper', 'rhythm-pulse',
  'river-run', 'slash-fury', 'snake-neon', 'stellar-dash',
  'tower-stack', 'void-dancer'
]);

const MAX_NAME_LEN = 20;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

let schemaReady = false;
async function ensureSchema(sql) {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS scores (
      id         SERIAL PRIMARY KEY,
      game_id    TEXT    NOT NULL,
      player     TEXT    NOT NULL,
      score      INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS scores_game_rank ON scores (game_id, score DESC)`;
  schemaReady = true;
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!env.DATABASE_URL) {
    return json({ error: 'DATABASE_URL is not configured on the server' }, 500);
  }

  try {
    const sql = neon(env.DATABASE_URL);
    await ensureSchema(sql);

    if (method === 'GET') {
      const game = new URL(request.url).searchParams.get('game');
      if (!game || !KNOWN_GAMES.has(game)) {
        return json({ error: 'Unknown game' }, 400);
      }
      const rows = await sql`
        SELECT player, score, created_at
        FROM scores
        WHERE game_id = ${game}
        ORDER BY score DESC, created_at ASC
        LIMIT 10
      `;
      return json(rows, 200);
    }

    if (method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const { game, player, score } = body || {};
      if (!game || !KNOWN_GAMES.has(game)) {
        return json({ error: 'Unknown game' }, 400);
      }
      if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 9_999_999) {
        return json({ error: 'Invalid score' }, 400);
      }
      const name = String(player || 'Anonymous').trim().slice(0, MAX_NAME_LEN) || 'Anonymous';
      await sql`
        INSERT INTO scores (game_id, player, score)
        VALUES (${game}, ${name}, ${score})
      `;
      return json({ ok: true }, 201);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('leaderboard handler error:', err);
    return json({
      error: 'Leaderboard database error',
      detail: err && err.message ? err.message : String(err)
    }, 500);
  }
}
