/*
 * store.js: published tracks and their times.
 *
 * Postgres when DATABASE_URL is set, a JSON file when it is not. The two
 * backends answer the same methods so the rest of the server never asks
 * which one is live. Local development needs no Docker. Render needs
 * nothing except the URL it already hands a web service.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVLeaderboard is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with WebFPVLeaderboard. If not, see <https://www.gnu.org/licenses/>.
 */

import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { hashEditKey, planFromDocument } from './validate.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function nowIso() {
  return new Date().toISOString();
}

function newBugId() {
  return `bug-${randomBytes(4).toString('hex')}`;
}

/* The handle a time is addressed by over the API. Minted here, like a bug
 * id, because the file store has no serial and the Postgres serial is a
 * storage detail nothing outside this file should learn. */
function newTimeId() {
  return `tm-${randomBytes(4).toString('hex')}`;
}

/*
 * A time row as the API shows it in a list: the ghost blob itself never
 * travels with a track, only the fact that one exists, or a track with
 * forty recorded laps would weigh megabytes on every open of its sheet.
 * Rows from before ghosts have no public id; they read as unfetchable,
 * which they are.
 */
function summaryTime(row) {
  return {
    id: row.id || null,
    name: row.name,
    lapMs: row.lapMs,
    postedUtc: row.postedUtc,
    hasGhost: Boolean(row.ghost),
  };
}

function bugLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return 80;
  }
  return Math.min(Math.floor(n), 200);
}

function summaryBug(row) {
  const context = row.context && typeof row.context === 'object' ? row.context : {};
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    title: row.title,
    reporter: row.reporter,
    map: context.map ? String(context.map) : '',
    submittedUtc: row.submittedUtc,
    updatedUtc: row.updatedUtc,
  };
}

function fullBug(row) {
  return {
    ...summaryBug(row),
    what: row.what,
    expected: row.expected || '',
    steps: row.steps || '',
    context: row.context && typeof row.context === 'object' ? row.context : {},
    resolution: row.resolution || '',
  };
}

function listBugRows(rows, { status, kind, limit } = {}) {
  let list = rows.slice();
  if (status) {
    list = list.filter((row) => row.status === status);
  }
  if (kind) {
    list = list.filter((row) => row.kind === kind);
  }
  list.sort((a, b) => String(b.submittedUtc).localeCompare(String(a.submittedUtc)));
  return list.slice(0, bugLimit(limit)).map(summaryBug);
}

async function writeAtomic(path, contents) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(path).catch(() => {});
    await rename(tmp, path);
  }
}

function livePlan(track) {
  /* Rebuilt from the document on every list, so a drawing fix does not
   * wait for every track to be republished. */
  if (track && track.document) {
    return planFromDocument(track.document);
  }
  return track && track.plan ? track.plan : { width: 60, depth: 40, marks: [], path: [] };
}

/*
 * Fastest first, and the earliest post wins a tie. Written out three times
 * in this file, and its SQL twins are the ORDER BY in PgStore.getTrack and
 * the comparison in addTime's rank: all five have to agree or a lap is
 * ranked one way in the list and another in the confirmation.
 */
function byLap(a, b) {
  return a.lapMs - b.lapMs || String(a.postedUtc).localeCompare(String(b.postedUtc));
}

/* One 409, so the three publish paths cannot word it three ways. */
const CONFLICT = {
  error: 'This track is already on the board. Publish a copy under a new name, or update it from the browser that first sent it.',
  status: 409,
  conflict: true,
};

function summaryOf(track, times) {
  const ranked = [...times].sort(byLap);
  const best = ranked[0] || null;
  return {
    id: track.id,
    name: track.name,
    author: track.author,
    gates: track.gates,
    elements: track.elements,
    hasLogo: track.hasLogo,
    plan: livePlan(track),
    publishedUtc: track.publishedUtc,
    updatedUtc: track.updatedUtc,
    times: ranked.length,
    best: best ? { name: best.name, lapMs: best.lapMs } : null,
    /* Every track published before tags existed has none, and an absent
     * list must read as an empty one rather than as undefined: the page
     * filters on it and a card prints it. */
    tags: Array.isArray(track.tags) ? track.tags : [],
  };
}

