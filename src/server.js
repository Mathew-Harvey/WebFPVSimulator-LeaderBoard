/*
 * server.js: the public board.
 *
 * A static page and a small JSON API. The page lists every published
 * track. Expanding one shows its times. Fly opens the simulator in
 * another tab with ?share=id, which is the only link the two sites
 * need. Publish and post-time are the writes. Testers also POST bug
 * tickets here; agents GET them.
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

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openStore } from './store.js';
import {
  inspectBugCreate, inspectBugPatch, inspectDocument, inspectGhost, inspectRun, inspectTags,
  normaliseLapMs, normaliseName,
  BUG_ID_RE, BUG_KINDS, BUG_STATUSES, RUN_MAPS, TAGS, TIME_ID_RE, TRACK_ID_RE,
} from './validate.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 3100);
const simOrigin = (process.env.SIM_ORIGIN || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const boardPublic = (process.env.BOARD_PUBLIC_ORIGIN || '').replace(/\/+$/, '');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  /* The credits roll's pilot faces are photographs, so they are JPEG.
     Without a row here they go out as application/octet-stream and the
     one page that shows a person's face shows four broken images. */
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
]);

const store = await openStore();
const bugsToken = String(process.env.BUGS_TOKEN || '');
const bugHits = new Map();

/*
 * The board is public and every response is credential free: there is no
 * cookie, no Authorization header and no session. Reflecting the request
 * origin is therefore the same grant as '*', and it is written this way so
 * that adding credentials later fails closed rather than silently sharing
 * them with whoever asked.
 */
function cors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('vary', 'origin');
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function requestOrigin(req) {
  if (boardPublic) {
    return boardPublic;
  }
  const trust = process.env.BOARD_TRUST_PROXY === '1';
  const rawHost = (trust && req.headers['x-forwarded-host']) || req.headers.host || `127.0.0.1:${port}`;
  const host = String(rawHost).split(',')[0].trim();
  if (!/^[A-Za-z0-9.[\]:_-]+$/.test(host)) {
    return `http://127.0.0.1:${port}`;
  }
  const proto = (trust && req.headers['x-forwarded-proto'])
    ? String(req.headers['x-forwarded-proto']).split(',')[0].trim()
    : 'http';
  const scheme = proto === 'https' ? 'https' : 'http';
  return `${scheme}://${host}`;
}

function decodePathPart(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    return null;
  }
}

/*
 * A track id out of the path, or null. The shape check is not decoration.
 * The file store keeps its tracks in a plain object, so an id of
 * 'constructor' or '__proto__' used to find something on Object.prototype:
 * the lookup came back truthy and the request went on to read a track out
 * of a function, which is a 500 rather than the 404 it should be. Every id
 * the board holds passed this same expression through inspectDocument at
 * publish time, so nothing real can fail it.
 */
function trackIdFrom(raw) {
  const id = decodePathPart(raw);
  return id && TRACK_ID_RE.test(id) ? id : null;
}

function bugIdFrom(raw) {
  const id = decodePathPart(raw);
  return id && BUG_ID_RE.test(id) ? id : null;
}

function timeIdFrom(raw) {
  const id = decodePathPart(raw);
  return id && TIME_ID_RE.test(id) ? id : null;
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function bugsAuthorized(req, url) {
  if (!bugsToken) {
    return true;
  }
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const query = url.searchParams.get('token') || '';
  return sameSecret(bearer, bugsToken) || sameSecret(query, bugsToken);
}

function clientIp(req) {
  if (process.env.BOARD_TRUST_PROXY === '1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) {
      return forwarded.slice(0, 80);
    }
  }
  return req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : 'unknown';
}

/*
 * The flood gate, in two halves so a REJECTED post does not spend the
 * allowance: the check runs before the body is read, the record only after
 * validation passes. In one piece, eight malformed attempts (an over-long
 * title, say) locked a tester out for ten minutes without a single ticket
 * landing. Spam of invalid posts stays free, and stays harmless: it stores
 * nothing.
 *
 * `who` is the client address with the route folded into it, so a tester
 * filing bugs and a pilot posting scores do not spend each other's
 * allowance. It was written for bugs and the freestyle board is the second
 * caller: a public write with no owner and no edit key, which is the same
 * shape of exposure and wants the same gate.
 *
 * It is process local, so on a host that runs two instances or spins one
 * down it is a speed bump rather than a guarantee. What does the real work
 * on the freestyle board is that a pilot holds ONE row per map: see
 * addRunUnlocked in src/store.js.
 */
