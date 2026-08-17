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
const MAX_DOCUMENT_CHARS = 420_000;
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

const LOGO_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function usableLogo(value) {
  /* 256 KiB, the same cap as LOGO_MAX_CHARS in the simulator's
   * src/trackbuilder/model.js, which is where an author actually hits it.
   * This was 280_000, so a logo between the two sizes was refused by the
   * builder and accepted here: the board would hold a course the tool that
   * made it would not save. The tighter number is the real one. */
  return typeof value === 'string' && value.length <= 256 * 1024 && LOGO_RE.test(value);
}

/*
 * MIRRORS layoutFingerprint in WebFPVSimulator/src/share/listing.js. This is
 * the copy that decides whether a republished course keeps its times. The
 * hashes differ, the KEY LIST must not: field, elements, sequence.
 */
export function layoutHash(document) {
  const payload = {
    field: document.field ?? {},
    elements: document.elements ?? [],
    sequence: document.sequence ?? [],
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function hashEditKey(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

const PLAN_SKIP = new Set(['label', 'waypoint']);
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
     * a scatter of bars that are not on the course. Labels are notes. */
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
 * How many GATES a course has, which is not how long its flying order is.
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
    return { error: 'That course is too large to publish.' };
  }
  const packed = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (packed.length > MAX_DOCUMENT_CHARS) {
    return { error: 'That course is too large to publish.' };
  }
  let document = raw;
  if (typeof raw === 'string') {
    try {
      document = JSON.parse(raw);
    } catch (e) {
      return { error: 'That course is not valid JSON.' };
    }
  }
  if (!isObject(document)) {
    return { error: 'That course is not a track document.' };
  }
  if (document.schemaVersion !== 1) {
    return { error: 'This board only accepts schemaVersion 1 courses.' };
  }
  const id = String(document.id || '');
  if (!TRACK_ID_RE.test(id)) {
    return { error: 'That course has no usable id.' };
  }
  const name = String(document.name || '').trim() || 'Untitled track';
  /* The message named the field and then never looked at it, so a course
   * with no field at all passed here and the board drew it on the 60 by 40
   * default while the simulator flew it on whatever the document said. */
  if (!isObject(document.field)) {
    return { error: 'That course is missing its field.' };
  }
  if (!Array.isArray(document.elements) || !Array.isArray(document.sequence)) {
    return { error: 'That course is missing its elements or its flying order.' };
  }
  if (document.sequence.length < 1) {
    return { error: 'A published course needs at least one gate in the flying order.' };
  }
  const elementIds = new Set();
  for (const el of document.elements) {
    if (isObject(el) && typeof el.id === 'string' && el.id) {
      elementIds.add(el.id);
    }
  }
  for (const step of document.sequence) {
    if (!isObject(step) || !elementIds.has(step.elementId)) {
      return { error: 'That flying order names a gate that is not in the course.' };
    }
  }
  const logo = document.branding && document.branding.logo;
  if (logo != null && !usableLogo(logo)) {
    return { error: 'A logo has to travel inside the course as an embedded image.' };
  }
  return {
    document,
    id,
    name: name.slice(0, 80),
    hasLogo: Boolean(logo),
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
const BUG_CONTEXT_KEYS = 24;

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
