/*
 * app.js: the public board page.
 *
 * One tile per published track, ordered by a control the reader can see
 * and change. The tile art is the track plan, drawn from the list payload
 * by plan.js: the flown line and the things that stand on the field, so a
 * waypoint that pins the line does not stand in as a gate. The index costs
 * two requests and no WebGL. Opening a
 * track is a real link, #track=trk-1a2b3c4d, and the sheet behind it is
 * where the expensive and beautiful thing lives: the simulator's own title
 * camera, playing once rather than twelve times at once.
 *
 * Times are fetched only for tracks that have any, which on a young board
 * is one request instead of one per track. Those times then feed three
 * things at no extra cost: the top three on a tile, the standings rail,
 * and the count of pilots in the masthead.
 *
 * Fly this track opens the simulator with ?share=id, which is the whole
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

import { guessSimOrigin as guess } from './origins.js';
import { fillCredits } from './credits.js';
import {
  fieldSize, paintPlans, planCanvas, planLabel,
} from './plan.js';

/* ------------------------------------------------------------------ */
/* Where this page lives                                               */
/* ------------------------------------------------------------------ */

/*
 * The board is served from its own root on Render and from /board/ on
 * webfpv.org, where a Cloudflare Worker takes the prefix off before the
 * request reaches this service. The server therefore sees the same paths
 * either way and needs no telling. The PAGE does: a fetch of '/api/tracks'
 * from https://webfpv.org/board/ leaves the board's namespace entirely and
 * asks the landing page for the tracks.
 *
 * So every url this page builds for itself is resolved against the directory
 * it was served from. `document.baseURI` is the document's own address, and
 * './' against it is that address's directory, which is /board/ for both
 * /board/ and /board/bugs and / for both / and /bugs. credits.js already
 * resolved its logos this way and this is the same idea applied to the api.
 */
const HERE = new URL('./', document.baseURI);

/*
 * This page's own address INCLUDING the prefix it is mounted under, which is
 * what the simulator needs in a ?board= to find its way back.
 *
 * This OUTRANKS the boardOrigin in /api/config, and that is the whole point.
 * The server works its own address out of the request headers, and a header
 * cannot carry a path: a host is a host. Behind the mount it answers
 * https://webfpv.org, which is the landing page, so every Fly link would send
 * a pilot somewhere that has never heard of a lap time, and nothing would say
 * so out loud. The page is standing at the address in question and does not
 * have to work anything out.
 */
const HERE_ORIGIN = HERE.href.replace(/\/+$/, '');

function here(path) {
  return new URL(path, HERE).href;
}

/* Where the simulator is when /api/config cannot say. See origins.js. */
function guessSimOrigin() {
  try {
    return guess(window.location, HERE);
  } catch (e) {
    /* No window, as in Node. */
    return null;
  }
}

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
 * visitor who flew three tracks off this board finished with three
 * simulators open, each of them running a physics loop and holding a WebGL
 * context. Naming the tab instead means the second track lands in the tab
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

function flyHref(config, id, ghostId) {
  const board = encodeURIComponent(config.boardOrigin);
  const base = `${config.simOrigin}/?map=custom&share=${encodeURIComponent(id)}&board=${board}`;
  /* A ghost id turns the link into a chase: the simulator fetches that
   * lap's recording and flies it beside the visitor as a translucent
   * pacer. Only times posted with a recording carry one. */
  return ghostId ? `${base}&ghost=${encodeURIComponent(ghostId)}` : base;
}

/* The little mint link that races a recorded lap. One builder, because the
 * podium and the sheet's table must not drift apart on what a chase is. */
function chaseLink(config, trackId, row) {
  const a = el('a', 'chase', 'chase');
  a.href = flyHref(config, trackId, row.id);
  a.target = SIM_WINDOW;
  a.title = `Fly against ${row.name}'s recorded lap`;
  return a;
}

function remixHref(config, id) {
  const board = encodeURIComponent(config.boardOrigin);
  return `${config.simOrigin}/src/trackbuilder/index.html?share=${encodeURIComponent(id)}&board=${board}`;
}

