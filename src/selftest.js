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

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  inspectBugCreate, inspectBugPatch, inspectDocument, inspectGhost, layoutHash, normaliseLapMs, normaliseName,
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
    branding: extra.logos
      ? { logos: extra.logos }
      : {
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

/*
 * A well formed ghost blob, built by hand. MIRRORS the wire format in the
 * simulator's src/share/ghostdata.js the same way inspectGhost does: header,
 * splits, then 20 byte samples. The overrides exist to build the malformed
 * blobs the inspector must refuse.
 */
function makeGhostB64(durationMs, {
  rateHz = 30, splits = null, magic = 'FPVGHST1', version = 1, trimBytes = 0,
} = {}) {
  const count = Math.floor((durationMs * rateHz) / 1000) + 2;
  const splitList = splits ?? [durationMs];
  const bytes = Buffer.alloc(32 + splitList.length * 4 + count * 20);
  bytes.write(magic, 0, 'latin1');
  bytes.writeUInt32LE(version, 8);
  bytes.writeUInt32LE(rateHz, 12);
  bytes.writeUInt32LE(count, 16);
  bytes.writeUInt32LE(durationMs, 20);
  bytes.writeUInt32LE(splitList.length, 24);
  let at = 32;
  for (const s of splitList) {
    bytes.writeUInt32LE(s, at);
    at += 4;
  }
  for (let i = 0; i < count; i += 1) {
    bytes.writeFloatLE(i * 0.4, at);
    bytes.writeFloatLE(3, at + 4);
    bytes.writeFloatLE(0, at + 8);
    bytes.writeInt16LE(0, at + 12);
    bytes.writeInt16LE(0, at + 14);
    bytes.writeInt16LE(0, at + 16);
    bytes.writeInt16LE(32767, at + 18);
    at += 20;
  }
  return bytes.subarray(0, bytes.length - trimBytes).toString('base64');
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
  /* The field is what the plan is drawn on. The old message named it and
   * then never checked it. */
  const noField = sampleDoc();
  delete noField.field;
  check('refuses a course with no field', Boolean(inspectDocument(noField).error));
  /*
   * gates is the count of things you FLY THROUGH, not the length of the
   * flying order: a waypoint pins the line and nothing stands there. This
   * is the number printed on the card beside the plan, and the plan's own
   * badges come from the same rule in planFromDocument.
   */
  const withWaypoint = inspectDocument(sampleDoc('trk-1a2b3c4d', {
    elements: [
      { id: 'el-1', type: 'gate', position: { x: 0, y: 0, z: 0 }, yaw: 0, dims: { levels: 1 } },
      { id: 'el-2', type: 'waypoint', position: { x: 5, y: 5, z: 0 }, yaw: 0, dims: {} },
    ],
    sequence: [{ elementId: 'el-1' }, { elementId: 'el-2' }],
  }));
  check('a waypoint in the order is not a gate', !withWaypoint.error && withWaypoint.gates === 1);
  /*
   * MIRROR CHECK. layoutHash decides whether a republished course keeps its
   * times, and the simulator's layoutFingerprint predicts that answer so it
   * can warn first. They hash differently on purpose; they must agree on
   * which keys ARE the layout. If this list changes, change
   * WebFPVSimulator/src/share/listing.js with it.
   */
  const layoutKeys = sampleDoc();
  const movedGate = sampleDoc();
  movedGate.elements = movedGate.elements.map((el) => ({ ...el, position: { ...el.position, x: 99 } }));
  check('layoutHash follows elements', layoutHash(layoutKeys) !== layoutHash(movedGate));
  const recoloured = sampleDoc();
  recoloured.branding = { logo: null, logoName: 'ignored' };
  check('layoutHash ignores branding', layoutHash(layoutKeys) === layoutHash(recoloured));
  check('refuses an empty flying order', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', { sequence: [] })).error));
  check('refuses a flying order that names nothing', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', {
    sequence: [{ id: 'seq-1', elementId: 'missing', apertureIndex: 0, entry: 1 }],
  })).error));
  check('refuses a remote logo', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', { logo: 'https://evil.example/x.png' })).error));
  check('refuses an svg logo', Boolean(inspectDocument(sampleDoc('trk-1a2b3c4d', { logo: 'data:image/svg+xml;base64,PHN2Zy8+' })).error));
  const withLogo = inspectDocument(sampleDoc('trk-1a2b3c4d', { logo: 'data:image/png;base64,aaa' }));
  check('keeps an embedded logo', !withLogo.error && withLogo.hasLogo);

  /*
   * FIVE MARKS. A schemaVersion 2 course spells its branding as a list, and
   * the board has to read both spellings: the old one, because courses
   * published under it are already stored, and the new one, because that is
   * what a current builder writes.
   */
  const png = (n) => `data:image/png;base64,${'a'.repeat(n)}`;
  const logos = (count, size = 64) => Array.from({ length: count }, (unused, i) => ({
    id: `logo-${i + 1}`, image: png(size), name: `m${i + 1}`,
  }));
  const v2 = sampleDoc('trk-1a2b3c4d', { logos: logos(5) });
  v2.schemaVersion = 2;
  const five = inspectDocument(v2);
  check('accepts a schema 2 course with five logos', !five.error && five.logoCount === 5);
  const v3 = sampleDoc('trk-1a2b3c4d');
  v3.schemaVersion = 3;
  check('refuses a schema 3 course', Boolean(inspectDocument(v3).error));
  const six = sampleDoc('trk-1a2b3c4d', { logos: logos(6) });
  six.schemaVersion = 2;
  check('refuses a sixth logo', Boolean(inspectDocument(six).error));
  const fat = sampleDoc('trk-1a2b3c4d', { logos: logos(3, 200 * 1024) });
  fat.schemaVersion = 2;
  check('refuses logos past the shared budget', Boolean(inspectDocument(fat).error));
  const remoteInList = sampleDoc('trk-1a2b3c4d', {
    logos: [{ id: 'logo-1', image: 'https://evil.example/x.png', name: 'x' }],
  });
  remoteInList.schemaVersion = 2;
  check('refuses a remote logo in the list', Boolean(inspectDocument(remoteInList).error));

  /*
   * PAINT IS NOT LAYOUT. Selling a sponsor a place on a course that people
   * have already flown must not clear the times on it, so a ground logo is
   * filtered out of the layout hash. MIRRORS LAYOUT_SKIP in the simulator's
   * src/share/listing.js: change one and change the other.
   */
  const painted = sampleDoc();
  painted.elements = [...painted.elements, {
    id: 'el-9',
    type: 'groundLogo',
    name: '',
    position: { x: 30, y: 20, z: 0 },
    yaw: 0,
    pitch: 0,
    yawOverridden: false,
    logoId: 'logo-1',
    dims: { width: 10, depth: 4 },
  }];
  check('layoutHash ignores paint on the grass', layoutHash(layoutKeys) === layoutHash(painted));
  const paintedPlan = inspectDocument(painted);
  check('a ground logo is not a gate', !paintedPlan.error && paintedPlan.gates === 1);
  check('a ground logo is not drawn on the plan',
    !paintedPlan.error && !paintedPlan.plan.marks.some((m) => m.type === 'groundLogo'));
  const a = layoutHash(sampleDoc());
  const b = layoutHash(sampleDoc('trk-1a2b3c4d', { name: 'Renamed' }));
  check('layout hash ignores the title', a === b);
  const pinned = inspectDocument(sampleDoc('trk-1a2b3c4d', {
    elements: [
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
      {
        id: 'el-2',
        type: 'waypoint',
        name: 'Pin',
        position: { x: 22, y: 18, z: 1.2 },
        yaw: 0.4,
        pitch: 0,
        yawOverridden: false,
        dims: { height: 1.6, poleRadius: 0.02, clearance: 0 },
      },
      {
        id: 'el-3',
        type: 'flag',
        name: 'Dress',
        position: { x: 40, y: 30, z: 0 },
        yaw: 0,
        pitch: 0,
        yawOverridden: false,
        dims: { height: 2.5, poleRadius: 0.025, clearance: 1.5 },
      },
    ],
    sequence: [
      { id: 'seq-1', elementId: 'el-1', apertureIndex: 0, entry: 1 },
      { id: 'seq-2', elementId: 'el-2', apertureIndex: 0, entry: 1 },
    ],
  }));
  check('plan omits waypoints', pinned.plan.marks.every((m) => m.type !== 'waypoint'));
  check('plan path follows the flying order through a waypoint',
    pinned.plan.path.length === 2
    && pinned.plan.path[0].x === 10
    && pinned.plan.path[1].x === 22);
  check('an unused flag is marked off the flying order',
    pinned.plan.marks.some((m) => m.type === 'flag' && m.seq === false));
  check('the start of the flying order is numbered 1',
    pinned.plan.numbers.length === 1 && pinned.plan.numbers[0].n === 1);
  const bugOk = inspectBugCreate({
    kind: 'visual',
    title: 'Trees flicker at the shrine',
    what: 'Flying past the shrine the treeline pops in and out every few frames.',
    reporter: 'Ada Rook',
    context: { map: 'city', screen: 'paused' },
  });
  check('accepts a real bug report', !bugOk.error && bugOk.reporter === 'Ada Rook' && bugOk.kind === 'visual');
  check('blank reporter becomes Anonymous', inspectBugCreate({
    kind: 'other',
    title: 'A short enough title here',
    what: 'Twenty characters at least in this description.',
  }).reporter === 'Anonymous');
  check('refuses a one word title', Boolean(inspectBugCreate({
    kind: 'other', title: 'Short', what: 'Twenty characters at least in this description.',
  }).error));
  check('refuses an unknown kind', Boolean(inspectBugCreate({
    kind: 'explode', title: 'A short enough title here', what: 'Twenty characters at least in this description.',
  }).error));
  check('refuses a symbol reporter', Boolean(inspectBugCreate({
    kind: 'other', title: 'A short enough title here', what: 'Twenty characters at least in this description.', reporter: 'Ada!',
  }).error));
  check('accepts a status patch', inspectBugPatch({ status: 'fixed', resolution: 'Trees no longer pop.' }).status === 'fixed');
  check('refuses a made up status', Boolean(inspectBugPatch({ status: 'maybe' }).error));
  /* Feel reports carry a wide context: twenty keys today, and the cap has
   * to keep headroom over that or feedback bounces with "too many fields". */
  const wide = {};
  for (let i = 0; i < 32; i += 1) {
    wide[`k${i}`] = i;
  }
  check('a thirty two key context is accepted', !inspectBugCreate({
    kind: 'feel', title: 'Flight feel: about right', what: 'The quad felt about right this run, no complaints.', context: wide,
  }).error);
  wide.k32 = 32;
  check('a thirty three key context is refused', Boolean(inspectBugCreate({
    kind: 'feel', title: 'Flight feel: about right', what: 'The quad felt about right this run, no complaints.', context: wide,
  }).error));

  const ghostB64 = makeGhostB64(29110);
  check('accepts a well formed ghost', inspectGhost(ghostB64, 29110).ghost === ghostB64);
  check('an absent ghost is not an error', inspectGhost(null, 29110).ghost === null && inspectGhost('', 29110).ghost === null);
  check('refuses a ghost that is not a string', Boolean(inspectGhost(42, 29110).error));
  check('refuses a ghost that is not base64', Boolean(inspectGhost('not*base64!!'.repeat(8), 29110).error));
  check('refuses a ghost with the wrong magic', Boolean(inspectGhost(makeGhostB64(29110, { magic: 'NOTGHOST' }), 29110).error));
  check('refuses a ghost from another format version', Boolean(inspectGhost(makeGhostB64(29110, { version: 3 }), 29110).error));
  check('refuses a ghost whose bytes disagree with its header', Boolean(inspectGhost(makeGhostB64(29110, { trimBytes: 20 }), 29110).error));
  check('refuses a ghost that does not match the lap beside it', Boolean(inspectGhost(ghostB64, 35000).error));
  check('refuses a ghost past the size cap', Boolean(inspectGhost('A'.repeat(500_004), 1000).error));
  check('refuses a ghost claiming an hour of lap', Boolean(inspectGhost(makeGhostB64(3_000_000, { rateHz: 1 }), 3_000_000).error));
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
  const ghostBlob = makeGhostB64(47000);
  const ghosted = await store.addTime({
    trackId: inspected.id, name: 'Ev', lapMs: 47000, ghost: ghostBlob,
  });
  check('a posted time gets a public id', /^tm-[0-9a-f]{8}$/.test(String(ghosted.id)));
  const withGhost = await store.getTrack(inspected.id);
  const evRow = withGhost.times.find((t) => t.name === 'Ev');
  check('the list marks the ghost and keeps the blob out of it', Boolean(evRow) && evRow.hasGhost === true && !('ghost' in evRow));
  check('times posted without a ghost read hasGhost false', withGhost.times.filter((t) => t.name !== 'Ev').every((t) => t.hasGhost === false));
  const fetchedGhost = await store.getGhost(inspected.id, ghosted.id);
  check('the ghost comes back whole', Boolean(fetchedGhost) && fetchedGhost.ghost === ghostBlob && fetchedGhost.lapMs === 47000);
  check('an unknown time id has no ghost row', (await store.getGhost(inspected.id, 'tm-00000000')) === null);
  /* A row written before ghosts existed: no id, no ghost key at all. It
   * has to list cleanly, not crash the mapper. */
  store.data.times[inspected.id].push({ name: 'Old Row', lapMs: 60000, postedUtc: '2026-01-01T00:00:00.000Z' });
  const legacyRow = (await store.getTrack(inspected.id)).times.find((t) => t.name === 'Old Row');
  check('a time from before ghosts lists with a null id and no ghost', Boolean(legacyRow) && legacyRow.id === null && legacyRow.hasGhost === false);
  const list = await store.listTracks();
  check('the list names the author', list[0].author === 'Ada Rook' && list[0].best.lapMs === 33400);
  store.data.tracks[inspected.id].plan = {
    width: 60,
    depth: 40,
    marks: [{ type: 'waypoint', x: 1, y: 1, yaw: 0 }],
  };
  const relist = await store.listTracks();
  check('the list plan is rebuilt from the document',
    relist[0].plan.marks.every((m) => m.type !== 'waypoint')
    && relist[0].plan.path.length === 1
    && relist[0].plan.path[0].x === 20);
  const doc = await store.getDocument(inspected.id);
  check('the document is still there', doc.document.id === inspected.id);
  const filed = await store.addBug(inspectBugCreate({
    kind: 'feel',
    title: 'Yaw feels late on the field',
    what: 'A right yaw stick on the field map takes a beat before the quad turns.',
    reporter: 'Ada Rook',
    context: { map: 'field', screen: 'flight' },
  }));
  check('a filed bug has an id and is open', Boolean(filed.id) && /^bug-[0-9a-f]{8}$/.test(filed.id) && filed.status === 'open');
  const listed = await store.listBugs({ status: 'open' });
  check('the open list names the bug', listed.length === 1 && listed[0].id === filed.id && listed[0].title === filed.title);
  const got = await store.getBug(filed.id);
  check('the full ticket keeps what happened', got.what.includes('yaw stick') && got.context.map === 'field');
  const marked = await store.updateBug(filed.id, { status: 'fixed', resolution: 'Checked rates. Not a sim bug.' });
  check('an update marks the ticket fixed', marked.status === 'fixed' && marked.resolution.includes('rates'));
  const stillOpen = await store.listBugs({ status: 'open' });
  check('a fixed ticket leaves the open list', stillOpen.length === 0);
  const missing = await store.updateBug('bug-00000000', { status: 'open' });
  check('updating a missing ticket is a 404', missing.status === 404);
  await rm(dir, { recursive: true, force: true });

  const legacyDir = await mkdtemp(join(tmpdir(), 'webfpv-board-legacy-'));
  process.env.BOARD_FILE = join(legacyDir, 'board.json');
  delete process.env.DATABASE_URL;
  await writeFile(join(legacyDir, 'board.json'), JSON.stringify({ tracks: {}, times: {} }), 'utf8');
  const legacy = await openStore();
  const legacyBugs = await legacy.listBugs();
  check('a board.json without bugs still lists an empty ticket list', Array.isArray(legacyBugs) && legacyBugs.length === 0);
  const stillTracks = await legacy.listTracks();
  check('a board.json without bugs still lists courses', Array.isArray(stillTracks) && stillTracks.length === 0);
  await rm(legacyDir, { recursive: true, force: true });
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
    const ghostWire = makeGhostB64(31500);
    const ghostPost = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo', lapMs: 31500, ghost: ghostWire }),
    });
    const ghostPosted = await ghostPost.json();
    check('post a time with a ghost over HTTP', ghostPost.status === 201 && /^tm-[0-9a-f]{8}$/.test(String(ghostPosted.id)));
    const ghostList = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d').then((r) => r.json());
    const boRow = ghostList.times.find((t) => t.name === 'Bo');
    check('the track lists the ghost without carrying it', Boolean(boRow) && boRow.hasGhost === true && boRow.ghost === undefined);
    const ghostGet = await fetch(`http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times/${ghostPosted.id}/ghost`);
    const ghostBody = await ghostGet.json();
    check('the ghost is fetched whole', ghostGet.status === 200 && ghostBody.ghost === ghostWire && ghostBody.lapMs === 31500);
    const adaRow = ghostList.times.find((t) => t.name === 'Ada Two');
    const noGhost = await fetch(`http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times/${adaRow.id}/ghost`);
    check('a time posted without a ghost answers 404', noGhost.status === 404);
    const badGhostId = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times/constructor/ghost');
    check('a non-time ghost address is not a 500', badGhostId.status === 400 || badGhostId.status === 404);
    const badGhost = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo', lapMs: 31500, ghost: 'AAAA' }),
    });
    check('a malformed ghost is refused, not stored', badGhost.status === 400);
    const wrongLap = await fetch('http://127.0.0.1:3199/api/tracks/trk-1a2b3c4d/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bo', lapMs: 90000, ghost: ghostWire }),
    });
    check('a ghost for a different lap is refused', wrongLap.status === 400);
    const html = await fetch('http://127.0.0.1:3199/').then((r) => r.text());
    check('the page is served', html.includes('The board') && html.includes('app.js'));
    /* Relative, not root absolute. The board is served at its own root here
     * and under /board/ on webfpv.org, and a leading slash on either of these
     * asks the landing page for the board's script. The old assertion above
     * matched both spellings, so it could not see the difference. */
    check('the page loads its script relatively', html.includes('src="./app.js"'));
    check('the page has no root absolute reference', !html.includes('src="/') && !html.includes('href="/'));
    check('the page does not load a webfont', !html.includes('fonts.googleapis.com'));
    const app = await fetch('http://127.0.0.1:3199/app.js').then((r) => r.text());
    const cardFn = app.slice(app.indexOf('function cardFor('));
    const attach = cardFn.indexOf('card.append(body)');
    const paint = cardFn.indexOf('paintPodium(');
    check('a course card is attached before its times are painted', attach !== -1 && paint !== -1 && attach < paint);
    const cfg = await fetch('http://127.0.0.1:3199/api/config').then((r) => r.json());
    check('config names the simulator', cfg.simOrigin === 'http://127.0.0.1:8000');
    /*
     * One simulator tab. A named target is the whole mechanism, and a
     * rel="noopener" sitting beside it undoes it in silence: the spec
     * rewrites a noopener target to "_blank" before looking the name up,
     * so the link opens a fresh simulator on every click and the page
     * looks correct while doing it. Both halves are asserted, on the
     * fallback anchors in the page and on the links app.js builds.
     */
    const simAnchors = html.match(/<a\b[^>]*href="http:\/\/127\.0\.0\.1:8000[^"]*"[^>]*>/g) || [];
    check('every fallback link to the simulator names the simulator tab',
      simAnchors.length === 4 && simAnchors.every((a) => a.includes('target="webfpv-sim"')));
    /* Six: the card's Fly, the sheet's Fly and Remix, the header and
     * footer rewrite helper, the empty-board Build link, and the chase
     * link builder the podium and the sheet's table both go through. */
    check('the links app.js builds name the simulator tab',
      app.includes("const SIM_WINDOW = 'webfpv-sim'")
      && (app.match(/\.target = SIM_WINDOW/g) || []).length === 6);
    check('nothing app.js builds opens a bare new tab or asks for noopener',
      !app.includes("'_blank'") && !app.includes("noopener'"));
    const sneak = await fetch('http://127.0.0.1:3199/%2e%2e/package.json');
    const sneakText = await sneak.text();
    check('encoded parent path cannot read the package', sneak.status !== 200 && !sneakText.includes('webfpvleaderboard'));
    const badPct = await fetch('http://127.0.0.1:3199/%');
    check('a malformed percent is not a 500', badPct.status === 400 || badPct.status === 404);
    const filed = await fetch('http://127.0.0.1:3199/api/bugs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'visual',
        title: 'City trees flicker at dusk',
        what: 'Near the shrine the treeline pops in and out every few frames.',
        expected: 'Trees stay put.',
        steps: 'Load city. Fly to the shrine. Look at the treeline.',
        reporter: 'Ada Rook',
        context: { map: 'city', screen: 'paused', graphics: 'high' },
      }),
    });
    const ticket = await filed.json();
    check('file a bug over HTTP', filed.status === 201 && /^bug-[0-9a-f]{8}$/.test(ticket.id) && ticket.status === 'open');
    const short = await fetch('http://127.0.0.1:3199/api/bugs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'other', title: 'Nope', what: 'Too short.' }),
    });
    check('a short bug title is refused', short.status === 400);
    const listed = await fetch('http://127.0.0.1:3199/api/bugs?status=open').then((r) => r.json());
    check('the open list includes the new ticket', listed.bugs.some((b) => b.id === ticket.id && b.map === 'city'));
    const one = await fetch(`http://127.0.0.1:3199/api/bugs/${ticket.id}`).then((r) => r.json());
    check('the full ticket keeps context', one.context.map === 'city' && one.what.includes('shrine'));
    const patched = await fetch(`http://127.0.0.1:3199/api/bugs/${ticket.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    const patchedBody = await patched.json();
    check('an agent can mark a ticket in progress', patched.status === 200 && patchedBody.status === 'in_progress');
    const feel = await fetch('http://127.0.0.1:3199/api/bugs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'feel',
        title: 'Flight feel: about right',
        what: 'The quad felt about right this run. Locked in, no complaints.',
        reporter: 'Ada Rook',
        context: { map: 'field', tune: 'crapshack' },
      }),
    });
    const feelTicket = await feel.json();
    check('flight feel feedback lands as a ticket', feel.status === 201 && feelTicket.kind === 'feel');
    const feelList = await fetch('http://127.0.0.1:3199/api/bugs?kind=feel').then((r) => r.json());
    check('the feedback filter lists only feel reports',
      feelList.bugs.length === 1 && feelList.bugs[0].id === feelTicket.id
      && feelList.bugs.every((b) => b.kind === 'feel'));
    const inbox = await fetch('http://127.0.0.1:3199/bugs.html').then((r) => r.text());
    check('the inbox page is served', inbox.includes('Bugs and feedback') && inbox.includes('bugs.js'));
    check('the inbox can filter by kind', inbox.includes('id="kind"') && inbox.includes('Feedback, flight feel'));
    check('the inbox loads its script relatively', inbox.includes('src="bugs.js"'));
    check('the inbox has no root absolute reference', !inbox.includes('src="/') && !inbox.includes('href="/'));
    const bugsJs = await fetch('http://127.0.0.1:3199/bugs.js').then((r) => r.text());
    check('neither script fetches from the site root',
      !app.includes("fetch('/") && !app.includes('fetch(`/')
      && !bugsJs.includes("fetch('/") && !bugsJs.includes('fetch(`/'));
    const inboxShort = await fetch('http://127.0.0.1:3199/bugs');
    check('/bugs serves the inbox', inboxShort.status === 200 && (await inboxShort.text()).includes('Bugs and feedback'));
    const proto = await fetch('http://127.0.0.1:3199/api/bugs/constructor');
    check('a non-ticket id is not a 500', proto.status === 400 || proto.status === 404);
    const stillBoard = await fetch('http://127.0.0.1:3199/api/tracks').then((r) => r.json());
    check('filing a bug does not drop courses', stillBoard.tracks[0].id === 'trk-1a2b3c4d' && stillBoard.tracks[0].best.lapMs === 29110);
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
