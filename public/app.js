/*
 * app.js: the public board page.
 *
 * One tile per published course, ordered by a control the reader can see
 * and change. The tile art is the course plan, drawn from the list payload
 * by plan.js: the flown line and the things that stand on the field, so a
 * waypoint that pins the line does not stand in as a gate. The index costs
 * two requests and no WebGL. Opening a
 * course is a real link, #course=trk-1a2b3c4d, and the sheet behind it is
 * where the expensive and beautiful thing lives: the simulator's own title
 * camera, playing once rather than twelve times at once.
 *
 * Times are fetched only for courses that have any, which on a young board
 * is one request instead of one per course. Those times then feed three
 * things at no extra cost: the top three on a tile, the standings rail,
 * and the count of pilots in the masthead.
 *
 * Fly this course opens the simulator with ?share=id, which is the whole
 * of the link between the two sites.
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

import { fillCredits } from './credits.js';
import {
  fieldSize, paintPlans, planCanvas, planLabel,
} from './plan.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text != null) {
    n.textContent = text;
  }
  return n;
}

function byId(id) {
  return document.getElementById(id);
}

function formatTime(ms) {
  if (ms == null || !Number.isFinite(ms)) {
    return '--.--';
  }
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  if (m > 0) {
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  }
  return s.toFixed(2);
}

/* A lap, with the hundredths in their own span so they can sit a shade
 * quieter than the seconds. */
function timeNode(ms, cls, prefix) {
  const node = el('span', cls || 'tm');
  if (ms == null || !Number.isFinite(ms)) {
    node.classList.add('empty');
    node.textContent = '--.--';
    return node;
  }
  const t = formatTime(ms);
  const dot = t.lastIndexOf('.');
  node.append(`${prefix || ''}${t.slice(0, dot)}`);
  node.append(el('span', 'frac', t.slice(dot)));
  return node;
}

function formatWhen(iso) {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatAgo(iso) {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) {
    return 'just now';
  }
  if (sec < 90) {
    return '1 min ago';
  }
  if (sec < 3600) {
    return `${Math.floor(sec / 60)} min ago`;
  }
  if (sec < 5400) {
    return '1 hour ago';
  }
  if (sec < 86400) {
    return `${Math.floor(sec / 3600)} hours ago`;
  }
  if (sec < 172800) {
    return '1 day ago';
  }
  if (sec < 86400 * 30) {
    return `${Math.floor(sec / 86400)} days ago`;
  }
  return formatWhen(iso);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/* Facts on one line read as a list, not as a sentence, so they are
 * separated by a middot rather than by punctuation. */
function joined(parts) {
  return parts.filter(Boolean).join(' \u00b7 ');
}

function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ------------------------------------------------------------------ */
/* The two links between this site and the simulator                   */
/* ------------------------------------------------------------------ */

/*
 * One board tab, one simulator tab.
 *
 * Every link that crossed to the simulator carried target="_blank", so a
 * visitor who flew three courses off this board finished with three
 * simulators open, each of them running a physics loop and holding a WebGL
 * context. Naming the tab instead means the second course lands in the tab
 * the first one is already using, and the browser focuses it.
 *
 * Two things this depends on, both easy to undo by accident:
 *
 *   No rel="noopener" on these links. The spec resolves a noopener link by
 *   setting its target to "_blank" first, so a named link that also asks
 *   for noopener opens a new tab every single time, which is the bug being
 *   fixed here. The cost is that the simulator gets a cross origin
 *   window.opener pointing back at this page. It is our own site at the
 *   other end. A link that leaves the product keeps its noopener.
 *
 *   The names have to match src/share/windows.js in the simulator, which is
 *   the copy of record and carries the long version of this comment. This
 *   page cannot import from there, so the strings are written down twice.
 *
 * A modifier click still opens a new tab: the browser overrides the target
 * when the visitor asks for that, which is the one case where a second
 * simulator is what was wanted.
 */
const SIM_WINDOW = 'webfpv-sim';
const BOARD_WINDOW = 'webfpv-board';

function flyHref(config, id) {
  const board = encodeURIComponent(config.boardOrigin);
  return `${config.simOrigin}/?map=custom&share=${encodeURIComponent(id)}&board=${board}`;
}

function remixHref(config, id) {
  const board = encodeURIComponent(config.boardOrigin);
  return `${config.simOrigin}/src/trackbuilder/index.html?share=${encodeURIComponent(id)}&board=${board}`;
}

function orbitHref(config, id) {
  const u = new URL('/src/share/orbit.html', config.simOrigin);
  u.searchParams.set('map', 'custom');
  u.searchParams.set('share', id);
  u.searchParams.set('board', config.boardOrigin);
  return u.href;
}

function courseHref(id) {
  return `#course=${encodeURIComponent(id)}`;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  config: { simOrigin: 'http://127.0.0.1:8000', boardOrigin: window.location.origin },
  courses: [],
  timesById: new Map(),
  query: '',
  sort: 'flown',
  openId: null,
  lastFocus: null,
};

function courseById(id) {
  return state.courses.find((t) => t.id === id) || null;
}

function timesFor(id) {
  return state.timesById.get(id) || null;
}

function bestMsOf(track) {
  const times = timesFor(track.id);
  if (times && times.length) {
    return times[0].lapMs;
  }
  return track.best ? track.best.lapMs : null;
}

/* ------------------------------------------------------------------ */
/* Order and search                                                    */
/* ------------------------------------------------------------------ */

/*
 * Most flown is the default because a course with times on it is a course
 * with something to beat. The tie break is gate count rather than the
 * clock, so on a young board where almost nothing has been flown the
 * championship layouts lead and a three gate drill does not.
 */
const SORTS = {
  flown: (a, b) => (b.times || 0) - (a.times || 0)
    || (b.gates || 0) - (a.gates || 0)
    || String(b.publishedUtc || '').localeCompare(String(a.publishedUtc || '')),
  fastest: (a, b) => {
    const x = bestMsOf(a);
    const y = bestMsOf(b);
    if (x == null && y == null) {
      return (b.gates || 0) - (a.gates || 0);
    }
    if (x == null) {
      return 1;
    }
    if (y == null) {
      return -1;
    }
    return x - y;
  },
  biggest: (a, b) => (b.gates || 0) - (a.gates || 0) || (b.times || 0) - (a.times || 0),
  newest: (a, b) => String(b.publishedUtc || '').localeCompare(String(a.publishedUtc || '')),
  name: (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }),
};