function orbitHref(config, id) {
  /*
   * Relative, against simOrigin WITH a trailing slash. It was
   * new URL('/src/share/orbit.html', config.simOrigin), and a leading slash
   * throws away everything but the base's scheme and host: with the simulator
   * at https://webfpv.org/sim that produced https://webfpv.org/src/share/...,
   * which is the landing page, so every card on the board drew an empty box.
   * The other two links below concatenate and were never affected, which is
   * exactly why this one was easy to miss.
   */
  const u = new URL('src/share/orbit.html', `${config.simOrigin}/`);
  u.searchParams.set('map', 'custom');
  u.searchParams.set('share', id);
  u.searchParams.set('board', config.boardOrigin);
  return u.href;
}

function courseHref(id) {
  return `#track=${encodeURIComponent(id)}`;
}

/*
 * The credits roll lives on the simulator at #credits. This board used to
 * paint a second copy, and the two drifted. One page, not two.
 *
 * On webfpv.org the simulator is a mount on the same host, so a root-relative
 * /sim/#credits is the address. Locally the simulator is another origin, so
 * the config's simOrigin is the address.
 */
function creditsHref(config) {
  const origin = String((config && config.simOrigin) || guessSimOrigin() || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  try {
    const host = window.location.hostname;
    if (host === 'webfpv.org' || host === 'www.webfpv.org') {
      return `${window.location.origin}/sim/#credits`;
    }
  } catch (e) {
    /* No window, as in Node. */
  }
  return `${origin}/#credits`;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  /* The guess, not a loopback literal. /api/config overwrites it when it
   * answers; when it does not, this is already right on both layouts that
   * can be worked out from this page's address. See guessSimOrigin. */
  config: { simOrigin: guessSimOrigin() || 'http://127.0.0.1:8000', boardOrigin: HERE_ORIGIN },
  courses: [],
  timesById: new Map(),
  query: '',
  sort: 'flown',
  /* The tag filter is a SET and the rule is AND, not OR. A reader who ticks
   * "skills" and "beginner" is asking for a track that is both, because
   * that is what a reader ticking two boxes means, and OR would hand back
   * more results than one box alone which reads as the filter not working. */
  tags: new Set(),
  author: '',
  /* The freestyle board. `runs` is null until the fetch answers, which the
   * painter tells apart from an empty board: nothing yet posted and not
   * loaded yet are different sentences. */
  runs: null,
  runsError: '',
  style: '',
  view: 'tracks',
  openId: null,
  lastFocus: null,
};

/* The tag vocabulary, as the board describes it. Served rather than written
 * down here, so the list this page offers and the list the board accepts
 * cannot drift: validate.js is the copy of record. Empty until /api/runs
 * answers, which is why the tag bar paints from the tracks rather than
 * appearing before them. */
let TAGS = [];
const TAG_LABEL = new Map();

function tagLabel(id) {
  return TAG_LABEL.get(id) || id;
}

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
 * Most flown is the default because a track with times on it is a track
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

function tagsOf(track) {
  return Array.isArray(track.tags) ? track.tags : [];
}

/* Every tag actually in use, with how many tracks wear it. Counted over the
 * tracks the OTHER filters leave standing, so ticking an author greys out
 * the tags that author never used rather than offering an empty result. */
function tagCounts(pool) {
  const by = new Map();
  for (const track of pool) {
    for (const id of tagsOf(track)) {
      by.set(id, (by.get(id) || 0) + 1);
    }
  }
  return by;
}

/* The authors on the board, most tracks first, then alphabetical. */
function authors() {
  const by = new Map();
  for (const track of state.courses) {
    const name = String(track.author || '');
    by.set(name, (by.get(name) || 0) + 1);
  }
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
}

/* Everything except the tag filter, which the tag counts are measured
 * against so a tag can be greyed out rather than lead nowhere. */
function poolBeforeTags() {
  const needle = state.query.trim().toLowerCase();
  return state.courses.filter((t) => matches(t, needle)
    && (!state.author || String(t.author) === state.author));
}

function visibleCourses() {
  const compare = SORTS[state.sort] || SORTS.flown;
  const wanted = [...state.tags];
  return poolBeforeTags()
    .filter((t) => wanted.every((id) => tagsOf(t).includes(id)))
    .sort(compare);
}

/* ------------------------------------------------------------------ */
/* A track tile                                                       */
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

  /* No record block on a track nobody has flown. Ten cards each carrying
   * a label and a row of dashes is the difference between a board and a
   * form. The single quiet line below says the same thing once. */
  const record = el('div', 'record');
  record.hidden = !track.best;
  record.append(el('span', 'record-label', 'Record'));
  record.append(timeNode(track.best ? track.best.lapMs : null, 'record-time'));
  record.append(el('div', 'record-holder', track.best ? track.best.name : ''));
  head.append(record);
  body.append(head);

  /* What the author says it is for. Above the times rather than below,
   * because it is the thing that decides whether a reader wants this track
   * at all and the times are the thing they read once they do. */
  const tags = el('div', 'tags');
  for (const id of tagsOf(track)) {
    tags.append(el('span', null, tagLabel(id)));
  }
  body.append(tags);

  const podium = el('ol', 'podium');
  podium.hidden = true;
  body.append(podium);

  const none = el('p', 'none', 'No time posted yet');
  none.hidden = Boolean(track.best);
  body.append(none);

  const actions = el('div', 'actions');
  const fly = el('a', 'btn primary small', 'Fly this track');
  fly.href = flyHref(config, track.id);
  fly.target = SIM_WINDOW;
  fly.setAttribute('aria-label', `Fly ${track.name}, opens it in the simulator tab`);
  const more = el('a', 'text more');
  more.href = courseHref(track.id);
  more.textContent = track.times > 3 ? `All ${plural(track.times, 'time', 'times')}` : 'Track detail';
  actions.append(fly, more);
  body.append(actions);

  card.append(body);
  return card;
}

