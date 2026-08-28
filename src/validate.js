/*
 * validate.js: names, times, and the track document this board will store.
 *
 * The document is the same schema.md object the simulator's track builder
 * writes. This file does not import that code. It checks the few things
 * the board must believe before it will keep a copy: a version it knows,
 * a stable id, a flying order, and a logo that is an embedded image or
 * nothing. The simulator is the reader that decides what a gate means.
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

import { createHash } from 'node:crypto';

/* MIRRORS NAME_RE in WebFPVSimulator/src/share/pilot.js. This copy is the
 * one that decides; the simulator's is a prediction of it so a pilot is told
 * before they upload. Two repos, so change both. */
export const NAME_RE = /^[A-Za-z0-9._\- ]{2,24}$/;
export const TRACK_ID_RE = /^trk-[0-9a-f]{8}$/;
export const TIME_ID_RE = /^tm-[0-9a-f]{8}$/;
/*
 * 560_000, up from 420_000, and the number is derived rather than picked.
 * A track carries up to five sponsors' logos now instead of one, sharing a
 * 384 kB budget (BRANDING_MAX_CHARS in the simulator's
 * src/trackbuilder/model.js). The old cap was one 256 kB logo plus about
 * 158 kB of headroom for the track itself; this is the new branding budget
 * plus the same headroom, so exactly as much room is left for gates as
 * before. See also the publish body limit in server.js, which has to be
 * above this or a track that fits is refused before it is read.
 */
const MAX_DOCUMENT_CHARS = 560_000;
const MAX_LAP_MS = 3_600_000;

export function normaliseName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  return NAME_RE.test(name) ? name : null;
}

export function normaliseLapMs(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1 || raw > MAX_LAP_MS) {
    return null;
  }
  return Math.round(raw);
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Ghost laps                                                          */
/* ------------------------------------------------------------------ */

/*
 * MIRRORS the wire format in WebFPVSimulator/src/share/ghostdata.js, the
 * same arrangement as NAME_RE above: the simulator's module is the copy of
 * record and encodes; this is the board's own reading of the header so it
 * never stores a blob the simulator could not replay. Two repos, so a
 * format change lands in both.
 *
 * The caps are the simulator's: 30 Hz grid, ten minutes of lap, 20 bytes a
 * sample. The largest legitimate blob is therefore ~360 KB of bytes, which
 * is ~480 KB of base64; the character cap sits just above that and well
 * under the route's body limit.
 */
const GHOST_MAGIC = 'FPVGHST1';
const GHOST_VERSION = 1;
const GHOST_HEADER_BYTES = 32;
const GHOST_SAMPLE_BYTES = 20;
const GHOST_MAX_MS = 600_000;
const GHOST_MAX_SPLITS = 256;
export const GHOST_MAX_CHARS = 500_000;
/* How far the blob's own duration may sit from the lap time it was posted
 * with. The simulator writes the same rounded number to both, so anything
 * past rounding slack is a blob for a different lap. */
const GHOST_LAP_SLACK_MS = 250;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/*
 * A posted ghost, judged: { ghost } with the base64 exactly as it will be
 * stored, or { error } with the reason. lapMs is the already-normalised
 * lap the ghost arrived beside.
 */