function bugFlooded(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  /* The map used to keep every IP that ever posted, forever; a stale entry
   * was only dropped when that same IP came back. Sweep the whole map once
   * it grows, which on this board's traffic is almost never. */
  if (bugHits.size > 256) {
    for (const [who, times] of bugHits) {
      if (!times.some((t) => now - t < windowMs)) {
        bugHits.delete(who);
      }
    }
  }
  const hits = (bugHits.get(ip) || []).filter((t) => now - t < windowMs);
  bugHits.set(ip, hits);
  return hits.length >= 8;
}

function recordBugHit(ip) {
  const hits = bugHits.get(ip) || [];
  hits.push(Date.now());
  bugHits.set(ip, hits);
}

/*
 * 660_000, up from 500_000. The publish route is the only caller that takes
 * the default, and what it carries is a document capped at MAX_DOCUMENT_CHARS
 * in validate.js, which grew when a track went from one sponsor's logo to
 * five. This has to stay above that cap plus the envelope the document
 * travels in (author, edit key, JSON string escaping), or a track that
 * validate.js would accept is refused here before anything reads it, and
 * the message would blame its size rather than this number. The other two
 * callers pass their own, much smaller, limits.
 *
 * tooBig is the message for THIS route's payload. It used to be hardcoded
 * to the publish wording, so a tester whose bug context ran long was told
 * their track was too large to publish, from a form with no track in it.
 */