function matches(track, needle) {
  if (!needle) {
    return true;
  }
  if (String(track.name).toLowerCase().includes(needle)) {
    return true;
  }
  if (String(track.author).toLowerCase().includes(needle)) {
    return true;
  }
  const times = timesFor(track.id);
  return Boolean(times && times.some((row) => String(row.name).toLowerCase().includes(needle)));
}

function visibleCourses() {
  const needle = state.query.trim().toLowerCase();
  const compare = SORTS[state.sort] || SORTS.flown;
  return state.courses.filter((t) => matches(t, needle)).sort(compare);
}

/* ------------------------------------------------------------------ */
/* A course tile                                                       */
/* ------------------------------------------------------------------ */

function cardFor(track, config) {
  const card = el('article', 'card');
  card.dataset.id = track.id;

  const tile = el('a', 'tile');
  tile.href = courseHref(track.id);
  tile.setAttribute('aria-label', `${track.name}, plan and times`);
  tile.append(planCanvas(track.plan, planLabel(track)));
  const size = fieldSize(track);
  if (size) {
    tile.append(el('span', 'tile-chip', size));
  }
  if (track.times > 0) {
    tile.append(el('span', 'tile-flown', plural(track.times, 'time', 'times')));
  }
  card.append(tile);

  const body = el('div', 'body');

  const head = el('div', 'head');
  head.append(el('h2', null, track.name));
  const by = el('p', 'by');
  by.append('by ');
  by.append(el('b', null, track.author));
  by.append(` \u00b7 ${plural(track.gates, 'gate', 'gates')}`);
  head.append(by);

  /* No record block on a course nobody has flown. Ten cards each carrying
   * a label and a row of dashes is the difference between a board and a
   * form. The single quiet line below says the same thing once. */
  const record = el('div', 'record');
  record.hidden = !track.best;
  record.append(el('span', 'record-label', 'Record'));
  record.append(timeNode(track.best ? track.best.lapMs : null, 'record-time'));
  record.append(el('div', 'record-holder', track.best ? track.best.name : ''));
  head.append(record);
  body.append(head);

  const podium = el('ol', 'podium');
  podium.hidden = true;
  body.append(podium);

  const none = el('p', 'none', 'No time posted yet');
  none.hidden = Boolean(track.best);
  body.append(none);

  const actions = el('div', 'actions');
  const fly = el('a', 'btn primary small', 'Fly this course');
  fly.href = flyHref(config, track.id);
  fly.target = SIM_WINDOW;
  fly.setAttribute('aria-label', `Fly ${track.name}, opens it in the simulator tab`);
  const more = el('a', 'text more');
  more.href = courseHref(track.id);
  more.textContent = track.times > 3 ? `All ${plural(track.times, 'time', 'times')}` : 'Course detail';
  actions.append(fly, more);
  body.append(actions);

  card.append(body);
  return card;
}

