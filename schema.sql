-- Public board. One row per published course, one row per posted time.
-- The track document is stored whole, logo included, so a course flown
-- from this board wears the same sponsor print the author published.

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  author TEXT NOT NULL,
  document JSONB NOT NULL,
  plan JSONB NOT NULL,
  layout_hash TEXT NOT NULL,
  edit_key_hash TEXT NOT NULL,
  has_logo BOOLEAN NOT NULL DEFAULT FALSE,
  gates INTEGER NOT NULL,
  elements INTEGER NOT NULL,
  published_utc TIMESTAMPTZ NOT NULL,
  updated_utc TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS times (
  id BIGSERIAL PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lap_ms INTEGER NOT NULL,
  posted_utc TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS times_track_lap
  ON times (track_id, lap_ms, posted_utc);

-- Tester tickets from the simulator. Additive: an existing database
-- gains this table the next time the process starts, and nothing in
-- tracks or times is rewritten.
CREATE TABLE IF NOT EXISTS bugs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  what TEXT NOT NULL,
  expected TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '',
  reporter TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolution TEXT NOT NULL DEFAULT '',
  submitted_utc TIMESTAMPTZ NOT NULL,
  updated_utc TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS bugs_status_submitted
  ON bugs (status, submitted_utc DESC);