/*
 * Highest score first, and the earliest post wins a tie, so a pilot who
 * matches a score does not take the place off the pilot who got there
 * first. Its SQL twins are the ORDER BY in PgStore.listRuns and the index
 * runs_map_score in schema.sql, and like byLap's five copies they all have
 * to agree or a run is ranked one way in the list and another in the
 * confirmation the pilot is shown.
 */
function byScore(a, b) {
  return b.score - a.score || String(a.postedUtc).localeCompare(String(b.postedUtc));
}

/* The handle a run is addressed by. Minted here for the same reason a time
 * id is: the file store has no serial. */
function newRunId() {
  return `run-${randomBytes(4).toString('hex')}`;
}

/* A run row as the API shows it. Every field the arcade board prints, and
 * nothing else. */
function summaryRun(row) {
  return {
    id: row.id || null,
    name: row.name,
    map: row.map,
    style: row.style,
    score: row.score,
    durationMs: row.durationMs,
    tricks: row.tricks,
    unique: row.unique,
    bestCombo: row.bestCombo,
    bestTrick: row.bestTrick,
    crashes: row.crashes,
    signature: row.signature || '',
    postedUtc: row.postedUtc,
  };
}

/* ------------------------------------------------------------------ */
/* JSON file                                                           */
/* ------------------------------------------------------------------ */

function emptyFile() {
  return {
    tracks: {}, times: {}, bugs: {}, runs: [],
  };
}

class FileStore {
  constructor(path) {
    this.path = path;
    this.data = emptyFile();
    this.mutex = Promise.resolve();
  }