/*
 * The top three, once a course's times have arrived. Called after the
 * card is in the document, never while it is still a loose node: a card
 * has to exist before anything paints into it.
 */
function paintPodium(card, times) {
  const podium = card.querySelector('.podium');
  const none = card.querySelector('.none');
  const more = card.querySelector('.more');
  const record = card.querySelector('.record');
  const clock = card.querySelector('.record-time');
  const holder = card.querySelector('.record-holder');
  if (!podium || !none) {
    return;
  }
  podium.textContent = '';
  if (!times || !times.length) {
    podium.hidden = true;
    none.hidden = false;
    if (record) {
      record.hidden = true;
    }
    return;
  }
  none.hidden = true;
  if (record) {
    record.hidden = false;
  }
  if (clock) {
    clock.replaceWith(timeNode(times[0].lapMs, 'record-time'));
  }
  /* One time is a record, not a podium, and naming the holder twice on
   * one card is how a leaderboard starts to read as a receipt. The holder
   * line carries the name when there is no podium, and the podium carries
   * it when there is. */
  const ranked = times.length > 1;
  if (holder) {
    holder.textContent = ranked ? '' : times[0].name;
  }
  podium.hidden = !ranked;
  if (!ranked) {
    return;
  }
  times.slice(0, 3).forEach((row, i) => {
    const li = el('li', `podium-row r${i + 1}`);
    li.append(el('span', 'rk', String(i + 1)));
    li.append(el('span', 'nm', row.name));
    li.append(timeNode(row.lapMs, 'tm'));
    podium.append(li);
  });
  if (more) {
    more.textContent = times.length > 3
      ? `All ${plural(times.length, 'time', 'times')}`
      : 'Course detail';
  }
}

/* ------------------------------------------------------------------ */
/* The grid                                                            */
/* ------------------------------------------------------------------ */

function skeletons(host, n) {
  host.textContent = '';
  for (let i = 0; i < n; i += 1) {
    const card = el('article', 'card skeleton');
    card.append(el('div', 'tile'));
    const body = el('div', 'body');
    body.append(el('div', 'bone wide'), el('div', 'bone thin'));
    card.append(body);
    host.append(card);
  }
}

function paintGrid() {
  const list = byId('list');
  const notice = byId('notice');
  const count = byId('count');
  const shown = visibleCourses();
  list.textContent = '';
  notice.textContent = '';
  for (const track of shown) {
    const card = cardFor(track, state.config);
    list.append(card);
    const times = timesFor(track.id);
    if (times) {
      paintPodium(card, times);
    }
  }
  paintPlans(list);
  if (count) {
    count.textContent = shown.length === state.courses.length
      ? plural(state.courses.length, 'course', 'courses')
      : `${shown.length} of ${plural(state.courses.length, 'course', 'courses')}`;
  }
  if (!shown.length && state.courses.length) {
    const box = el('div', 'empty panel');
    box.append(el('h2', null, 'Nothing matches that'));
    box.append(el('p', null, `No course or pilot on the board answers to "${state.query.trim()}".`));
    const clear = el('button', 'btn small', 'Clear the search');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      const find = byId('find');
      state.query = '';
      if (find) {
        find.value = '';
        find.focus();
      }
      paintGrid();
    });
    box.append(clear);
    notice.append(box);
  }
}

/* ------------------------------------------------------------------ */
/* Standings                                                           */
/* ------------------------------------------------------------------ */

/*
 * A pilot's standing is how many courses they hold, not how many laps
 * they have posted, because posting more laps is not the same as being
 * quicker than anybody.
 */
