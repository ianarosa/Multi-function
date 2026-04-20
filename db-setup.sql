-- Run this once against your Neon database to set up the leaderboard schema.
-- In your Neon console: Settings → SQL Editor, paste and run.

CREATE TABLE IF NOT EXISTS scores (
  id        SERIAL PRIMARY KEY,
  game_id   TEXT    NOT NULL,
  player    TEXT    NOT NULL,
  score     INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scores_game_rank ON scores (game_id, score DESC);
