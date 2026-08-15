/*
 * selftest.js: the board's own checks. Names, documents, the file store,
 * and a live HTTP pass against the server.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  inspectDocument, layoutHash, normaliseLapMs, normaliseName,
} from './validate.js';
import { openStore } from './store.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  pass  ${name}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
}

function sampleDoc(id = 'trk-1a2b3c4d', extra = {}) {
  return {
    schemaVersion: 1,
    id,
    name: extra.name || 'Ladder Loop',
    createdUtc: '2026-01-01T00:00:00Z',
    modifiedUtc: '2026-01-01T00:00:00Z',
    field: { width: 60, depth: 40, gridSize: 1 },
    settings: { tangentScale: 0.4, minCurveRadius: 2, samplesPerSegment: 24 },
    branding: {
      logo: extra.logo === undefined ? null : extra.logo,
      logoName: extra.logoName || '',
    },
    elements: extra.elements || [
      {
        id: 'el-1',
        type: 'gate',
        name: 'Gate',
        position: { x: 10, y: 8, z: 0 },
        yaw: 0,
        pitch: 0,
        yawOverridden: false,
        dims: { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1 },
      },
    ],
    sequence: extra.sequence || [{ id: 'seq-1', elementId: 'el-1', apertureIndex: 0, entry: 1 }],
  };
}

async function testValidate() {
  console.log('validate');
  check('accepts a real name', normaliseName('Ada Rook') === 'Ada Rook');
  check('rejects a one letter name', normaliseName('A') == null);
  check('rejects a symbol name', normaliseName('Ada!') == null);
  check('accepts a lap', normaliseLapMs(12345) === 12345);
  check('rejects a zero lap', normaliseLapMs(0) == null);
  check('rejects a boolean lap', normaliseLapMs(true) == null);
  check('rejects an array lap', normaliseLapMs([1234]) == null);
  const ok = inspectDocument(sampleDoc());
  check('accepts a schema 1 course', !ok.error && ok.id === 'trk-1a2b3c4d' && ok.gates === 1);
  check('refuses an empty flying order', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', { sequence: [] })).error));
  check('refuses a flying order that names nothing', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', {
    sequence: [{ id: 'seq-1', elementId: 'missing', apertureIndex: 0, entry: 1 }],
  })).error));
  check('refuses a remote logo', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', { logo: 'https://evil.example/x.png' })).error));
  check('refuses an svg logo', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', { logo: 'data:image/svg+xml;base64,PHN2Zy8+' })).error));
  const withLogo = inspectDocument(sampleDoc('trk-1a2b3c4d', { logo: 'data:image/png;base64,aaa' }));
  check('keeps an embedded logo', !withLogo.error && withLogo.hasLogo);
  const a = layoutHash(sampleDoc());
  const b = layoutHash(sampleDoc('trk-1a2b3c4d', { name: 'Renamed' }));
  check('layout hash ignores the title', a === b);
}

async function testStore() {
  console.log('store');
  const dir = await mkdtemp(join(tmpdir(), 'webfpv-board-'));
  process.env.BOARD_FILE = join(dir, 'board.json');
  delete process.env.DATABASE_URL;
  const store = await openStore();
  const inspected = inspectDocument(sampleDoc());
  const first = await store.publish({ inspected, author: 'Ada Rook', editKey: '' });
  check('first publish returns an edit key', Boolean(first.editKey) && first.updated === false);
  const clash = await store.publish({ inspected, author: 'Ada Rook', editKey: '' });
  check('second publish without the key is refused', clash.status === 409 && clash.conflict === true);
  const again = await store.publish({ inspected, author: 'Ada Rook', editKey: first.editKey });
  check('second publish with the key updates', again.updated === true && !again.editKey);
  await store.addTime({ trackId: inspected.id, name: 'Ada Rook', lapMs: 42000 });
  const renamed = inspectDocument(sampleDoc('trk-1a2b3c4d', { name: 'Renamed Loop' }));
  const named = await store.publish({ inspected: renamed, author: 'Ada Rook', editKey: first.editKey });
  check('a rename does not clear times', named.timesCleared === false);
  const afterName = await store.getTrack(inspected.id);
  check('the board shows the new name and keeps the time', afterName.name === 'Renamed Loop' && afterName.times.length === 1 && afterName.times[0].lapMs === 42000);
  await store.addTime({ trackId: inspected.id, name: 'Bo', lapMs: 51000 });
  const reauthor = await store.publish({ inspected: renamed, author: 'Ada Two', editKey: first.editKey });
  check('an author rename does not clear times', reauthor.timesCleared === false);
  const afterAuthor = await store.getTrack(inspected.id);
  check('an author rename retitles their times and leaves others', afterAuthor.author === 'Ada Two' && afterAuthor.times[0].name === 'Ada Two' && afterAuthor.times[1].name === 'Bo');
  const moved = inspectDocument(sampleDoc('trk-1a2b3c4d', {
    elements: [{
      id: 'el-1',
      type: 'gate',
      name: 'Gate',
      position: { x: 20, y: 8, z: 0 },
      yaw: 0,
      pitch: 0,
      yawOverridden: false,
      dims: { clearW: 1.524, clearH: 1.524, sillH: 0, levels: 1 },
    }],
  }));
  const cleared = await store.publish({ inspected: moved, author: 'Ada Rook', editKey: first.editKey });
  check('a layout change clears times', cleared.timesCleared === true);
  const after = await store.getTrack(inspected.id);
  check('cleared board has no times', after.times.length === 0);
  const posted = await store.addTime({ trackId: inspected.id, name: 'Ada Rook', lapMs: 33400 });
  check('a posted time is rank 1', posted.rank === 1);
  const slower = await store.addTime({ trackId: inspected.id, name: 'Bo', lapMs: 40000 });
  check('a slower time is rank 2', slower.rank === 2);
  await Promise.all([
    store.addTime({ trackId: inspected.id, name: 'Cy', lapMs: 45000 }),
    store.addTime({ trackId: inspected.id, name: 'Di', lapMs: 46000 }),
  ]);
  const afterParallel = await store.getTrack(inspected.id);
  check('parallel posts both land', afterParallel.times.length === 4);
  const list = await store.listTracks();
  check('the list names the author', list[0].author === 'Ada Rook' && list[0].best.lapMs === 33400);
  const doc = await store.getDocument(inspected.id);
  check('the document is still there', doc.document.id === inspected.id);
  await rm(dir, { recursive: true, force: true });
}

function waitFor(child, needle, ms = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), ms);
    const onData = (chunk) => {
      buf += chunk;
      if (buf.includes(needle)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

async function testHttp() {
  console.log('http');
  const dir = await mkdtemp(join(tmpdir(), 'webfpv-board-'));
  const child = spawn(process.execPath, [join(root, 'src', 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '3199',
      BOARD_FILE: join(dir, 'board.json'),
      DATABASE_URL: '',
      SIM_ORIGIN: 'http://127.0.0.1:8000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitFor(child, 'WebFPV leaderboard');
    const health = await fetch('http://127.0.0.1:3199/api/health').then((r) => r.json());
    check('health', health.ok === true && health.store === 'file');
    const created = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'Ada Rook', document: sampleDoc() }),
    });
    const body = await created.json();
    check('publish over HTTP', created.status === 201 && body.id === 'trk-1a2b3c4d');
    const time = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada Rook', lapMs: 29110 }),
    });
    const posted = await time.json();
    check('post a time over HTTP', time.status === 201 && posted.rank === 1);
    const renamed = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: 'Ada Rook',
        document: { ...sampleDoc(), name: 'HTTP Rename' },
        editKey: body.editKey,
      }),
    });
    const renamedBody = await renamed.json();
    check('rename over HTTP', renamed.status === 200 && renamedBody.updated === true && renamedBody.timesCleared !== true);
    const page = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d').then((r) => r.json());
    check('expanded track has the new name and the time', page.name === 'HTTP Rename' && page.times[0].lapMs === 29110);
    const reauthor = await fetch('http://127.0.0.1:3199/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: 'Ada Two',
        document: { ...sampleDoc(), name: 'HTTP Rename' },
        editKey: body.editKey,
      }),
    });
    const reauthorBody = await reauthor.json();
    check('author rename over HTTP', reauthor.status === 200 && reauthorBody.updated === true && reauthorBody.timesCleared !== true);
    const renamedTimes = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d').then((r) => r.json());
    check('author rename retitles the posted time', renamedTimes.author === 'Ada Two' && renamedTimes.times[0].name === 'Ada Two');
    const html = await fetch('http://127.0.0.1:3199/').then((r) => r.text());
    check('the page is served', html.includes('The board') && html.includes('app.js'));
    check('the page does not load a webfont', !html.includes('fonts.googleapis.com'));
    const app = await fetch('http://127.0.0.1:3199/app.js').then((r) => r.text());
    const cardFn = app.slice(app.indexOf('function cardFor('));
    const attach = cardFn.indexOf('card.append(body)');
    const paint = cardFn.indexOf('paintPodium(');
    check('a course card is attached before its times are painted', attach !== -1 && paint !== -1 && attach < paint);
    const cfg = await fetch('http://127.0.0.1:3199/api/config').then((r) => r.json());
    check('config names the simulator', cfg.simOrigin === 'http://127.0.0.1:8000');
    const sneak = await fetch('http://127.0.0.1:3199/%2e%2e/package.json');
    const sneakText = await sneak.text();
    check('encoded parent path cannot read the package', sneak.status !== 200 && !sneakText.includes('webfpvleaderboard'));
    const badPct = await fetch('http://127.0.0.1:3199/%');
    check('a malformed percent is not a 500', badPct.status === 400 || badPct.status === 404);
  } finally {
    child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
}

await testValidate();
await testStore();
await testHttp();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