function standings() {
  const by = new Map();
  for (const course of state.courses) {
    const times = timesFor(course.id);
    if (!times || !times.length) {
      continue;
    }
    times.forEach((row, i) => {
      const rec = by.get(row.name) || {
        name: row.name, laps: 0, records: 0, podiums: 0,
      };
      rec.laps += 1;
      if (i === 0) {
        rec.records += 1;
      }
      if (i < 3) {
        rec.podiums += 1;
      }
      by.set(row.name, rec);
    });
  }
  return [...by.values()].sort((a, b) => b.records - a.records
    || b.podiums - a.podiums
    || b.laps - a.laps
    || a.name.localeCompare(b.name));
}

function latestTimes(limit) {
  const rows = [];
  for (const course of state.courses) {
    const times = timesFor(course.id);
    if (!times) {
      continue;
    }
    times.forEach((row, i) => {
      rows.push({ ...row, course, best: i === 0 });
    });
  }
  rows.sort((a, b) => String(b.postedUtc || '').localeCompare(String(a.postedUtc || '')));
  return rows.slice(0, limit);
}

function railBlock(kicker, heading) {
  const block = el('section', 'rail-block panel');
  block.append(el('div', 'kicker', kicker));
  block.append(el('h2', null, heading));
  return block;
}

function paintRail() {
  const rail = byId('rail');
  const deck = byId('deck');
  if (!rail || !deck) {
    return;
  }
  const pilots = standings();
  const feed = latestTimes(6);
  rail.textContent = '';
  if (!pilots.length) {
    rail.hidden = true;
    deck.classList.remove('has-rail');
    return;
  }
  rail.hidden = false;
  deck.classList.add('has-rail');

  const table = railBlock('Standings', 'Fastest pilots');
  pilots.slice(0, 8).forEach((p, i) => {
    const row = el('div', `standing p${i + 1}`);
    row.append(el('span', 'rk', String(i + 1)));
    row.append(el('span', 'nm', p.name));
    row.append(el('span', 'sc', String(p.records)));
    row.append(el('span', 'mt', joined([
      p.records === 1 ? 'record held' : 'records held',
      p.laps > p.records ? plural(p.laps, 'lap', 'laps') : '',
    ])));
    table.append(row);
  });
  table.append(el('p', 'rail-note', 'Ranked by course records held, then podiums, then laps posted.'));
  rail.append(table);

  if (feed.length) {
    const lately = railBlock('Lately', 'Times posted');
    const list = el('div', 'feed');
    for (const row of feed) {
      const line = el('div', 'feed-row');
      line.append(el('span', 'nm', row.name));
      line.append(timeNode(row.lapMs, `rail-time${row.best ? ' best' : ''}`));
      const on = el('a', 'on', row.course.name);
      on.href = courseHref(row.course.id);
      line.append(on);
      line.append(el('span', 'ago', formatAgo(row.postedUtc)));
      list.append(line);
    }
    lately.append(list);
    rail.append(lately);
  }
}

/* ------------------------------------------------------------------ */
/* Counts                                                              */
/* ------------------------------------------------------------------ */

function paintStats() {
  const n = state.courses.length;
  const times = state.courses.reduce((sum, t) => sum + (t.times || 0), 0);
  const pilots = standings().length;
  const mast = byId('mast-stats');
  const spine = byId('spine-stats');
  if (mast) {
    mast.hidden = !n;
  }
  const courseCell = byId('stat-courses');
  const timeCell = byId('stat-times');
  const pilotCell = byId('stat-pilots');
  if (courseCell) {
    courseCell.textContent = String(n);
  }
  if (timeCell) {
    timeCell.textContent = String(times);
  }
  if (pilotCell) {
    pilotCell.textContent = String(pilots);
    pilotCell.parentElement.hidden = pilots === 0;
  }
  if (spine) {
    spine.textContent = n
      ? joined([
        plural(n, 'course', 'courses'),
        plural(times, 'time', 'times'),
        pilots ? plural(pilots, 'pilot', 'pilots') : '',
      ])
      : '';
  }
}

/* ------------------------------------------------------------------ */
/* Times, fetched only where there are any                             */
/* ------------------------------------------------------------------ */

const inflight = new Map();

async function loadTimes(id) {
  const held = state.timesById.get(id);
  if (held) {
    return held;
  }
  /* The sheet and the background fill can both want the same course, and
   * a shared promise is cheaper than a second request. */
  if (inflight.has(id)) {
    return inflight.get(id);
  }
  const run = (async () => {
    const res = await fetch(`/api/tracks/${encodeURIComponent(id)}`);
    const detail = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(detail.error || 'Those times could not be loaded.');
    }
    const times = detail.times || [];
    state.timesById.set(id, times);
    return times;
  })();
  inflight.set(id, run);
  try {
    return await run;
  } finally {
    inflight.delete(id);
  }
}