async function readBody(req, limit = 660_000, tooBig = 'That track is too large to publish.') {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      /* Pause, do not destroy. Killing the socket here meant the client saw
       * a connection reset instead of the message, so an oversized publish
       * looked like the board being down. The error path answers, and the
       * request is left for Node to tear down after the response. */
      req.pause();
      const err = new Error(tooBig);
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && path === '/api/health') {
    send(res, 200, { ok: true, store: store.kind });
    return;
  }

  if (req.method === 'GET' && path === '/api/config') {
    send(res, 200, {
      simOrigin,
      boardOrigin: requestOrigin(req),
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/tracks') {
    send(res, 200, { tracks: await store.listTracks() });
    return;
  }

  const one = path.match(/^\/api\/tracks\/([^/]+)$/);
  if (req.method === 'GET' && one) {
    const id = trackIdFrom(one[1]);
    if (!id) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    const track = await store.getTrack(id);
    if (!track) {
      send(res, 404, { error: 'That track is not on the board.' });
      return;
    }
    send(res, 200, track);
    return;
  }

  const doc = path.match(/^\/api\/tracks\/([^/]+)\/document$/);
  if (req.method === 'GET' && doc) {
    const id = trackIdFrom(doc[1]);
    if (!id) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    const payload = await store.getDocument(id);
    if (!payload) {
      send(res, 404, { error: 'That track is not on the board.' });
      return;
    }
    send(res, 200, payload);
    return;
  }

  if (req.method === 'POST' && path === '/api/tracks') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      /* An oversize body carries its own status and its own message; only
       * a JSON parse failure is this route's 400. Swallowing the status
       * here used to turn every 413 into a 400. */
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: e.message || 'That request was not JSON.' });
      return;
    }
    /* 'null', '7' and '[]' all parse. Reading .author off them threw a
     * TypeError that came back as a 500. */
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { error: 'That request was not a JSON object.' });
      return;
    }
    const author = normaliseName(body.author);
    if (!author) {
      send(res, 400, { error: 'A published track needs a name, two to twenty four letters, numbers, spaces, dots, underscores or hyphens.' });
      return;
    }
    const inspected = inspectDocument(body.document);
    if (inspected.error) {
      send(res, 400, { error: inspected.error });
      return;
    }
    /*
     * TAGS TRAVEL IN THE ENVELOPE, BESIDE THE AUTHOR, NOT INSIDE THE
     * DOCUMENT, and that is the whole reason this is a two line change
     * rather than a deploy dance.
     *
     * A tag says what the author MEANT the track for. It is not part of the
     * layout, it is not something the simulator reads to fly the track, and
     * it is not something a visitor loading a shared document needs. Putting
     * it in the document would mean a schemaVersion bump, which means
     * DEPLOY.md's rule that the board ships before the simulator, which
     * means a simulator deployed first publishes tracks this board refuses
     * with a message about a version number rather than about anything the
     * author did. It would also have to be kept out of layoutHash by hand,
     * and layoutHash getting that wrong silently clears every republished
     * track's times.
     *
     * In the envelope it is none of those things: an old builder sends no
     * tags and gets an empty list, a new builder sends tags to an old board
     * and they are ignored, and nobody's lap times move.
     */
    const tagged = inspectTags(body.tags);
    if (tagged.error) {
      send(res, 400, { error: tagged.error });
      return;
    }
    const result = await store.publish({
      inspected,
      author,
      editKey: typeof body.editKey === 'string' ? body.editKey : '',
      tags: tagged.tags,
    });
    if (result.error) {
      send(res, result.status || 400, { error: result.error, conflict: Boolean(result.conflict) });
      return;
    }
    send(res, result.updated ? 200 : 201, result);
    return;
  }

  const times = path.match(/^\/api\/tracks\/([^/]+)\/times$/);
  if (req.method === 'POST' && times) {
    let body;
    try {
      body = JSON.parse(await readBody(req, 660_000, 'That time is too large to post.'));
    } catch (e) {
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: e.message || 'That request was not JSON.' });
      return;
    }
    /* 'null', '7' and '[]' all parse. Reading .author off them threw a
     * TypeError that came back as a 500. */
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { error: 'That request was not a JSON object.' });
      return;
    }
    const name = normaliseName(body.name);
    const lapMs = normaliseLapMs(body.lapMs);
    if (!name) {
      send(res, 400, { error: 'A time on the board needs a name, two to twenty four letters, numbers, spaces, dots, underscores or hyphens.' });
      return;
    }
    if (lapMs == null) {
      send(res, 400, { error: 'That lap time is not usable.' });
      return;
    }
    /* The ghost is optional and refused loudly when malformed rather than
     * silently dropped: the simulator proves its own encoding before it
     * sends, so a bad blob here is a bug someone needs to hear about. */
    const ghost = inspectGhost(body.ghost, lapMs);
    if (ghost.error) {
      send(res, 400, { error: ghost.error });
      return;
    }
    const trackId = trackIdFrom(times[1]);
    if (!trackId) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    const result = await store.addTime({
      trackId,
      name,
      lapMs,
      ghost: ghost.ghost,
    });
    if (result.error) {
      send(res, result.status || 400, { error: result.error });
      return;
    }
    send(res, 201, result);
    return;
  }

  const ghostPath = path.match(/^\/api\/tracks\/([^/]+)\/times\/([^/]+)\/ghost$/);
  if (req.method === 'GET' && ghostPath) {
    const trackId = trackIdFrom(ghostPath[1]);
    const timeId = timeIdFrom(ghostPath[2]);
    if (!trackId || !timeId) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    const row = await store.getGhost(trackId, timeId);
    if (!row) {
      send(res, 404, { error: 'That time is not on the board.' });
      return;
    }
    if (!row.ghost) {
      send(res, 404, { error: 'That time was posted without a ghost.' });
      return;
    }
    send(res, 200, row);
    return;
  }

  /* ---------------------------------------------------------------- */
  /* The freestyle board                                                */
  /* ---------------------------------------------------------------- */

  if (req.method === 'GET' && path === '/api/runs') {
    const map = url.searchParams.get('map') || '';
    if (map && !RUN_MAPS.includes(map)) {
      send(res, 400, { error: 'That is not a map this board keeps scores for.' });
      return;
    }
    send(res, 200, { runs: await store.listRuns({ map }), tags: TAGS, maps: RUN_MAPS });
    return;
  }

  /*
   * The first public write on this board with no owner and no edit key, so
   * it carries every guard the bug route carries and one the bug route does
   * not need: a pilot holds one row per map, replaced only by a better run.
   * That, rather than the flood gate, is what stops a table being filled.
   */
  if (req.method === 'POST' && path === '/api/runs') {
    const ip = clientIp(req);
    if (bugFlooded(`run:${ip}`)) {
      send(res, 429, { error: 'Too many runs posted from here. Fly another and try again shortly.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 20_000, 'That run is too large to post.'));
    } catch (e) {
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: e.message || 'That request was not JSON.' });
      return;
    }
    const inspected = inspectRun(body);
    if (inspected.error) {
      send(res, 400, { error: inspected.error });
      return;
    }
    recordBugHit(`run:${ip}`);
    const result = await store.addRun(inspected.run);
    if (result.error) {
      send(res, result.status || 400, { error: result.error });
      return;
    }
    /*
     * 200 rather than 201 when the pilot already held a better run: nothing
     * was created, and the body says so with `improved: false` so the
     * simulator can tell a pilot they did not beat themselves rather than
     * congratulating them on a score that is not on the board.
     */
    send(res, result.improved ? 201 : 200, result);
    return;
  }

  if (req.method === 'GET' && path === '/api/bugs') {
    if (!bugsAuthorized(req, url)) {
      send(res, 401, { error: 'A token is needed to read tickets.' });
      return;
    }
    const status = url.searchParams.get('status');
    const kind = url.searchParams.get('kind');
    if (status && !BUG_STATUSES.includes(status)) {
      send(res, 400, { error: 'Status is open, in_progress, fixed, wontfix or duplicate.' });
      return;
    }
    if (kind && !BUG_KINDS.includes(kind)) {
      send(res, 400, { error: 'Kind is crash, blocking, wrong, visual, feel or other.' });
      return;
    }
    send(res, 200, { bugs: await store.listBugs({ status, kind, limit: url.searchParams.get('limit') }) });
    return;
  }

  if (req.method === 'POST' && path === '/api/bugs') {
    const ip = clientIp(req);
    if (bugFlooded(ip)) {
      send(res, 429, { error: 'Too many reports from here. Try again in a few minutes.' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 40_000, 'That report is too large.'));
    } catch (e) {
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: e.message || 'That request was not JSON.' });
      return;
    }
    const inspected = inspectBugCreate(body);
    if (inspected.error) {
      send(res, 400, { error: inspected.error });
      return;
    }
    recordBugHit(ip);
    send(res, 201, await store.addBug(inspected));
    return;
  }

  const bugOne = path.match(/^\/api\/bugs\/([^/]+)$/);
  if (bugOne && (req.method === 'GET' || req.method === 'POST')) {
    if (!bugsAuthorized(req, url)) {
      send(res, 401, { error: 'A token is needed to read or update tickets.' });
      return;
    }
    const id = bugIdFrom(bugOne[1]);
    if (!id) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    if (req.method === 'GET') {
      const ticket = await store.getBug(id);
      if (!ticket) {
        send(res, 404, { error: 'That ticket is not on the board.' });
        return;
      }
      send(res, 200, ticket);
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 20_000, 'That update is too large.'));
    } catch (e) {
      if (e && e.status) {
        throw e;
      }
      send(res, 400, { error: e.message || 'That request was not JSON.' });
      return;
    }
    const patch = inspectBugPatch(body);
    if (patch.error) {
      send(res, 400, { error: patch.error });
      return;
    }
    const result = await store.updateBug(id, patch);
    if (result.error) {
      send(res, result.status || 400, { error: result.error });
      return;
    }
    send(res, 200, result);
    return;
  }

  send(res, 404, { error: 'Nothing at that address.' });
}