  lock(fn) {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.then(() => undefined, () => undefined);
    return run;
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed.tracks || !parsed.times) {
        console.error('board.json is missing tracks or times; starting empty in memory and leaving the file alone.');
        this.data = emptyFile();
        return;
      }
      this.data = parsed;
      if (!this.data.bugs || typeof this.data.bugs !== 'object' || Array.isArray(this.data.bugs)) {
        this.data.bugs = {};
      }
      /* Repaired in place, NOT added to the guard above. A board.json
       * written before freestyle runs existed is not corrupt, it is old,
       * and treating it as corrupt would blank every developer's local
       * board on the next start. Same rule bugs got. */
      if (!Array.isArray(this.data.runs)) {
        this.data.runs = [];
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.data = emptyFile();
        await this.flush();
        return;
      }
      console.error('board.json could not be read; starting empty in memory and leaving the file alone.', e);
      this.data = emptyFile();
    }
  }

  async flush() {
    await writeAtomic(this.path, JSON.stringify(this.data));
  }

  async listTracks() {
    return Object.values(this.data.tracks)
      .map((track) => summaryOf(track, this.data.times[track.id] || []))
      .sort((a, b) => String(b.updatedUtc).localeCompare(String(a.updatedUtc)));
  }

  async getTrack(id) {
    const track = this.data.tracks[id];
    if (!track) {
      return null;
    }
    const times = [...(this.data.times[id] || [])]
      .sort(byLap);
    return { ...summaryOf(track, times), times: times.map(summaryTime) };
  }

  async getDocument(id) {
    const track = this.data.tracks[id];
    if (!track) {
      return null;
    }
    return {
      id: track.id,
      name: track.name,
      author: track.author,
      document: track.document,
    };
  }

  async publish({ inspected, author, editKey, tags }) {
    return this.lock(() => this.publishUnlocked({ inspected, author, editKey, tags }));
  }

  async publishUnlocked({ inspected, author, editKey, tags = [] }) {
    const existing = this.data.tracks[inspected.id];
    let key = editKey;
    let timesCleared = false;
    if (existing) {
      if (!editKey || hashEditKey(editKey) !== existing.editKeyHash) {
        return { ...CONFLICT };
      }
      if (existing.layoutHash !== inspected.layoutHash) {
        this.data.times[inspected.id] = [];
        timesCleared = true;
      } else if (existing.author !== author) {
        const times = this.data.times[inspected.id] || [];
        for (const row of times) {
          if (row.name === existing.author) {
            row.name = author;
          }
        }
      }
    } else {
      key = randomBytes(16).toString('hex');
    }
    const publishedUtc = existing ? existing.publishedUtc : nowIso();
    this.data.tracks[inspected.id] = {
      id: inspected.id,
      name: inspected.name,
      author,
      document: inspected.document,
      plan: inspected.plan,
      layoutHash: inspected.layoutHash,
      editKeyHash: hashEditKey(key),
      hasLogo: inspected.hasLogo,
      gates: inspected.gates,
      elements: inspected.elements,
      tags,
      publishedUtc,
      updatedUtc: nowIso(),
    };
    if (!this.data.times[inspected.id]) {
      this.data.times[inspected.id] = [];
    }
    await this.flush();
    return {
      id: inspected.id,
      name: inspected.name,
      author,
      editKey: existing ? undefined : key,
      updated: Boolean(existing),
      timesCleared,
    };
  }

  async addTime({ trackId, name, lapMs, ghost }) {
    return this.lock(() => this.addTimeUnlocked({ trackId, name, lapMs, ghost }));
  }

  hasTimeId(id) {
    for (const list of Object.values(this.data.times)) {
      if (list.some((row) => row.id === id)) {
        return true;
      }
    }
    return false;
  }

  async addTimeUnlocked({ trackId, name, lapMs, ghost }) {
    const track = this.data.tracks[trackId];
    if (!track) {
      return { error: 'That track is not on the board.', status: 404 };
    }
    let id = newTimeId();
    while (this.hasTimeId(id)) {
      id = newTimeId();
    }
    const row = { id, name, lapMs, ghost: ghost || null, postedUtc: nowIso() };
    const list = this.data.times[trackId] || [];
    list.push(row);
    this.data.times[trackId] = list;
    await this.flush();
    const ranked = [...list].sort(byLap);
    const rank = ranked.findIndex((t) => t === row) + 1;
    return { id, name, lapMs, postedUtc: row.postedUtc, rank, times: ranked.length };
  }

  async getGhost(trackId, timeId) {
    const list = this.data.times[trackId] || [];
    const row = list.find((t) => t.id === timeId);
    if (!row) {
      return null;
    }
    return { id: row.id, name: row.name, lapMs: row.lapMs, ghost: row.ghost || null };
  }

  async listRuns({ map } = {}) {
    const rows = (this.data.runs || []).filter((r) => !map || r.map === map);
    return rows.sort(byScore).map(summaryRun);
  }

  async addRun(run) {
    return this.lock(() => this.addRunUnlocked(run));
  }

  /*
   * ONE ROW PER PILOT PER MAP, replaced only by a better run.
   *
   * A leaderboard is a list of who is good, not a log of who pressed the
   * button. Keeping every run would let one pilot own the whole visible
   * table by flying twenty mediocre ones, which is not a thing anybody does
   * on purpose and is exactly what somebody does on purpose. It also means
   * this endpoint, which is the board's first public write with no owner
   * and no edit key, cannot be used to fill the database.
   *
   * The pilot is matched case insensitively, so a name capitalised
   * differently on Tuesday does not become a second pilot. Its SQL twin is
   * the unique index runs_pilot_map.
   */
  async addRunUnlocked(run) {
    if (!Array.isArray(this.data.runs)) {
      this.data.runs = [];
    }
    const key = run.name.toLowerCase();
    const held = this.data.runs.find((r) => r.map === run.map && r.name.toLowerCase() === key);
    if (held && held.score >= run.score) {
      const ranked = [...this.data.runs].filter((r) => r.map === run.map).sort(byScore);
      return {
        ...summaryRun(held),
        rank: ranked.indexOf(held) + 1,
        runs: ranked.length,
        improved: false,
      };
    }
    let id = newRunId();
    while (this.data.runs.some((r) => r.id === id)) {
      id = newRunId();
    }
    const row = { ...run, id, postedUtc: nowIso() };
    if (held) {
      this.data.runs[this.data.runs.indexOf(held)] = row;
    } else {
      this.data.runs.push(row);
    }
    await this.flush();
    const ranked = [...this.data.runs].filter((r) => r.map === run.map).sort(byScore);
    return {
      ...summaryRun(row),
      rank: ranked.indexOf(row) + 1,
      runs: ranked.length,
      improved: true,
    };
  }

  async listBugs({ status, kind, limit } = {}) {
    return listBugRows(Object.values(this.data.bugs || {}), { status, kind, limit });
  }

  async getBug(id) {
    const row = this.data.bugs && this.data.bugs[id];
    return row ? fullBug(row) : null;
  }

  async addBug(inspected) {
    return this.lock(() => this.addBugUnlocked(inspected));
  }

  async addBugUnlocked(inspected) {
    if (!this.data.bugs) {
      this.data.bugs = {};
    }
    let id = newBugId();
    while (this.data.bugs[id]) {
      id = newBugId();
    }
    const submittedUtc = nowIso();
    const row = {
      id,
      status: 'open',
      kind: inspected.kind,
      title: inspected.title,
      what: inspected.what,
      expected: inspected.expected,
      steps: inspected.steps,
      reporter: inspected.reporter,
      context: inspected.context || {},
      resolution: '',
      submittedUtc,
      updatedUtc: submittedUtc,
    };
    this.data.bugs[id] = row;
    await this.flush();
    return fullBug(row);
  }

  async updateBug(id, patch) {
    return this.lock(() => this.updateBugUnlocked(id, patch));
  }

  async updateBugUnlocked(id, patch) {
    const row = this.data.bugs && this.data.bugs[id];
    if (!row) {
      return { error: 'That ticket is not on the board.', status: 404 };
    }
    if (patch.status) {
      row.status = patch.status;
    }
    if (patch.resolution != null) {
      row.resolution = patch.resolution;
    }
    row.updatedUtc = nowIso();
    await this.flush();
    return fullBug(row);
  }
}

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

