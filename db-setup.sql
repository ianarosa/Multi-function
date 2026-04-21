-- Run this once against your Neon database to set up the leaderboard schema.
-- In your Neon console: SQL Editor, paste and run.

CREATE TABLE IF NOT EXISTS scores (
  id         SERIAL PRIMARY KEY,
  game_id    TEXT    NOT NULL,
  player     TEXT    NOT NULL,
  score      INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (game_id, player)
);

CREATE INDEX IF NOT EXISTS scores_game_rank ON scores (game_id, score DESC);

-- If you already ran the old schema (no UNIQUE constraint), run this instead:
--
--   DELETE FROM scores s
--     USING scores s2
--     WHERE s.game_id = s2.game_id
--       AND s.player  = s2.player
--       AND s.score   < s2.score;
--
--   DELETE FROM scores s
--     USING scores s2
--     WHERE s.game_id = s2.game_id
--       AND s.player  = s2.player
--       AND s.id      < s2.id;
--
--   ALTER TABLE scores ADD CONSTRAINT scores_game_player UNIQUE (game_id, player);