/*
 * The top three, once a track's times have arrived. Called after the
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
  const config = state.config;
  times.slice(0, 3).forEach((row, i) => {
    const li = el('li', `podium-row r${i + 1}`);
    li.append(el('span', 'rk', String(i + 1)));
    li.append(el('span', 'nm', row.name));
    li.append(timeNode(row.lapMs, 'tm'));
    if (row.hasGhost && row.id) {
      li.classList.add('has-chase');
      li.append(chaseLink(config, card.dataset.id, row));
    }
    podium.append(li);
  });
  if (more) {
    more.textContent = times.length > 3
      ? `All ${plural(times.length, 'time', 'times')}`
      : 'Track detail';
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
      ? plural(state.courses.length, 'track', 'tracks')
      : `${shown.length} of ${plural(state.courses.length, 'track', 'tracks')}`;
  }
  if (!shown.length && state.courses.length) {
    /*
     * Say WHICH filter emptied the list. There are three of them now, and
     * "nothing matches that" in front of a reader who set a search two
     * minutes ago and an author just now does not say which one to undo.
     */
    const parts = [];
    if (state.query.trim()) {
      parts.push(`the search "${state.query.trim()}"`);
    }
    if (state.author) {
      parts.push(`tracks built by ${state.author}`);
    }
    if (state.tags.size) {
      parts.push(`${[...state.tags].map(tagLabel).join(' and ')}`);
    }
    const box = el('div', 'empty panel');
    box.append(el('h2', null, 'Nothing matches that'));
    box.append(el('p', null, parts.length
      ? `No track on the board is ${joined(parts)}.`
      : 'No track on the board answers to that.'));
    const clear = el('button', 'btn small', 'Clear the filters');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      const find = byId('find');
      const by = byId('by');
      state.query = '';
      state.author = '';
      state.tags.clear();
      if (find) {
        find.value = '';
      }
      if (by) {
        by.value = '';
      }
      paintTags();
      paintGrid();
      if (find) {
        find.focus();
      }
    });
    box.append(clear);
    notice.append(box);
  }
}