class PgStore {
  constructor(url) {
    this.url = url;
    this.pool = null;
  }

  async init() {
    const { default: pg } = await import('pg');
    this.pool = new pg.Pool({ connectionString: this.url, max: 4 });
    const sql = await readFile(join(root, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  async listTracks() {
    const tracks = await this.pool.query('SELECT * FROM tracks ORDER BY updated_utc DESC');
    const bests = await this.pool.query(`
      SELECT DISTINCT ON (track_id) track_id, name, lap_ms
      FROM times
      ORDER BY track_id, lap_ms ASC, posted_utc ASC
    `);
    const counts = await this.pool.query('SELECT track_id, COUNT(*)::int AS n FROM times GROUP BY track_id');
    const bestBy = new Map(bests.rows.map((r) => [r.track_id, { name: r.name, lapMs: r.lap_ms }]));
    const nBy = new Map(counts.rows.map((r) => [r.track_id, r.n]));
    return tracks.rows.map((row) => ({
      ...rowToSummary(row),
      times: nBy.get(row.id) || 0,
      best: bestBy.get(row.id) || null,
    }));
  }

  async getTrack(id) {
    const found = await this.pool.query('SELECT * FROM tracks WHERE id = $1', [id]);
    if (!found.rowCount) {
      return null;
    }
    const times = await this.pool.query(
      `SELECT public_id AS id, name, lap_ms AS "lapMs", posted_utc AS "postedUtc",
              (ghost IS NOT NULL) AS "hasGhost"
       FROM times WHERE track_id = $1 ORDER BY lap_ms ASC, posted_utc ASC`,
      [id],
    );
    /* `best` too. The file store's getTrack returns it through summaryOf
     * and the board's track sheet reads it, so leaving it out here made
     * the same track render differently depending on the backend. */
    const rows = times.rows;
    return {
      ...rowToSummary(found.rows[0]),
      times: rows,
      best: rows[0] ? { name: rows[0].name, lapMs: rows[0].lapMs } : null,
    };
  }

  async getDocument(id) {
    const found = await this.pool.query(
      'SELECT id, name, author, document FROM tracks WHERE id = $1',
      [id],
    );
    if (!found.rowCount) {
      return null;
    }
    return found.rows[0];
  }

  async publish({ inspected, author, editKey, tags = [] }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT * FROM tracks WHERE id = $1 FOR UPDATE', [inspected.id]);
      let key = editKey;
      let timesCleared = false;
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (!editKey || hashEditKey(editKey) !== row.edit_key_hash) {
          await client.query('ROLLBACK');
          return { ...CONFLICT };
        }
        if (row.layout_hash !== inspected.layoutHash) {
          await client.query('DELETE FROM times WHERE track_id = $1', [inspected.id]);
          timesCleared = true;
        } else if (row.author !== author) {
          await client.query(
            'UPDATE times SET name = $2 WHERE track_id = $1 AND name = $3',
            [inspected.id, author, row.author],
          );
        }
        await client.query(
          `UPDATE tracks SET
            name = $2, author = $3, document = $4, plan = $5, layout_hash = $6,
            has_logo = $7, gates = $8, elements = $9, tags = $10, updated_utc = NOW()
           WHERE id = $1`,
          [
            inspected.id, inspected.name, author, inspected.document, inspected.plan,
            inspected.layoutHash, inspected.hasLogo, inspected.gates, inspected.elements,
            tags,
          ],
        );
      } else {
        key = randomBytes(16).toString('hex');
        await client.query(
          `INSERT INTO tracks (
            id, name, author, document, plan, layout_hash, edit_key_hash,
            has_logo, gates, elements, tags, published_utc, updated_utc
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())`,
          [
            inspected.id, inspected.name, author, inspected.document, inspected.plan,
            inspected.layoutHash, hashEditKey(key), inspected.hasLogo, inspected.gates,
            inspected.elements, tags,
          ],
        );
      }
      await client.query('COMMIT');
      return {
        id: inspected.id,
        name: inspected.name,
        author,
        editKey: existing.rowCount ? undefined : key,
        updated: Boolean(existing.rowCount),
        timesCleared,
      };
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (ignored) {
        /* Connection may already be dead. */
      }
      if (e.code === '23505') {
        return { ...CONFLICT };
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async addTime({ trackId, name, lapMs, ghost }) {
    /* The public id is random, so an insert can collide with an existing
     * row's unique index. The whole transaction retries on a fresh id, the
     * same shape as addBug's loop; six failures in a row is not luck, it is
     * a broken random source, and deserves the throw. */
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await this.addTimeOnce({ trackId, name, lapMs, ghost });
      if (result !== null) {
        return result;
      }
    }
    throw new Error('Could not allocate a time id.');
  }

  async addTimeOnce({ trackId, name, lapMs, ghost }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT id FROM tracks WHERE id = $1 FOR UPDATE', [trackId]);
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return { error: 'That track is not on the board.', status: 404 };
      }
      const inserted = await client.query(
        `INSERT INTO times (track_id, public_id, name, lap_ms, ghost, posted_utc)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, public_id AS "publicId", name, lap_ms AS "lapMs", posted_utc AS "postedUtc"`,
        [trackId, newTimeId(), name, lapMs, ghost || null],
      );
      /*
       * Ranked against the stored row, by its id, and entirely inside
       * Postgres. The old form sent the returned timestamp back as a
       * parameter to compare against itself, and posted_utc is a TIMESTAMPTZ
       * with microseconds while a JS Date carries milliseconds. The value
       * that came back had been truncated, so `posted_utc <= $3` was false
       * for the row just written and the count missed itself: the fastest
       * lap on the board reported rank 0. Comparing by id never leaves the
       * database and cannot lose precision.
       */
      const rankRow = await client.query(
        `WITH mine AS (SELECT lap_ms, posted_utc FROM times WHERE id = $2)
         SELECT COUNT(*)::int AS n FROM times, mine
         WHERE times.track_id = $1
           AND (times.lap_ms < mine.lap_ms
                OR (times.lap_ms = mine.lap_ms AND times.posted_utc <= mine.posted_utc))`,
        [trackId, inserted.rows[0].id],
      );
      const count = await client.query('SELECT COUNT(*)::int AS n FROM times WHERE track_id = $1', [trackId]);
      await client.query('COMMIT');
      return {
        id: inserted.rows[0].publicId,
        name,
        lapMs,
        postedUtc: inserted.rows[0].postedUtc,
        rank: rankRow.rows[0].n,
        times: count.rows[0].n,
      };
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (ignored) {
        /* Connection may already be dead. */
      }
      if (e.code === '23505') {
        /* The random public id landed on an existing one; the caller's
         * loop rolls a new one. */
        return null;
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async getGhost(trackId, timeId) {
    const found = await this.pool.query(
      `SELECT public_id AS id, name, lap_ms AS "lapMs", ghost
       FROM times WHERE track_id = $1 AND public_id = $2`,
      [trackId, timeId],
    );
    return found.rowCount ? found.rows[0] : null;
  }

  async listRuns({ map } = {}) {
    const found = await this.pool.query(
      `SELECT * FROM runs
       WHERE ($1::text IS NULL OR map = $1)
       ORDER BY score DESC, posted_utc ASC`,
      [map || null],
    );
    return found.rows.map(runRowToSummary);
  }

  /*
   * One row per pilot per map, replaced only by a better run. The reasoning
   * is on FileStore.addRunUnlocked; this is the same rule written in SQL.
   *
   * The upsert is on the unique index runs_pilot_map, and the WHERE on the
   * DO UPDATE is what makes it replace-if-better rather than
   * replace-always: a worse run touches nothing and the RETURNING comes
   * back empty, which the read below turns into the pilot's standing row.
   *
   * The public id is random and can collide, so the whole thing retries the
   * way addTime does. Six attempts against a four byte id is not a real
   * risk, it is the same belt this file already wears.
   */
  async addRun(run) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await this.addRunOnce(run);
      } catch (e) {
        if (e.code !== '23505' || String(e.constraint || '') !== 'runs_public_id') {
          throw e;
        }
      }
    }
    throw new Error('Could not allocate a run id.');
  }

  async addRunOnce(run) {
    const id = newRunId();
    const written = await this.pool.query(
      `INSERT INTO runs (
        public_id, name, map, style, score, duration_ms, tricks, unique_tricks,
        best_combo, best_trick, crashes, signature, posted_utc
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (map, lower(name)) DO UPDATE SET
        public_id = EXCLUDED.public_id,
        name = EXCLUDED.name,
        style = EXCLUDED.style,
        score = EXCLUDED.score,
        duration_ms = EXCLUDED.duration_ms,
        tricks = EXCLUDED.tricks,
        unique_tricks = EXCLUDED.unique_tricks,
        best_combo = EXCLUDED.best_combo,
        best_trick = EXCLUDED.best_trick,
        crashes = EXCLUDED.crashes,
        signature = EXCLUDED.signature,
        posted_utc = EXCLUDED.posted_utc
      WHERE runs.score < EXCLUDED.score
      RETURNING *`,
      [
        id, run.name, run.map, run.style, run.score, run.durationMs, run.tricks,
        run.unique, run.bestCombo, run.bestTrick, run.crashes, run.signature,
      ],
    );
    const improved = written.rowCount > 0;
    const held = improved ? written.rows[0] : (await this.pool.query(
      'SELECT * FROM runs WHERE map = $1 AND lower(name) = lower($2)',
      [run.map, run.name],
    )).rows[0];
    /* The rank is asked for separately rather than computed in the insert,
     * because the ordering rule lives in one ORDER BY and this must not
     * become a sixth copy of it that could drift. */
    const ranked = await this.pool.query(
      `SELECT COUNT(*)::int AS ahead FROM runs
       WHERE map = $1
         AND (score > $2 OR (score = $2 AND posted_utc < $3))`,
      [run.map, held.score, held.posted_utc],
    );
    const total = await this.pool.query(
      'SELECT COUNT(*)::int AS n FROM runs WHERE map = $1', [run.map],
    );
    return {
      ...runRowToSummary(held),
      rank: ranked.rows[0].ahead + 1,
      runs: total.rows[0].n,
      improved,
    };
  }

  async listBugs({ status, kind, limit } = {}) {
    const found = await this.pool.query(
      `SELECT id, status, kind, title, reporter, context,
              submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"
       FROM bugs
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::text IS NULL OR kind = $2)
       ORDER BY submitted_utc DESC
       LIMIT $3`,
      [status || null, kind || null, bugLimit(limit)],
    );
    return found.rows.map(summaryBug);
  }

  async getBug(id) {
    const found = await this.pool.query(
      `SELECT id, status, kind, title, what, expected, steps, reporter, context,
              resolution, submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"
       FROM bugs WHERE id = $1`,
      [id],
    );
    return found.rowCount ? fullBug(found.rows[0]) : null;
  }

  async addBug(inspected) {
    for (let i = 0; i < 6; i += 1) {
      const id = newBugId();
      try {
        const inserted = await this.pool.query(
          `INSERT INTO bugs (
            id, status, kind, title, what, expected, steps, reporter, context,
            resolution, submitted_utc, updated_utc
          ) VALUES ($1,'open',$2,$3,$4,$5,$6,$7,$8,'',NOW(),NOW())
          RETURNING id, status, kind, title, what, expected, steps, reporter, context,
                    resolution, submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"`,
          [
            id, inspected.kind, inspected.title, inspected.what, inspected.expected,
            inspected.steps, inspected.reporter, inspected.context || {},
          ],
        );
        return fullBug(inserted.rows[0]);
      } catch (e) {
        if (e.code === '23505') {
          continue;
        }
        throw e;
      }
    }
    throw new Error('Could not allocate a ticket id.');
  }

  async updateBug(id, patch) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT id, status, kind, title, what, expected, steps, reporter, context,
                resolution, submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"
         FROM bugs WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return { error: 'That ticket is not on the board.', status: 404 };
      }
      const nextStatus = patch.status || found.rows[0].status;
      const nextResolution = patch.resolution != null ? patch.resolution : found.rows[0].resolution;
      const updated = await client.query(
        `UPDATE bugs SET status = $2, resolution = $3, updated_utc = NOW()
         WHERE id = $1
         RETURNING id, status, kind, title, what, expected, steps, reporter, context,
                   resolution, submitted_utc AS "submittedUtc", updated_utc AS "updatedUtc"`,
        [id, nextStatus, nextResolution],
      );
      await client.query('COMMIT');
      return fullBug(updated.rows[0]);
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (ignored) {
        /* Connection may already be dead. */
      }
      throw e;
    } finally {
      client.release();
    }
  }
}

