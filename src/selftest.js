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
  inspectBugCreate, inspectBugPatch, inspectDocument, layoutHash, normaliseLapMs, normaliseName,
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
  const marks = (count, size = 64) => Array.from({ length: count }, (unused, i) => ({
    id: `logo-${i + 1}`, image: png(size), name: `m${i + 1}`,
  }));
  const v2 = sampleDoc('trk-1a2b3c4d', { logos: marks(5) });
  v2.schemaVersion = 2;
  const five = inspectDocument(v2);
  check('accepts a schema 2 course with five marks', !five.error && five.logoCount === 5);
  const v3 = sampleDoc('trk-1a2b3c4d');
  v3.schemaVersion = 3;
  check('refuses a schema 3 course', Boolean(inspectDocument(v3).error));
  const six = sampleDoc('trk-1a2b3c4d', { logos: marks(6) });
  six.schemaVersion = 2;
  check('refuses a sixth mark', Boolean(inspectDocument(six).error));
  const fat = sampleDoc('trk-1a2b3c4d', { logos: marks(3, 200 * 1024) });
  fat.schemaVersion = 2;
  check('refuses marks past the shared budget', Boolean(inspectDocument(fat).error));
  const remoteInList = sampleDoc('trk-1a2b3c4d', {
    logos: [{ id: 'logo-1', image: 'https://evil.example/x.png', name: 'x' }],
  });
  remoteInList.schemaVersion = 2;
  check('refuses a remote mark in the list', Boolean(inspectDocument(remoteInList).error));

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
    const inbox = await fetch('http://127.0.0.1:3199/bugs.html').then((r) => r.text());
    check('the inbox page is served', inbox.includes('Bug tickets') && inbox.includes('bugs.js'));
    const inboxShort = await fetch('http://127.0.0.1:3199/bugs');
    check('/bugs serves the inbox', inboxShort.status === 200 && (await inboxShort.text()).includes('Bug tickets'));
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