export function inspectGhost(raw, lapMs) {
  if (raw == null || raw === '') {
    return { ghost: null };
  }
  if (typeof raw !== 'string') {
    return { error: 'A ghost has to be a base64 string.' };
  }
  if (raw.length > GHOST_MAX_CHARS) {
    return { error: 'That ghost recording is too large.' };
  }
  if (raw.length < 44 || raw.length % 4 !== 0 || !BASE64_RE.test(raw)) {
    return { error: 'That ghost recording is not usable base64.' };
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length < GHOST_HEADER_BYTES) {
    return { error: 'That ghost recording is shorter than its header.' };
  }
  if (bytes.toString('latin1', 0, 8) !== GHOST_MAGIC) {
    return { error: 'That ghost recording is not in the ghost format.' };
  }
  if (bytes.readUInt32LE(8) !== GHOST_VERSION) {
    return { error: 'That ghost recording is from an unknown format version.' };
  }
  const rateHz = bytes.readUInt32LE(12);
  const count = bytes.readUInt32LE(16);
  const durationMs = bytes.readUInt32LE(20);
  const splitCount = bytes.readUInt32LE(24);
  if (rateHz < 1 || rateHz > 240) {
    return { error: 'That ghost recording claims an unusable sample rate.' };
  }
  if (count < 2) {
    return { error: 'That ghost recording is too short to replay.' };
  }
  if (durationMs < 1 || durationMs > GHOST_MAX_MS) {
    return { error: 'That ghost recording claims an unusable duration.' };
  }
  if (splitCount > GHOST_MAX_SPLITS) {
    return { error: 'That ghost recording claims too many splits.' };
  }
  const want = GHOST_HEADER_BYTES + splitCount * 4 + count * GHOST_SAMPLE_BYTES;
  if (bytes.length !== want) {
    return { error: 'That ghost recording does not match its own header.' };
  }
  /* The grid has to reach the finish, or replay near the line reads air. */
  const stepMs = 1000 / rateHz;
  if (((count - 1) * 1000) / rateHz + stepMs < durationMs) {
    return { error: 'That ghost recording ends before its lap does.' };
  }
  if (lapMs != null && Math.abs(durationMs - lapMs) > GHOST_LAP_SLACK_MS) {
    return { error: 'That ghost recording does not match the lap time beside it.' };
  }
  return { ghost: raw };
}

const LOGO_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/* The three caps on a track's branding, all of them the simulator's, from
 * LOGO_MAX_CHARS, LOGO_SLOTS and BRANDING_MAX_CHARS in its
 * src/trackbuilder/model.js. They live there because that is where an author
 * actually hits them; these copies exist so the board never holds a track
 * the tool that made it would not save. An earlier copy of the first one was
 * 280_000 rather than 256 KiB, and a logo between the two sizes was refused
 * by the builder and accepted here. Change all three together. */
const LOGO_MAX_CHARS = 256 * 1024;
const LOGO_SLOTS = 5;
const BRANDING_MAX_CHARS = 384 * 1024;

function usableLogo(value) {
  return typeof value === 'string' && value.length <= LOGO_MAX_CHARS && LOGO_RE.test(value);
}

/*
 * The sponsor logos a track carries, whichever way its document spells
 * them. Not to be confused with the plan's `marks`, which are the track's
 * own geometry: the builder calls the pictures sponsor logos and so does
 * every sentence the board shows an author.
 *
 * A schemaVersion 1 document has one `branding.logo`; a version 2 one has
 * `branding.logos`, a list of up to five { id, image, name }. Both are read,
 * because the board holds tracks published under the old spelling and they
 * have to keep working when their author republishes an unchanged copy.
 *
 * Returns { images } or { error }. The board does not repair a document: it
 * stores what it was given and the simulator is the reader that decides what
 * a gate means, so anything wrong here is refused with a sentence rather
 * than quietly dropped.
 */
function inspectBranding(document) {
  const branding = document.branding;
  if (branding == null) {
    return { images: [] };
  }
  if (!isObject(branding)) {
    return { error: 'That track\u2019s branding is not readable.' };
  }
  const raw = Array.isArray(branding.logos)
    ? branding.logos
    : (branding.logo != null && branding.logo !== '' ? [{ image: branding.logo }] : []);
  if (raw.length > LOGO_SLOTS) {
    return { error: `A track carries at most ${LOGO_SLOTS} sponsor logos.` };
  }
  const images = [];
  let spent = 0;
  for (const entry of raw) {
    const image = typeof entry === 'string' ? entry : (isObject(entry) ? entry.image : null);
    if (!usableLogo(image)) {
      return { error: 'A sponsor logo has to travel inside the track as an embedded image.' };
    }
    spent += image.length;
    images.push(image);
  }
  if (spent > BRANDING_MAX_CHARS) {
    return { error: `A track\u2019s sponsor logos share ${Math.round(BRANDING_MAX_CHARS / 1024)} kB and these come to ${Math.round(spent / 1024)} kB.` };
  }
  return { images };
}

/*
 * MIRRORS layoutFingerprint in WebFPVSimulator/src/share/listing.js. This is
 * the copy that decides whether a republished track keeps its times. The
 * hashes differ, the KEY LIST must not: field, elements, sequence.
 */
