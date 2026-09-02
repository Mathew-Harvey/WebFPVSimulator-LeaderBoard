-- This file is part of the WebFPVSimulator leaderboard.
--
-- This program is free software: you can redistribute it and/or modify
-- it under the terms of the GNU General Public License as published by
-- the Free Software Foundation, either version 3 of the License, or (at
-- your option) any later version.
--
-- This program is distributed in the hope that it will be useful, but
-- WITHOUT ANY WARRANTY, without even the implied warranty of
-- MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
-- General Public License for more details.
--
-- You should have received a copy of the GNU General Public License
-- along with this program. If not, see <https://www.gnu.org/licenses/>.

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

-- public_id is the handle a time is addressed by over the API, minted by
-- the store like a bug id, because the BIGSERIAL is a storage detail and
-- the file store has no serial to match it with. ghost is the simulator's
-- recorded lap for that time, base64 of the format in the simulator's
-- src/share/ghostdata.js, and null on a time posted without one.
CREATE TABLE IF NOT EXISTS times (
  id BIGSERIAL PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  public_id TEXT,
  name TEXT NOT NULL,
  lap_ms INTEGER NOT NULL,
  ghost TEXT,
  posted_utc TIMESTAMPTZ NOT NULL
);

-- Additive migration for a database from before ghosts. CREATE TABLE IF
-- NOT EXISTS above does nothing on an existing table, so the two columns
-- are added here as well; rows from before carry null in both, which the
-- API reads as "no ghost to fetch".
ALTER TABLE times ADD COLUMN IF NOT EXISTS public_id TEXT;
ALTER TABLE times ADD COLUMN IF NOT EXISTS ghost TEXT;

CREATE INDEX IF NOT EXISTS times_track_lap
  ON times (track_id, lap_ms, posted_utc);

CREATE UNIQUE INDEX IF NOT EXISTS times_public_id
  ON times (public_id);

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

-- Tags on a track. Additive: an existing row gets the empty array, which
-- reads as "untagged" everywhere. TEXT[] rather than a join table because a
-- track wears at most five of a closed vocabulary and nothing ever asks the
-- question the other way round, which is the only thing a join table would
-- buy. The GIN index is what makes "every track tagged skills" a lookup
-- rather than a scan of the whole board.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS tracks_tags ON tracks USING GIN (tags);

-- Filtering by author is a first class thing on the board page now, and
-- author has always been a column. It only ever lacked an index.
CREATE INDEX IF NOT EXISTS tracks_author ON tracks (lower(author));

-- Freestyle runs. One row per posted run, and the board keeps only a
-- pilot's BEST run per map: a leaderboard is a list of who is good, not a
-- log of who pressed the button. public_id is minted by the store like a
-- time id, for the same reason.
--
-- Every number here is CLAIMED by the page that posted it. The board cannot
-- recompute a score without being a second copy of the game, so validate.js
-- bounds the claim and checks it against itself and nothing here should be
-- read as verified. See inspectRun.
CREATE TABLE IF NOT EXISTS runs (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT,
  name TEXT NOT NULL,
  map TEXT NOT NULL,
  style TEXT NOT NULL,
  score INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  tricks INTEGER NOT NULL,
  unique_tricks INTEGER NOT NULL,
  best_combo INTEGER NOT NULL,
  best_trick INTEGER NOT NULL,
  crashes INTEGER NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  posted_utc TIMESTAMPTZ NOT NULL
);

-- The ordering rule, in SQL. It has to agree with byScore in src/store.js:
-- highest score, then the earlier post, so a pilot who ties does not take
-- the place off the pilot who got there first.
CREATE INDEX IF NOT EXISTS runs_map_score
  ON runs (map, score DESC, posted_utc);

CREATE UNIQUE INDEX IF NOT EXISTS runs_public_id
  ON runs (public_id);

-- One row per pilot per map, which is what makes the replace-if-better
-- write safe to do as an upsert. lower(name) so a pilot who capitalises
-- differently on Tuesday does not get a second row.
CREATE UNIQUE INDEX IF NOT EXISTS runs_pilot_map
  ON runs (map, lower(name));