async function hydrate() {
  const active = state.courses.filter((t) => (t.times || 0) > 0);
  await Promise.all(active.map(async (track) => {
    try {
      const times = await loadTimes(track.id);
      const card = document.querySelector(`.card[data-id="${CSS.escape(track.id)}"]`);
      if (card) {
        paintPodium(card, times);
      }
    } catch (e) {
      /* The record from the list payload is still on the tile. */
    }
  }));
  paintRail();
  paintStats();
}

/* ------------------------------------------------------------------ */
/* The course sheet                                                    */
/* ------------------------------------------------------------------ */

/* Each pair goes in its own box, because a bare dt and dd in a grid flow
 * as two separate cells and a label ends up above somebody else's value. */
function factRow(list, label, value) {
  if (value == null || value === '') {
    return;
  }
  const cell = el('div');
  cell.append(el('dt', null, label), el('dd', null, String(value)));
  list.append(cell);
}

function paintShot(host, track) {
  host.textContent = '';
  host.append(planCanvas(track.plan, planLabel(track), { scaleBar: true, pad: 26 }));
  if (reduceMotion()) {
    return;
  }
  const frame = document.createElement('iframe');
  frame.className = 'orbit';
  frame.title = `${track.name}, a flight through the course`;
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.src = orbitHref(state.config, track.id);
  const wait = el('div', 'shot-wait');
  wait.append(el('span', 'shot-dot'), el('span', null, 'Flying the course'));
  host.append(wait, frame);
}

function paintBoard(host, track, times) {
  host.textContent = '';
  const head = el('div', 'board-head');
  head.append(el('h3', null, times.length ? 'Every time posted' : 'The board is open'));
  if (times.length) {
    head.append(el('span', 'count', plural(times.length, 'lap', 'laps')));
  }
  host.append(head);

  if (!times.length) {
    host.append(el('p', 'none', `Nobody has posted a lap on ${track.name} yet. Fly it and the first time on the board is yours.`));
    return;
  }

  const leader = times[0].lapMs;
  const slowest = times[times.length - 1].lapMs || leader;
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const [cls, label] of [['rank', ''], ['nm', 'Pilot'], ['time', 'Time'], ['gap', 'Gap'], ['when', 'Posted']]) {
    headRow.append(el('th', cls, label));
  }
  thead.append(headRow);
  table.append(thead);

  const body = document.createElement('tbody');
  times.forEach((row, i) => {
    const tr = el('tr', `r${i + 1}`);
    tr.append(el('td', 'rank', String(i + 1)));

    const name = el('td', 'nm');
    name.append(el('span', null, row.name));
    const bar = el('div', 'gap-bar');
    const fill = el('span');
    fill.style.width = `${Math.max(8, (row.lapMs / slowest) * 100)}%`;
    bar.append(fill);
    name.append(bar);
    tr.append(name);

    const time = el('td', 'time');
    time.append(timeNode(row.lapMs, 'tm'));
    tr.append(time);

    const gap = el('td', 'gap');
    if (i > 0) {
      gap.append(timeNode(row.lapMs - leader, 'tm', '+'));
    }
    tr.append(gap);

    const when = el('td', 'when', formatAgo(row.postedUtc));
    when.title = formatWhen(row.postedUtc);
    tr.append(when);
    body.append(tr);
  });
  table.append(body);
  host.append(table);
}

function paintHero(host, track, times) {
  host.textContent = '';
  const best = times.length ? times[0] : track.best;
  /* An empty hero is a row of dashes the size of a headline, so a course
   * with no record does not get one. The board below says it in words. */
  host.hidden = !best;
  if (!best) {
    return;
  }
  host.append(el('span', 'record-label', 'Course record'));
  host.append(timeNode(best.lapMs, 'record-time'));
  host.append(el('div', 'record-holder', best.name));
}

function copyButton(url) {
  const btn = el('button', 'text', 'Copy link');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = 'Link copied';
    } catch (e) {
      btn.textContent = url;
    }
    setTimeout(() => {
      btn.textContent = 'Copy link';
    }, 2200);
  });
  return btn;
}