/*
 * Element types that are painted on rather than flown through, so changing
 * them cannot change a lap.
 *
 * THIS IS WHY A SPONSOR DOES NOT WIPE A LEADERBOARD. Selling a place on an
 * existing track means adding a logo to a track people have already flown,
 * and if that counted as a layout change every time on this board would be
 * cleared the moment the deal was signed. Paint has no collider and is not
 * in the flying order, so a lap flown before it was painted is the same lap.
 *
 * MIRRORS LAYOUT_SKIP in WebFPVSimulator/src/share/listing.js. Written out
 * as a literal in both, rather than derived from the simulator's element
 * library, because this repository has no element library and the two lists
 * have to be edited together on purpose. A track with no painted logos
 * hashes to exactly what it hashed to before this filter existed, which is
 * what keeps every already published track's times.
 */
const LAYOUT_SKIP = new Set(['groundLogo']);

export function layoutHash(document) {
  const payload = {
    field: document.field ?? {},
    elements: (document.elements ?? []).filter((el) => !(isObject(el) && LAYOUT_SKIP.has(el.type))),
    sequence: document.sequence ?? [],
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function hashEditKey(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

/* Drawn as nothing on a plan card. A waypoint pins the flying order with
 * nothing standing on the field, a label is an authoring note, and a ground
 * logo is paint: all three drew as gates once, which is how a championship
 * plan turned into a scatter of bars that are not on the track. */
const PLAN_SKIP = new Set(['label', 'waypoint', 'groundLogo']);
const PLAN_APERTURE = new Set([
  'gate', 'flaggedGate', 'doubleStack', 'flaggedDoubleStack', 'ladder', 'tower', 'diveGate',
]);

export function planFromDocument(document) {
  const field = isObject(document.field) ? document.field : {};
  const byId = new Map();
  const sequenced = new Set();
  for (const step of document.sequence || []) {
    if (isObject(step) && typeof step.elementId === 'string' && step.elementId) {
      sequenced.add(step.elementId);
    }
  }
  const marks = [];
  for (const el of document.elements || []) {
    if (!isObject(el) || !isObject(el.position)) {
      continue;
    }
    if (typeof el.id === 'string' && el.id) {
      byId.set(el.id, el);
    }
    const type = String(el.type || 'gate');
    /* A waypoint is a flying-order pin with nothing standing on the
     * field. Drawing it as a gate was how championship plans turned into
     * a scatter of bars that are not on the track. Labels are notes. */
    if (PLAN_SKIP.has(type)) {
      continue;
    }
    /*
     * The three numbers the drawer cannot guess. It used to reconstruct
     * every size from a hard copy of the builder's type DEFAULTS, but each
     * of these is editable per element: a ladder taken to five levels drew
     * three arcs, a twenty metre barrier drew as four, and the gate count
     * printed on the same card told the truth the picture did not.
     * Undefined when the element does not carry one, so an older stored
     * plan still falls back to the defaults.
     */
    const levels = Number(el.dims?.levels);
    const barrierW = Number(el.dims?.width);
    const barrierD = Number(el.dims?.depth);
    marks.push({
      type,
      x: Number(el.position.x) || 0,
      y: Number(el.position.y) || 0,
      yaw: Number(el.yaw) || 0,
      seq: sequenced.has(el.id),
      levels: Number.isFinite(levels) && levels > 0 ? levels : undefined,
      w: Number.isFinite(barrierW) && barrierW > 0 ? barrierW : undefined,
      d: Number.isFinite(barrierD) && barrierD > 0 ? barrierD : undefined,
    });
  }
  const path = [];
  const numbers = [];
  const stacked = new Map();
  let n = 0;
  for (const step of document.sequence || []) {
    if (!isObject(step)) {
      continue;
    }
    const el = byId.get(step.elementId);
    if (!el || !isObject(el.position)) {
      continue;
    }
    const x = Number(el.position.x) || 0;
    const y = Number(el.position.y) || 0;
    const last = path[path.length - 1];
    if (!last || last.x !== x || last.y !== y) {
      path.push({ x, y });
    }
    const type = String(el.type || '');
    /*
     * One badge per FLYING ORDER ENTRY, not per element. Numbering by
     * element id gave a stacked gate flown three times a single badge and
     * left the plan's last number short of the gate count printed on the
     * same card, and short of what the simulator's own OSD counts down.
     * `stack` is how many badges already sit on this exact spot, so the
     * drawer can step them apart the way the builder does.
     */
    if (PLAN_APERTURE.has(type) && el.id) {
      const spot = `${x},${y}`;
      const stack = stacked.get(spot) || 0;
      stacked.set(spot, stack + 1);
      n += 1;
      numbers.push({ n, x, y, stack });
    }
  }
  return {
    width: Number(field.width) || 60,
    depth: Number(field.depth) || 40,
    marks,
    path,
    numbers,
  };
}

/*
 * How many GATES a track has, which is not how long its flying order is.
 * A waypoint is an order pin with nothing standing on the field, and a
 * marker only scores when it carries clearance, so counting steps put a
 * number on the card that neither the plan's badges nor the simulator's own
 * count agreed with. Mirrors the station rules in the simulator's
 * src/game/trackdoc.js.
 */
function gateCount(document) {
  const byId = new Map();
  for (const el of document.elements || []) {
    if (isObject(el) && typeof el.id === 'string' && el.id) {
      byId.set(el.id, el);
    }
  }
  let n = 0;
  for (const step of document.sequence || []) {
    if (!isObject(step)) {
      continue;
    }
    const el = byId.get(step.elementId);
    if (!el) {
      continue;
    }
    const type = String(el.type || '');
    if (PLAN_APERTURE.has(type)) {
      n += 1;
    } else if (Number(el.dims && el.dims.clearance) >= 0.05) {
      n += 1;
    }
  }
  return n;
}

export function inspectDocument(raw) {
  if (typeof raw === 'string' && raw.length > MAX_DOCUMENT_CHARS) {
    return { error: 'That track is too large to publish.' };
  }
  const packed = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (packed.length > MAX_DOCUMENT_CHARS) {
    return { error: 'That track is too large to publish.' };
  }
  let document = raw;
  if (typeof raw === 'string') {
    try {
      document = JSON.parse(raw);
    } catch (e) {
      return { error: 'That track is not valid JSON.' };
    }
  }
  if (!isObject(document)) {
    return { error: 'That file is not a track document.' };
  }
  /*
   * 1 and 2. Version 2 is where a track grew from one logo to five, which
   * is a branding change and nothing else: field, elements and sequence read
   * identically, so a version 1 track already on this board keeps its times
   * when its author republishes it from a newer builder.
   */
  if (document.schemaVersion !== 1 && document.schemaVersion !== 2) {
    return { error: 'This board accepts schemaVersion 1 and 2 tracks.' };
  }
  const id = String(document.id || '');
  if (!TRACK_ID_RE.test(id)) {
    return { error: 'That track has no usable id.' };
  }
  const name = String(document.name || '').trim() || 'Untitled track';
  /* The message named the field and then never looked at it, so a track
   * with no field at all passed here and the board drew it on the 60 by 40
   * default while the simulator flew it on whatever the document said. */
  if (!isObject(document.field)) {
    return { error: 'That track is missing its field.' };
  }
  if (!Array.isArray(document.elements) || !Array.isArray(document.sequence)) {
    return { error: 'That track is missing its elements or its flying order.' };
  }
  if (document.sequence.length < 1) {
    return { error: 'A published track needs at least one gate in the flying order.' };
  }
  const elementIds = new Set();
  for (const el of document.elements) {
    if (isObject(el) && typeof el.id === 'string' && el.id) {
      elementIds.add(el.id);
    }
  }
  for (const step of document.sequence) {
    if (!isObject(step) || !elementIds.has(step.elementId)) {
      return { error: 'That flying order names a gate that is not in the track.' };
    }
  }
  const branding = inspectBranding(document);
  if (branding.error) {
    return { error: branding.error };
  }
  return {
    document,
    id,
    name: name.slice(0, 80),
    /* Whether the board's listing shows this track as branded. One logo or
     * five, the card says the same thing, so the flag stays a boolean. */
    hasLogo: branding.images.length > 0,
    logoCount: branding.images.length,
    gates: gateCount(document),
    elements: document.elements.length,
    layoutHash: layoutHash(document),
    plan: planFromDocument(document),
  };
}

/* ------------------------------------------------------------------ */
/* Bug tickets                                                         */
/* ------------------------------------------------------------------ */

export const BUG_ID_RE = /^bug-[0-9a-f]{8}$/;
export const BUG_KINDS = ['crash', 'blocking', 'wrong', 'visual', 'feel', 'other'];
export const BUG_STATUSES = ['open', 'in_progress', 'fixed', 'wontfix', 'duplicate'];

const BUG_TITLE_MIN = 8;
const BUG_TITLE_MAX = 120;
const BUG_WHAT_MIN = 20;
const BUG_WHAT_MAX = 4000;
const BUG_NOTE_MAX = 2000;
const BUG_RESOLUTION_MAX = 4000;
const BUG_CONTEXT_CHARS = 8000;
/*
 * 32, up from 24. The simulator's feel reports already attach twenty top
 * level keys (feelSnapshot in its src/ui/ui.js spreads bugSnapshot and adds
 * five of its own), so 24 left four keys of headroom before feedback
 * started bouncing with "too many fields", and the client has no check of
 * its own. The character cap above is still the real bound on size; this
 * one only exists to stop a pathological object of thousands of tiny keys.
 */
const BUG_CONTEXT_KEYS = 32;

function inspectContext(raw) {
  if (raw == null || raw === '') {
    return { context: {} };
  }
  if (!isObject(raw)) {
    return { error: 'Context has to be a JSON object.' };
  }
  let packed;
  try {
    packed = JSON.stringify(raw);
  } catch (e) {
    return { error: 'Context is not usable JSON.' };
  }
  if (packed.length > BUG_CONTEXT_CHARS) {
    return { error: 'That context is too large.' };
  }
  if (Object.keys(raw).length > BUG_CONTEXT_KEYS) {
    return { error: 'That context has too many fields.' };
  }
  return { context: JSON.parse(packed) };
}

/*
 * A tester's report, as the board will store it. Kind, title and what
 * happened are required. The name can be blank, in which case it is stored
 * as Anonymous. Context is whatever the simulator attached: map, GPU,
 * browser. Agents read that so they do not have to ask.
 */
export function inspectBugCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'That request was not a JSON object.' };
  }
  const kind = String(body.kind || 'other');
  if (!BUG_KINDS.includes(kind)) {
    return { error: 'Pick a kind: crash, blocking, wrong, visual, feel or other.' };
  }
  const title = String(body.title ?? '').replace(/\s+/g, ' ').trim();
  if (title.length < BUG_TITLE_MIN || title.length > BUG_TITLE_MAX) {
    return { error: 'A title needs eight to one hundred and twenty characters.' };
  }
  const what = String(body.what ?? '').replace(/\r\n/g, '\n').trim();
  if (what.length < BUG_WHAT_MIN || what.length > BUG_WHAT_MAX) {
    return { error: 'Say what happened, twenty to four thousand characters.' };
  }
  const expected = String(body.expected ?? '').replace(/\r\n/g, '\n').trim();
  if (expected.length > BUG_NOTE_MAX) {
    return { error: 'Expected result is too long.' };
  }
  const steps = String(body.steps ?? '').replace(/\r\n/g, '\n').trim();
  if (steps.length > BUG_NOTE_MAX) {
    return { error: 'Steps are too long.' };
  }
  const named = normaliseName(body.reporter);
  const rawName = String(body.reporter ?? '').trim();
  if (rawName && !named) {
    return { error: 'A name is two to twenty four letters, numbers, spaces, dots, underscores or hyphens, or leave it blank.' };
  }
  const ctx = inspectContext(body.context);
  if (ctx.error) {
    return ctx;
  }
  return {
    kind,
    title,
    what,
    expected,
    steps,
    reporter: named || 'Anonymous',
    context: ctx.context,
  };
}

export function inspectBugPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'That request was not a JSON object.' };
  }
  const out = {};
  if (body.status != null) {
    const status = String(body.status);
    if (!BUG_STATUSES.includes(status)) {
      return { error: 'Status is open, in_progress, fixed, wontfix or duplicate.' };
    }
    out.status = status;
  }
  if (body.resolution != null) {
    const resolution = String(body.resolution).replace(/\r\n/g, '\n').trim();
    if (resolution.length > BUG_RESOLUTION_MAX) {
      return { error: 'That resolution is too long.' };
    }
    out.resolution = resolution;
  }
  if (out.status == null && out.resolution == null) {
    return { error: 'Send a status or a resolution.' };
  }
  return out;
}