/* ------------------------------------------------------------------ */
/* The tag bar and the author list                                     */
/* ------------------------------------------------------------------ */

/*
 * A closed vocabulary is what makes a filter possible, so the bar is the
 * whole list rather than the tags that happen to be in use: a reader can
 * see that "Showcase" exists and that nobody has built one, which is more
 * useful than the tag not being there. A tag no track wears is disabled
 * rather than hidden, so the bar does not reflow every time a filter moves.
 */
function paintTags() {
  const bar = byId('tagbar');
  if (!bar) {
    return;
  }
  const counts = tagCounts(poolBeforeTags());
  bar.textContent = '';
  bar.hidden = TAGS.length === 0;
  for (const tag of TAGS) {
    const n = counts.get(tag.id) || 0;
    const on = state.tags.has(tag.id);
    const btn = el('button', 'tag');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    /* A tag nobody wears is still pressable if it is already ON, or a
     * reader could tick their way into a filter they cannot untick. */
    btn.disabled = n === 0 && !on;
    btn.append(el('span', null, tag.label));
    btn.append(el('span', 'n', String(n)));
    btn.addEventListener('click', () => {
      if (state.tags.has(tag.id)) {
        state.tags.delete(tag.id);
      } else {
        state.tags.add(tag.id);
      }
      paintTags();
      paintGrid();
    });
    bar.append(btn);
  }
}

function paintAuthors() {
  const select = byId('by');
  if (!select) {
    return;
  }
  const held = state.author;
  select.textContent = '';
  const any = document.createElement('option');
  any.value = '';
  any.textContent = 'Anyone';
  select.append(any);
  for (const [name, n] of authors()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = n > 1 ? `${name} (${n})` : name;
    select.append(opt);
  }
  /* An author who deleted their last track between paints must not leave
   * the filter pointing at a name with nothing behind it. */
  select.value = [...select.options].some((o) => o.value === held) ? held : '';
  state.author = select.value;
}

/* ------------------------------------------------------------------ */
/* Standings                                                           */
/* ------------------------------------------------------------------ */