async function paintSheet(track) {
  byId('sheet-kicker').textContent = track.times > 0
    ? `${plural(track.times, 'time', 'times')} posted`
    : 'Open course';
  byId('sheet-title').textContent = track.name;
  const by = byId('sheet-by');
  by.textContent = '';
  by.append('Built by ');
  by.append(el('b', null, track.author));
  const published = formatWhen(track.publishedUtc);
  by.append(published ? `. Published ${published}.` : '.');

  paintShot(byId('sheet-shot'), track);

  const facts = byId('sheet-facts');
  facts.textContent = '';
  factRow(facts, 'Gates', plural(track.gates, 'gate', 'gates'));
  factRow(facts, 'Elements', track.elements);
  factRow(facts, 'Field', fieldSize(track));
  factRow(facts, 'Updated', formatAgo(track.updatedUtc));
  if (track.hasLogo) {
    factRow(facts, 'Branding', 'Sponsor print');
  }

  const actions = byId('sheet-actions');
  actions.textContent = '';
  const fly = el('a', 'btn primary', 'Fly this course');
  fly.href = flyHref(state.config, track.id);
  fly.target = SIM_WINDOW;
  const remix = el('a', 'text', 'Remix in the builder');
  remix.href = remixHref(state.config, track.id);
  /* The builder is the simulator's tab, not a third one: the simulator
   * navigates to the builder in place, so they share the name. */
  remix.target = SIM_WINDOW;
  actions.append(fly, remix, copyButton(`${state.config.boardOrigin}/${courseHref(track.id)}`));

  const held = timesFor(track.id) || [];
  paintHero(byId('sheet-hero'), track, held);
  paintBoard(byId('sheet-board'), track, held);
  paintPlans(byId('sheet'));

  if (!timesFor(track.id) && (track.times || 0) > 0) {
    try {
      const times = await loadTimes(track.id);
      if (state.openId === track.id) {
        paintHero(byId('sheet-hero'), track, times);
        paintBoard(byId('sheet-board'), track, times);
      }
    } catch (e) {
      byId('sheet-board').append(el('p', 'none', e.message));
    }
  }
}

/* The page behind an open sheet is inert, so tabbing cannot walk out of
 * the dialog into a grid nobody can see. */
function setPageInert(on) {
  for (const node of [document.querySelector('.mast'), document.querySelector('.spine'), byId('courses'), document.querySelector('footer')]) {
    if (node) {
      node.inert = on;
    }
  }
}

function sheetOpen() {
  return !byId('sheet').hidden || !byId('credits-sheet').hidden;
}

function closeSheets() {
  for (const id of ['sheet', 'credits-sheet']) {
    const node = byId(id);
    if (!node.hidden) {
      node.hidden = true;
    }
  }
  /* Stop the simulator that was running inside the sheet. */
  const shot = byId('sheet-shot');
  if (shot) {
    shot.textContent = '';
  }
  state.openId = null;
  document.body.classList.remove('locked');
  setPageInert(false);
}

function openSheet(node) {
  if (!sheetOpen()) {
    state.lastFocus = document.activeElement;
  }
  closeSheets();
  node.hidden = false;
  node.scrollTop = 0;
  document.body.classList.add('locked');
  setPageInert(true);
  const close = node.querySelector('.btn');
  if (close) {
    close.focus();
  }
}

function clearHash() {
  const back = state.lastFocus;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  route();
  if (back && document.contains(back)) {
    back.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Routing. A course is an address, so it can be linked and shared.    */
/* ------------------------------------------------------------------ */

function route() {
  const hash = location.hash;
  if (hash === '#credits') {
    openSheet(byId('credits-sheet'));
    return;
  }
  const found = hash.match(/^#course=(.+)$/);
  if (found) {
    let id = '';
    try {
      id = decodeURIComponent(found[1]);
    } catch (e) {
      id = found[1];
    }
    const track = courseById(id);
    if (!track) {
      closeSheets();
      return;
    }
    openSheet(byId('sheet'));
    state.openId = id;
    paintSheet(track);
    return;
  }
  closeSheets();
}

/* ------------------------------------------------------------------ */
/* Page furniture                                                      */
/* ------------------------------------------------------------------ */

function watchSpine() {
  const mast = document.querySelector('.mast');
  const spine = document.querySelector('.spine');
  if (!mast || !spine) {
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      spine.classList.toggle('on', !entry.isIntersecting);
    }
  }, { threshold: 0 });
  io.observe(mast);
}

function bindLinks(config) {
  const sim = `${config.simOrigin}/`;
  const builder = `${config.simOrigin}/src/trackbuilder/index.html`;
  /* These four used to navigate this tab, which left the visitor with a
   * simulator where the board had been and no way back but the back
   * button. They go to the simulator's tab now, the same one Fly this
   * course uses, so the board stays open behind it and a second click
   * does not make a second simulator. */
  const set = (id, href) => {
    const n = byId(id);
    if (n) {
      n.href = href;
      n.target = SIM_WINDOW;
    }
  };
  set('sim-link', sim);
  set('foot-sim', sim);
  set('builder-link', builder);
  set('spine-build', builder);
}

function bindToolbar() {
  const find = byId('find');
  const sort = byId('sort');
  if (find) {
    find.addEventListener('input', () => {
      state.query = find.value;
      paintGrid();
    });
    find.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && find.value) {
        e.stopPropagation();
        find.value = '';
        state.query = '';
        paintGrid();
      }
    });
  }
  if (sort) {
    sort.value = state.sort;
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      paintGrid();
    });
  }
}

