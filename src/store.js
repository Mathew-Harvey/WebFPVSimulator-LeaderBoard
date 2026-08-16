/*
 * store.js: published courses and their times.
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
   * wait for every course to be republished. */
  if (track && track.document) {
    return planFromDocument(track.document);
  }
  return track && track.plan ? track.plan : { width: 60, depth: 40, marks: [], path: [] };
}

function summaryOf(track, times) {
  const ranked = [...times].sort((a, b) => a.lapMs - b.lapMs || a.postedUtc.localeCompare(b.postedUtc));
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
  };
}

/* ------------------------------------------------------------------ */
/* JSON file                                                           */
/* ------------------------------------------------------------------ */

function emptyFile() {
  return { tracks: {}, times: {} };
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
      .sort((a, b) => a.lapMs - b.lapMs || a.postedUtc.localeCompare(b.postedUtc));
    return { ...summaryOf(track, times), times };
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

  async publish({ inspected, author, editKey }) {
    return this.lock(() => this.publishUnlocked({ inspected, author, editKey }));
  }

  async publishUnlocked({ inspected, author, editKey }) {
    const existing = this.data.tracks[inspected.id];
    let key = editKey;
    let timesCleared = false;
    if (existing) {
      if (!editKey || hashEditKey(editKey) !== existing.editKeyHash) {
        return { error: 'This course is already on the board. Publish a copy under a new name, or update it from the browser that first sent it.', status: 409, conflict: true };
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

  async addTime({ trackId, name, lapMs }) {
    return this.lock(() => this.addTimeUnlocked({ trackId, name, lapMs }));
  }

  async addTimeUnlocked({ trackId, name, lapMs }) {
    const track = this.data.tracks[trackId];
    if (!track) {
      return { error: 'That course is not on the board.', status: 404 };
    }
    const row = { name, lapMs, postedUtc: nowIso() };
    const list = this.data.times[trackId] || [];
    list.push(row);
    this.data.times[trackId] = list;
    await this.flush();
    const ranked = [...list].sort((a, b) => a.lapMs - b.lapMs || a.postedUtc.localeCompare(b.postedUtc));
    const rank = ranked.findIndex((t) => t === row) + 1;
    return { name, lapMs, postedUtc: row.postedUtc, rank, times: ranked.length };
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
      'SELECT name, lap_ms AS "lapMs", posted_utc AS "postedUtc" FROM times WHERE track_id = $1 ORDER BY lap_ms ASC, posted_utc ASC',
      [id],
    );
    return { ...rowToSummary(found.rows[0]), times: times.rows };
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

  async publish({ inspected, author, editKey }) {
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
          return { error: 'This course is already on the board. Publish a copy under a new name, or update it from the browser that first sent it.', status: 409, conflict: true };
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
            has_logo = $7, gates = $8, elements = $9, updated_utc = NOW()
           WHERE id = $1`,
          [
            inspected.id, inspected.name, author, inspected.document, inspected.plan,
            inspected.layoutHash, inspected.hasLogo, inspected.gates, inspected.elements,
          ],
        );
      } else {
        key = randomBytes(16).toString('hex');
        await client.query(
          `INSERT INTO tracks (
            id, name, author, document, plan, layout_hash, edit_key_hash,
            has_logo, gates, elements, published_utc, updated_utc
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())`,
          [
            inspected.id, inspected.name, author, inspected.document, inspected.plan,
            inspected.layoutHash, hashEditKey(key), inspected.hasLogo, inspected.gates,
            inspected.elements,
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
        return { error: 'This course is already on the board. Publish a copy under a new name, or update it from the browser that first sent it.', status: 409, conflict: true };
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async addTime({ trackId, name, lapMs }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT id FROM tracks WHERE id = $1 FOR UPDATE', [trackId]);
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return { error: 'That course is not on the board.', status: 404 };
      }
      const inserted = await client.query(
        `INSERT INTO times (track_id, name, lap_ms, posted_utc)
         VALUES ($1, $2, $3, NOW())
         RETURNING name, lap_ms AS "lapMs", posted_utc AS "postedUtc"`,
        [trackId, name, lapMs],
      );
      const rankRow = await client.query(
        `SELECT COUNT(*)::int AS n FROM times
         WHERE track_id = $1 AND (lap_ms < $2 OR (lap_ms = $2 AND posted_utc <= $3))`,
        [trackId, lapMs, inserted.rows[0].postedUtc],
      );
      const count = await client.query('SELECT COUNT(*)::int AS n FROM times WHERE track_id = $1', [trackId]);
      await client.query('COMMIT');
      return {
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
      throw e;
    } finally {
      client.release();
    }
  }
}

function rowToSummary(row) {
  const layout = row.document || row.layout;
  return {
    id: row.id,
    name: row.name,
    author: row.author,
    gates: row.gates,
    elements: row.elements,
    hasLogo: row.has_logo,
    plan: layout ? planFromDocument(layout) : row.plan,
    publishedUtc: row.published_utc,
    updatedUtc: row.updated_utc,
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