/*
 * A pilot's standing is how many tracks they hold, not how many laps
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
  table.append(el('p', 'rail-note', 'Ranked by track records held, then podiums, then laps posted.'));
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
        plural(n, 'track', 'tracks'),
        plural(times, 'time', 'times'),
        pilots ? plural(pilots, 'pilot', 'pilots') : '',
        state.runs && state.runs.length ? plural(state.runs.length, 'run', 'runs') : '',
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
  /* The sheet and the background fill can both want the same track, and
   * a shared promise is cheaper than a second request. */
  if (inflight.has(id)) {
    return inflight.get(id);
  }
  const run = (async () => {
    const res = await fetch(here(`api/tracks/${encodeURIComponent(id)}`));
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
  paintSwitch();
}

/* ------------------------------------------------------------------ */
/* The freestyle board                                                 */
/* ------------------------------------------------------------------ */

/*
 * A score, with thousands separators and no locale. Same reason the
 * simulator's formatScore does it by hand: a score reads the same way in
 * every language this ships in, and Intl builds a formatter object per
 * call for a job that is a loop over three characters.
 */
function formatScore(n) {
  let digits = String(Math.round(Math.abs(Number(n) || 0)));
  let out = '';
  while (digits.length > 3) {
    out = `,${digits.slice(-3)}${out}`;
    digits = digits.slice(0, -3);
  }
  return digits + out;
}

/* 2:00, from the run's own clock. A run is two minutes, so this is almost
 * always the same string, and it is printed anyway because a run that ended
 * early is exactly the case a reader wants to see. */
function formatRunTime(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  const m = Math.floor(total / 60);
  return `${m}:${String(total - m * 60).padStart(2, '0')}`;
}

function freestyleHref(config) {
  return `${config.simOrigin}/?map=city&board=${encodeURIComponent(config.boardOrigin)}`;
}

function visibleRuns() {
  const runs = state.runs || [];
  return state.style ? runs.filter((r) => r.style === state.style) : runs;
}

/*
 * One high score row.
 *
 * The first line is the arcade: rank, name, a dot leader, a score, all
 * fixed pitch and all upper case. The second is prose in the page's own
 * voice, because "31 tricks, best chain 9,100" is a sentence about a run
 * and not a readout, and putting it in the cabinet's face too would make
 * the row shout twice.
 */
function runRow(run, i) {
  const li = el('li', `hs-row${i < 3 ? ` top${i + 1}` : ''}`);
  li.append(el('span', 'hs-rank', String(i + 1).padStart(2, '0')));
  li.append(el('span', 'hs-name', run.name));
  li.append(el('span', 'hs-dots'));
  li.append(el('span', 'hs-score', formatScore(run.score)));

  const of = el('p', 'hs-of');
  const bits = [];
  bits.push(`${plural(run.tricks, 'trick', 'tricks')}, ${run.unique} of them different`);
  if (run.bestCombo > 0) {
    bits.push(`best chain ${formatScore(run.bestCombo)}`);
  }
  if (run.signature) {
    bits.push(`biggest was a ${run.signature}`);
  }
  bits.push(run.crashes === 0 ? 'no crashes' : plural(run.crashes, 'crash', 'crashes'));
  bits.push(formatRunTime(run.durationMs));
  of.append(joined(bits));
  /*
   * The physics model, named rather than ranked separately. Arcade turns
   * off propwash, gyro noise and build asymmetry, so it is an easier
   * machine and an arcade run is not the same sport as an expert one.
   * Hiding that and ranking them together would be the board lying by
   * omission; a separate table would split a small board in half. So both
   * are here, both are labelled, and the reader has a filter.
   */
  const model = el('span', `hs-model${run.style === 'arcade' ? ' easy' : ''}`, run.style);
  model.title = run.style === 'arcade'
    ? 'Flown on the arcade physics model: no propwash, no gyro noise, no build asymmetry'
    : 'Flown on the full physics model';
  of.append(model);
  of.append(` \u00b7 ${formatAgo(run.postedUtc)}`);
  li.append(of);
  return li;
}

function paintArcade() {
  const host = byId('arcade-board');
  const countCell = byId('run-count');
  if (!host) {
    return;
  }
  host.textContent = '';
  const config = state.config;

  if (state.runs === null) {
    host.append(el('div', 'screenbox', state.runsError || 'Reading the board.'));
    if (countCell) {
      countCell.textContent = '';
    }
    return;
  }

  const runs = visibleRuns();
  if (countCell) {
    countCell.textContent = runs.length === (state.runs || []).length
      ? plural(runs.length, 'run', 'runs')
      : `${runs.length} of ${plural(state.runs.length, 'run', 'runs')}`;
  }

  const screen = el('div', 'screenbox');
  if (!runs.length) {
    const empty = el('div', 'hs-empty');
    /*
     * The one blinking thing on the page, and it is the one an arcade
     * cabinet blinks: the prompt on an empty attract screen. It carries
     * nothing the paragraph under it does not say, so reduced motion
     * stopping it hides no meaning.
     */
    empty.append(el('span', 'coin', state.style ? 'No runs on that model' : 'Be the first'));
    empty.append(el('p', null, state.style
      ? 'Nobody has posted a run on that physics model yet. Try both, or go and fly one.'
      : 'Nobody has posted a freestyle run yet. Open the town, fly for two minutes, and put your name at the top of an empty board.'));
    const actions = el('div', 'actions');
    const fly = el('a', 'btn primary', 'Fly the town');
    fly.href = freestyleHref(config);
    fly.target = SIM_WINDOW;
    actions.append(fly);
    empty.append(actions);
    screen.append(empty);
    host.append(screen);
    return;
  }

  const list = el('ol', 'hs');
  runs.forEach((run, i) => list.append(runRow(run, i)));
  screen.append(list);
  host.append(screen);

  const foot = el('div', 'hs-foot');
  foot.append(el('p', null, 'One entry per pilot, and only your best. Scores are what the simulator reports, so they are as honest as the pilot who posted them.'));
  const fly = el('a', 'btn primary', 'Fly a run');
  fly.href = freestyleHref(config);
  fly.target = SIM_WINDOW;
  foot.append(fly);
  host.append(foot);
}

/* ------------------------------------------------------------------ */
/* The switch between the two boards                                   */
/* ------------------------------------------------------------------ */

/*
 * ?view=freestyle, not #freestyle. route() owns the hash and clearHash()
 * wipes it whole, so a hash tab would be thrown away by Escape and by the
 * sheet's Close button. The query string survives both, and a track sheet
 * therefore still opens over either board and closes back onto it.
 */
function viewFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get('view') === 'freestyle'
      ? 'freestyle'
      : 'tracks';
  } catch (e) {
    return 'tracks';
  }
}