function bindCredits() {
  const roll = byId('credits-roll');
  if (roll) {
    fillCredits(roll, { assetBase: 'credits' });
  }
  for (const id of ['credits-close', 'sheet-close']) {
    const btn = byId(id);
    if (btn) {
      btn.addEventListener('click', clearHash);
    }
  }
}

/* A card's iframe says when its first frame is up, so the plan underneath
 * can hand over rather than cut. */
function watchOrbit() {
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'webfpv-orbit-ready') {
      return;
    }
    for (const frame of document.querySelectorAll('iframe.orbit')) {
      if (frame.contentWindow !== e.source) {
        continue;
      }
      frame.classList.add('ready');
      const wait = frame.parentElement && frame.parentElement.querySelector('.shot-wait');
      if (wait) {
        wait.hidden = true;
      }
    }
  });
}

function watchKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (location.hash) {
        clearHash();
      }
      return;
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || sheetOpen()) {
        return;
      }
      const find = byId('find');
      if (find && !find.closest('[hidden]')) {
        e.preventDefault();
        find.focus();
        find.select();
      }
    }
  });
}

function watchResize() {
  let timer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => paintPlans(document), 140);
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function start() {
  /* This tab is the board, and there is only ever one of it: the
   * simulator's Leaderboard opens the board under this name, so a pilot
   * who checks the times between runs comes back to this tab instead of
   * stacking up another one. window.name survives navigation within this
   * origin, so the bugs page and a course hash keep the claim. */
  window.name = BOARD_WINDOW;
  watchSpine();
  watchOrbit();
  watchKeys();
  watchResize();
  bindCredits();
  window.addEventListener('hashchange', route);
  if (location.hash === '#credits') {
    route();
  }

  const list = byId('list');
  const notice = byId('notice');
  skeletons(list, 6);

  /*
   * The status matters. Reading the body and ignoring `r.ok` meant a 500
   * from the database, or a 502 from in front of it, parsed to an object
   * with no `tracks` in it and painted "The board is empty": the one screen
   * that tells a visitor to go and build the first course, shown while
   * every course on the board was sitting there unreachable. An error
   * belongs in the catch below, which already has a panel for it.
   */
  const getJson = async (url) => {
    const r = await fetch(url);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(body.error || `The board answered ${r.status}.`);
    }
    return body;
  };

  try {
    state.config = await getJson('/api/config');
    bindLinks(state.config);
    const payload = await getJson('/api/tracks');
    state.courses = payload.tracks || [];
  } catch (e) {
    list.textContent = '';
    notice.append(el('div', 'status panel', e.message || 'The board could not be loaded.'));
    return;
  }

  paintStats();
  if (!state.courses.length) {
    list.textContent = '';
    const box = el('div', 'empty panel');
    box.append(el('h2', null, 'The board is empty'));
    box.append(el('p', null, 'Build a course in the track builder, set a flying order, and publish it. The board starts when the first course lands.'));
    const build = el('a', 'btn primary', 'Build a course');
    build.href = `${state.config.simOrigin}/src/trackbuilder/index.html`;
    build.target = SIM_WINDOW;
    box.append(build);
    notice.append(box);
    return;
  }

  byId('toolbar').hidden = false;
  bindToolbar();
  paintGrid();
  route();
  await hydrate();
}

start();