/*
 * The Postgres row, in the shape summaryOf produces for the file store.
 * The two are one contract with two writers, so anything added to one has
 * to be added to the other: `best` was missing here for a while.
 *
 * `row.layout` used to be consulted here and there is no such column. The
 * plan is always re-derived from the document, which is why the stored
 * `plan` column is written and never read back.
 */
function rowToSummary(row) {
  return {
    id: row.id,
    name: row.name,
    author: row.author,
    gates: row.gates,
    elements: row.elements,
    hasLogo: row.has_logo,
    plan: planFromDocument(row.document),
    publishedUtc: row.published_utc,
    updatedUtc: row.updated_utc,
    /* A column added later, so a row read back from a database that has not
     * run the migration yet answers null rather than an array. Both spellings
     * of "no tags" have to become the same empty list, or the page filters
     * on undefined and a card throws. */
    tags: Array.isArray(row.tags) ? row.tags : [],
  };
}

/* The Postgres twin of summaryRun. Same rule as rowToSummary and summaryOf:
 * one contract, two writers. */
function runRowToSummary(row) {
  return {
    id: row.public_id || null,
    name: row.name,
    map: row.map,
    style: row.style,
    score: row.score,
    durationMs: row.duration_ms,
    tricks: row.tricks,
    unique: row.unique_tricks,
    bestCombo: row.best_combo,
    bestTrick: row.best_trick,
    crashes: row.crashes,
    signature: row.signature || '',
    postedUtc: row.posted_utc,
  };
}

export async function openStore() {
  const url = process.env.DATABASE_URL;
  const path = process.env.BOARD_FILE || join(root, 'data', 'board.json');
  const store = url ? new PgStore(url) : new FileStore(path);
  await store.init();
  store.kind = url ? 'postgres' : 'file';
  return store;
}