function writeView(view) {
  try {
    const url = new URL(window.location.href);
    if (view === 'freestyle') {
      url.searchParams.set('view', 'freestyle');
    } else {
      url.searchParams.delete('view');
    }
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (e) {
    /* No history, as in a very old browser. The page still works. */
  }
}

function showView(view, { write = true } = {}) {
  state.view = view === 'freestyle' ? 'freestyle' : 'tracks';
  const on = state.view === 'freestyle';
  const tracks = byId('view-tracks');
  const free = byId('view-freestyle');
  if (tracks) {
    tracks.hidden = on;
  }
  if (free) {
    free.hidden = !on;
  }
  for (const [id, lit] of [['switch-tracks', !on], ['switch-freestyle', on]]) {
    const btn = byId(id);
    if (btn) {
      btn.classList.toggle('is-on', lit);
      btn.setAttribute('aria-pressed', lit ? 'true' : 'false');
    }
  }
  if (write) {
    writeView(state.view);
  }
  if (on) {
    paintArcade();
  }
}

function paintSwitch() {
  const tracksCell = byId('switch-tracks-count');
  const runsCell = byId('switch-runs-count');
  if (tracksCell) {
    tracksCell.textContent = state.courses.length
      ? plural(state.courses.length, 'track', 'tracks')
      : '';
  }
  if (runsCell) {
    runsCell.textContent = state.runs && state.runs.length
      ? plural(state.runs.length, 'run', 'runs')
      : '';
  }
}

/* ------------------------------------------------------------------ */
/* The track sheet                                                    */
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
  frame.title = `${track.name}, a flight through the track`;
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.src = orbitHref(state.config, track.id);
  const wait = el('div', 'shot-wait');
  wait.append(el('span', 'shot-dot'), el('span', null, 'Flying the track'));
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
  for (const [cls, label] of [['rank', ''], ['nm', 'Pilot'], ['time', 'Time'], ['gap', 'Gap'], ['when', 'Posted'], ['chase', '']]) {
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

    /* Times posted with a recorded lap can be chased in the simulator; the
     * rest hold an empty cell so the columns stay put. */
    const chase = el('td', 'chase');
    if (row.hasGhost && row.id) {
      chase.append(chaseLink(state.config, track.id, row));
    }
    tr.append(chase);
    body.append(tr);
  });
  table.append(body);
  host.append(table);
}

