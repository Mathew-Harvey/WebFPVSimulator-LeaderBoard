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
  return typeof value === 'string' && value.length < 280_000 && LOGO_RE.test(value);
}

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
    marks.push({
      type,
      x: Number(el.position.x) || 0,
      y: Number(el.position.y) || 0,
      yaw: Number(el.yaw) || 0,
      seq: sequenced.has(el.id),
    });
  }
  const path = [];
  const numbers = [];
  const numbered = new Set();
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
    if (PLAN_APERTURE.has(type) && el.id && !numbered.has(el.id)) {
      numbered.add(el.id);
      n += 1;
      numbers.push({ n, x, y });
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
  if (!Array.isArray(document.elements) || !Array.isArray(document.sequence)) {
    return { error: 'That course is missing its field or its flying order.' };
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
    gates: document.sequence.length,
    elements: document.elements.length,
    layoutHash: layoutHash(document),
    plan: planFromDocument(document),
  };
}