async function handleStatic(req, res, url) {
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch (e) {
    send(res, 400, 'bad path', 'text/plain; charset=utf-8');
    return;
  }
  let rel = normalize(decoded).replace(/^([/\\])+/, '');
  if (rel === '' || rel === '.') {
    rel = 'index.html';
  }
  if (rel === 'bugs') {
    rel = 'bugs.html';
  }
  const root = resolve(publicDir);
  const path = resolve(root, rel);
  const inside = path === root || path.startsWith(root + sep);
  if (!inside || relative(root, path).split(sep).includes('..')) {
    send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME.get(extname(path)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      send(res, 400, { error: 'That address is not usable.' });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await handleStatic(req, res, url);
  } catch (e) {
    /* Only errors this code raised on purpose carry a status, and only
     * those have a message meant for a stranger. Everything else is a
     * stack from pg or the filesystem, and echoing it told the internet
     * about the schema and the paths. */
    if (e && e.status) {
      send(res, e.status, { error: e.message });
      return;
    }
    console.error(e);
    send(res, 500, { error: 'The board failed.' });
  }
});

if (process.env.BOARD_LISTEN !== '0') {
  server.listen(port, '0.0.0.0', () => {
    console.log(`WebFPV leaderboard: http://127.0.0.1:${port}/`);
    console.log(`Store: ${store.kind}. Simulator: ${simOrigin}`);
  });
}

export { server, store };