function paintHero(host, track, times) {
  host.textContent = '';
  const best = times.length ? times[0] : track.best;
  /* An empty hero is a row of dashes the size of a headline, so a track
   * with no record does not get one. The board below says it in words. */
  host.hidden = !best;
  if (!best) {
    return;
  }
  host.append(el('span', 'record-label', 'Track record'));
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
    : 'Open track';
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
  /* First, because it is what the track is FOR, and the gate count and the
   * field size are what it is made of. */
  if (tagsOf(track).length) {
    factRow(facts, 'Built for', tagsOf(track).map(tagLabel).join(', '));
  }
  factRow(facts, 'Gates', plural(track.gates, 'gate', 'gates'));
  factRow(facts, 'Elements', track.elements);
  factRow(facts, 'Field', fieldSize(track));
  factRow(facts, 'Updated', formatAgo(track.updatedUtc));
  if (track.hasLogo) {
    factRow(facts, 'Branding', 'Sponsor print');
  }

  const actions = byId('sheet-actions');
  actions.textContent = '';
  const fly = el('a', 'btn primary', 'Fly this track');
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
  for (const node of [document.querySelector('.mast'), document.querySelector('.spine'), byId('tracks'), document.querySelector('footer')]) {
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
/* Routing. A track is an address, so it can be linked and shared.    */
/* ------------------------------------------------------------------ */

function route() {
  const hash = location.hash;
  if (hash === '#credits') {
    /* Old bookmarks, and the three Credits links before bindLinks ran,
     * used to open an overlay copy of the roll. Take this tab to the
     * simulator's credits page instead. */
    window.location.replace(creditsHref(state.config));
    return;
  }
  /*
   * #track= is what the address bar shows now, and #course= is what every
   * link shared before this change says. Both are read, one is written.
   *
   * The board's whole point is that a track is a URL somebody can send to
   * somebody else, so a rename that quietly broke the ones already sent
   * would be the worst possible way to fix a noun. The old spelling is
   * accepted for reading and then REWRITTEN in place, so a visitor arriving
   * on an old link lands on the right track and leaves with a link that
   * says track.
   */
  const found = hash.match(/^#(?:track|course)=(.+)$/);
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
    /* Arrived on the old spelling: put the canonical one in the address bar
     * without adding a history entry, so Back still goes where it went. */
    if (hash.startsWith('#course=')) {
      history.replaceState(null, '', courseHref(track.id));
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
  const credits = creditsHref(config);
  /* These used to navigate this tab, which left the visitor with a
   * simulator where the board had been and no way back but the back
   * button. They go to the simulator's tab now, the same one Fly this
   * track uses, so the board stays open behind it and a second click
   * does not make a second simulator. Credits is the same tab, on
   * the simulator's #credits page. */
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
  set('mast-credits', credits);
  set('spine-credits', credits);
  set('foot-credits', credits);
}

function bindToolbar() {
  const find = byId('find');
  const sort = byId('sort');
  const by = byId('by');
  if (find) {
    find.addEventListener('input', () => {
      state.query = find.value;
      /* The tag counts are measured against everything the OTHER filters
       * leave standing, so they move when the search does. */
      paintTags();
      paintGrid();
    });
    find.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && find.value) {
        e.stopPropagation();
        find.value = '';
        state.query = '';
        paintTags();
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
  if (by) {
    by.addEventListener('change', () => {
      state.author = by.value;
      paintTags();
      paintGrid();
    });
  }
}

function bindSwitch() {
  for (const [id, view] of [['switch-tracks', 'tracks'], ['switch-freestyle', 'freestyle']]) {
    const btn = byId(id);
    if (btn) {
      btn.addEventListener('click', () => showView(view));
    }
  }
  const style = byId('style');
  if (style) {
    style.value = state.style;
    style.addEventListener('change', () => {
      state.style = style.value;
      paintArcade();
    });
  }
}

/*
 * The freestyle board, fetched once. It is NOT fatal and it is not awaited
 * before the tracks paint: a board whose freestyle table is down should
 * still show forty tracks, and the switch says how many runs there are so
 * it has to be able to say none.
 */
async function loadRuns() {
  try {
    const res = await fetch(here('api/runs'));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `The board answered ${res.status}.`);
    }
    state.runs = body.runs || [];
    /* The tag vocabulary rides along with this request rather than having
     * one of its own: it is small, it is served from the same file that
     * decides which tags are legal, and one request is one request. */
    if (Array.isArray(body.tags) && body.tags.length) {
      TAGS = body.tags;
      TAG_LABEL.clear();
      for (const tag of TAGS) {
        TAG_LABEL.set(tag.id, tag.label);
      }
    }
  } catch (e) {
    state.runs = null;
    state.runsError = e.message || 'The freestyle board could not be loaded.';
  }
  paintSwitch();
  paintTags();
  /* Repaint the cards, because the tag labels arrived with this request and
   * the cards drew their tags before they had names for them. */
  if (state.courses.length) {
    paintGrid();
  }
  if (state.view === 'freestyle') {
    paintArcade();
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
   * origin, so the bugs page and a track hash keep the claim. */
  window.name = BOARD_WINDOW;
  window.addEventListener('hashchange', route);
  if (location.hash === '#credits') {
    route();
    return;
  }
  watchSpine();
  watchOrbit();
  watchKeys();
  watchResize();
  bindCredits();

  const list = byId('list');
  const notice = byId('notice');
  skeletons(list, 6);

  /*
   * The status matters. Reading the body and ignoring `r.ok` meant a 500
   * from the database, or a 502 from in front of it, parsed to an object
   * with no `tracks` in it and painted "The board is empty": the one screen
   * that tells a visitor to go and build the first track, shown while
   * every track on the board was sitting there unreachable. An error
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

  /*
   * BIND THE LINKS BEFORE ASKING THE SERVER ANYTHING.
   *
   * Every cross-origin href in the HTML is a loopback address, written there
   * so the page still works from a checkout. bindLinks used to be the only
   * thing that replaced them and it ran inside the try below, after the
   * config request: one failed request and a public board kept them, so
   * Open the simulator, Build a track and Credits all pointed at a machine
   * the visitor is not sitting at. The guess is right on both layouts that
   * can be derived from this page's own address, so bind it now and let the
   * served config correct it if and when it arrives.
   */
  bindLinks(state.config);

  /*
   * THE SWITCH IS BOUND AND SHOWN BEFORE ANYTHING IS FETCHED.
   *
   * start() returns early in three places below, on a failed tracks
   * request and on an empty board, and an empty board is exactly the board
   * a new feature launches on. A freestyle section wired after those
   * returns would be invisible on the one board that most needs it, so it
   * is wired here, before the first request, and the runs request is fired
   * without being awaited.
   */
  bindSwitch();
  showView(viewFromUrl(), { write: false });
  const runsLoaded = loadRuns();

  /*
   * The config request is NOT fatal, and the tracks request is.
   *
   * They used to share one try, so a 500 on config threw the whole page away
   * including a board full of tracks that would have loaded. The only thing
   * config carries is simOrigin, which guessSimOrigin has already answered,
   * so losing it costs the links nothing on either derivable layout.
   */
  try {
    /* simOrigin from the board, because only the board knows it: it is the
     * one case a page standing at its own address cannot work out, a board
     * and a simulator on unrelated hosts. boardOrigin from this page,
     * because only this page does. See HERE_ORIGIN above. */
    const served = await getJson(here('api/config'));
    state.config = { ...state.config, ...served, boardOrigin: HERE_ORIGIN };
    bindLinks(state.config);
  } catch (e) {
    /* Deliberately quiet. Nothing a visitor can act on, the links are
     * already bound, and the tracks request below is about to say
     * something far more useful if the board is genuinely down. */
  }

  try {
    const payload = await getJson(here('api/tracks'));
    state.courses = payload.tracks || [];
  } catch (e) {
    list.textContent = '';
    notice.append(el('div', 'status panel', e.message || 'The board could not be loaded.'));
    await runsLoaded;
    return;
  }

  paintStats();
  paintSwitch();
  if (!state.courses.length) {
    list.textContent = '';
    const box = el('div', 'empty panel');
    box.append(el('h2', null, 'The board is empty'));
    box.append(el('p', null, 'Build a track in the track builder, set a flying order, and publish it. The board starts when the first track lands.'));
    const build = el('a', 'btn primary', 'Build a track');
    build.href = `${state.config.simOrigin}/src/trackbuilder/index.html`;
    build.target = SIM_WINDOW;
    box.append(build);
    notice.append(box);
    await runsLoaded;
    return;
  }

  byId('toolbar').hidden = false;
  bindToolbar();
  paintAuthors();
  paintTags();
  paintGrid();
  route();
  await hydrate();
  await runsLoaded;
}

start();
