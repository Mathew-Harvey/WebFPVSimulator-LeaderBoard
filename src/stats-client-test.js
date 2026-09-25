/*
 * Client-side stats.js tests running in Node.
 *
 * Loads public/stats.js with stubbed browser APIs (window, document,
 * location, sessionStorage, localStorage, navigator, fetch/sendBeacon).
 * Tests the client functions that extract, normalize, and store attribution.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVLeaderboard is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY, without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with WebFPVLeaderboard. If not, see <https://www.gnu.org/licenses/>.
 */

import { URL } from 'url';

let failed = 0;

function check(name, pass) {
  if (!pass) {
    console.error(`  FAIL  ${name}`);
    failed = 1;
  } else {
    console.log(`  pass  ${name}`);
  }
}

/* Stub browser environment for loading stats.js in Node. */
function createBrowserStubs() {
  const storage = new Map();
  const sessionStore = new Map();
  const sentEvents = [];

  const stubs = {
    window: {},
    document: { referrer: '' },
    location: { hostname: 'webfpv.org', href: 'https://webfpv.org/board/' },
    localStorage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    sessionStorage: {
      getItem: (k) => sessionStore.get(k) || null,
      setItem: (k, v) => sessionStore.set(k, v),
      removeItem: (k) => sessionStore.delete(k),
    },
    navigator: {
      globalPrivacyControl: false,
      doNotTrack: '0',
      sendBeacon: (url, data) => {
        sentEvents.push({ url, data, method: 'sendBeacon' });
        return true;
      },
    },
    fetch: (url, opts) => {
      sentEvents.push({ url, ...opts, method: 'fetch' });
      return Promise.resolve({ ok: true });
    },
    Blob: class {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options?.type || '';
      }
    },
    URL,
    sentEvents,
    storage,
    sessionStore,
  };

  /* history stub for captureSource. */
  stubs.window.history = { replaceState: () => {} };
  stubs.window.location = stubs.location;

  return stubs;
}

/* Load stats.js with stubbed globals. */
async function loadStatsModule(stubs) {
  /* Inject stubs into global scope, skipping read-only properties. */
  const originalGlobals = {};
  for (const [key, value] of Object.entries(stubs)) {
    try {
      if (key in global) {
        originalGlobals[key] = global[key];
      }
      global[key] = value;
    } catch (e) {
      /* Read-only property (e.g. navigator in some Node versions).
       * Try to override via Object.defineProperty. */
      try {
        const descriptor = Object.getOwnPropertyDescriptor(global, key);
        if (descriptor) {
          originalGlobals[key] = { value: global[key], descriptor };
        }
        Object.defineProperty(global, key, {
          value,
          writable: true,
          configurable: true,
        });
      } catch (e2) {
        /* Still can't override. Skip it and hope the module doesn't use it. */
        console.warn(`Warning: Could not stub global.${key}`);
      }
    }
  }

  /* Import stats.js with a cache-busting query to get a fresh module instance. */
  const cacheBust = `?t=${Date.now()}-${Math.random()}`;
  const stats = await import(`../public/stats.js${cacheBust}`);

  /* Restore original globals. */
  for (const key of Object.keys(stubs)) {
    try {
      if (key in originalGlobals) {
        if (originalGlobals[key].descriptor) {
          Object.defineProperty(global, key, originalGlobals[key].descriptor);
        } else {
          global[key] = originalGlobals[key];
        }
      } else {
        delete global[key];
      }
    } catch (e) {
      /* Ignore restoration errors. */
    }
  }

  return stats;
}

export async function testStatsClient() {
  console.log('\nsite statistics, client side');

  /* Set up browser stubs ONCE for all tests. */
  const stubs = createBrowserStubs();
  
  /* Save original globals to restore later. */
  const originalGlobals = {
    window: global.window,
    document: global.document,
    location: global.location,
    localStorage: global.localStorage,
    sessionStorage: global.sessionStorage,
    Blob: global.Blob,
    fetch: global.fetch,
    navigator: global.navigator,
  };
  
  /* Inject stubs BEFORE importing the module. */
  global.window = stubs.window;
  global.document = stubs.document;
  global.location = stubs.location;
  global.localStorage = stubs.localStorage;
  global.sessionStorage = stubs.sessionStorage;
  global.Blob = stubs.Blob;
  global.fetch = stubs.fetch;
  
  /* Override navigator carefully (it's often read-only). */
  try {
    Object.defineProperty(global, 'navigator', {
      value: stubs.navigator,
      writable: true,
      configurable: true,
    });
  } catch (e) {
    console.warn('Could not stub navigator:', e.message);
  }

  /* Now import the module with stubs in place. */
  const stats = await import('../public/stats.js');

  /* extractHostname tests. */
  check('extractHostname: full URL becomes hostname', stats.extractHostname('https://reddit.com/r/fpv') === 'reddit.com');
  check('extractHostname: full URL with path', stats.extractHostname('http://news.ycombinator.com/item?id=123') === 'news.ycombinator.com');
  check('extractHostname: bare domain', stats.extractHostname('github.com') === 'github.com');
  check('extractHostname: subdomain', stats.extractHostname('old.reddit.com') === 'old.reddit.com');
  check('extractHostname: httpbin.org not mangled', stats.extractHostname('https://httpbin.org/get') === 'httpbin.org');
  check('extractHostname: httpbin.org bare domain', stats.extractHostname('httpbin.org') === 'httpbin.org');
  check('extractHostname: invalid returns null', stats.extractHostname('not a url!!!') === null);

  /* isSameHost tests. */
  check('isSameHost: exact match', stats.isSameHost('webfpv.org', { hostname: 'webfpv.org' }));
  check('isSameHost: www stripped on both sides', stats.isSameHost('www.webfpv.org', { hostname: 'webfpv.org' }));
  check('isSameHost: www stripped on hostname', stats.isSameHost('www.webfpv.org', { hostname: 'www.webfpv.org' }));
  check('isSameHost: www stripped asymmetric', stats.isSameHost('webfpv.org', { hostname: 'www.webfpv.org' }));
  check('isSameHost: different domain', !stats.isSameHost('reddit.com', { hostname: 'webfpv.org' }));
  check('isSameHost: null hostname', !stats.isSameHost(null, { hostname: 'webfpv.org' }));

  /* referrerDomain tests: same-host becomes null. */
  check('referrerDomain: same-host becomes null', 
    stats.referrerDomain(
      { referrer: 'https://webfpv.org/' },
      { hostname: 'webfpv.org', href: 'https://webfpv.org/board/' }
    ) === null);

  /* referrerDomain tests: same-host with www. becomes null. */
  check('referrerDomain: www.webfpv.org → webfpv.org is same-host', 
    stats.referrerDomain(
      { referrer: 'https://www.webfpv.org/' },
      { hostname: 'webfpv.org', href: 'https://webfpv.org/board/' }
    ) === null);

  /* referrerDomain tests: external referrer. */
  check('referrerDomain: external referrer returns hostname', 
    stats.referrerDomain(
      { referrer: 'https://reddit.com/r/fpv' },
      { hostname: 'webfpv.org', href: 'https://webfpv.org/board/' }
    ) === 'reddit.com');

  /* referrerDomain tests: ?referrer= parameter takes priority. */
  check('referrerDomain: ?referrer= parameter takes priority', 
    stats.referrerDomain(
      { referrer: 'https://webfpv.org/' },
      { hostname: 'webfpv.org', href: 'https://webfpv.org/board/?referrer=news.ycombinator.com' }
    ) === 'news.ycombinator.com');

  /* referrerDomain tests: ?referrer= with full URL. */
  check('referrerDomain: ?referrer= with full URL becomes hostname', 
    stats.referrerDomain(
      { referrer: '' },
      { hostname: 'webfpv.org', href: 'https://webfpv.org/board/?referrer=https://old.reddit.com/r/fpv' }
    ) === 'old.reddit.com');

  /* normaliseRefTag tests. */
  check('normaliseRefTag: lowercases', stats.normaliseRefTag('REDDIT') === 'reddit');
  check('normaliseRefTag: trims', stats.normaliseRefTag('  hn  ') === 'hn');
  check('normaliseRefTag: strips non-alphanumeric except hyphens', stats.normaliseRefTag('my-ref!') === 'my-ref');
  check('normaliseRefTag: caps at 16 chars', stats.normaliseRefTag('a'.repeat(20)).length === 16);
  check('normaliseRefTag: empty after strip returns null', stats.normaliseRefTag('!!!') === null);

  /* storeSessionAttribution and sessionAttribution tests. */
  stubs.sessionStore.clear();
  
  /* Store and retrieve. */
  stats.storeSessionAttribution('reddit.com', 'hn');
  const attr1 = stats.sessionAttribution();
  check('sessionAttribution: stored values retrieved', 
    attr1.referrer === 'reddit.com' && attr1.ref === 'hn');

  /* Null clears session value. */
  stats.storeSessionAttribution(null, null);
  const stored = stubs.sessionStore.get('webfpv.session.attribution');
  const parsed = stored ? JSON.parse(stored) : {};
  check('sessionAttribution: null clears both values', 
    parsed.referrer === null && parsed.ref === null);

  /* Partial store (only referrer). */
  stubs.sessionStore.clear();
  stats.storeSessionAttribution('github.com', null);
  const attr3 = stats.sessionAttribution();
  check('sessionAttribution: partial store (referrer only)', 
    attr3.referrer === 'github.com' && attr3.ref === null);

  /* Partial store (only ref). */
  stubs.sessionStore.clear();
  stats.storeSessionAttribution(null, 'x');
  const attr4 = stats.sessionAttribution();
  check('sessionAttribution: partial store (ref only)', 
    attr4.referrer === null && attr4.ref === 'x');

  /* sendEvent tests: fresh payload beats stale session. */
  stubs.storage.clear();
  stubs.sessionStore.clear();
  stubs.sentEvents.length = 0;
  
  /* Ensure counting is enabled (not opted out, no GPC). */
  if (stats.optedOut()) {
    stats.setOptedOut(false);
  }
  
  /* Store stale attribution. */
  stats.storeSessionAttribution('old.reddit.com', 'oldref');
  
  /* Send with fresh payload (explicit values). */
  stats.sendEvent({ kind: 'session', craft: '5inch', map: 'custom', input: 'gamepad', referrer: 'github.com', ref: 'gh' }, 'https://webfpv.org/api/stats');
  
  if (stubs.sentEvents.length > 0) {
    const sent1 = stubs.sentEvents[0];
    /* Extract body from Blob if using sendBeacon. */
    let bodyText = sent1.body;
    if (sent1.data && sent1.data.parts) {
      bodyText = sent1.data.parts[0];
    }
    const body1 = JSON.parse(bodyText);
    check('sendEvent: fresh payload beats stale session (referrer)', body1.referrer === 'github.com');
    check('sendEvent: fresh payload beats stale session (ref)', body1.ref === 'gh');
  } else {
    check('sendEvent: fresh payload beats stale session (referrer)', false);
    check('sendEvent: fresh payload beats stale session (ref)', false);
    console.log('  (sendEvent did not send; counting()=' + stats.counting() + ')');
  }

  /* Send with explicit null (same-origin visit). */
  stubs.sentEvents.length = 0;
  stats.sendEvent({ kind: 'visit', surface: 'board', returning: false, referrer: null, ref: null }, 'https://webfpv.org/api/stats');
  
  if (stubs.sentEvents.length > 0) {
    const sent2 = stubs.sentEvents[0];
    let bodyText2 = sent2.body;
    if (sent2.data && sent2.data.parts) {
      bodyText2 = sent2.data.parts[0];
    }
    const body2 = JSON.parse(bodyText2);
    check('sendEvent: explicit null not re-credited from stale session (referrer)', body2.referrer === null);
    check('sendEvent: explicit null not re-credited from stale session (ref)', body2.ref === null);
  } else {
    check('sendEvent: explicit null not re-credited from stale session (referrer)', false);
    check('sendEvent: explicit null not re-credited from stale session (ref)', false);
  }

  /* Send without referrer/ref in payload (should use session). */
  stubs.sentEvents.length = 0;
  stats.storeSessionAttribution('youtube.com', 'yt');
  stats.sendEvent({ kind: 'flush', tab: 'aaaa1111', craft: 'whoop65', laps: 5, flightS: 30 }, 'https://webfpv.org/api/stats');
  
  if (stubs.sentEvents.length > 0) {
    const sent3 = stubs.sentEvents[0];
    let bodyText3 = sent3.body;
    if (sent3.data && sent3.data.parts) {
      bodyText3 = sent3.data.parts[0];
    }
    const body3 = JSON.parse(bodyText3);
    check('sendEvent: session attribution attached to flush event (referrer)', body3.referrer === 'youtube.com');
    check('sendEvent: session attribution attached to flush event (ref)', body3.ref === 'yt');
  } else {
    check('sendEvent: session attribution attached to flush event (referrer)', false);
    check('sendEvent: session attribution attached to flush event (ref)', false);
  }

  /* GPC and opt-out tests. */
  /* Reset to clean state. */
  stubs.navigator.globalPrivacyControl = false;
  stats.setOptedOut(false);
  
  /* Test GPC. */
  stubs.navigator.globalPrivacyControl = true;
  check('privacyRefused: GPC enabled', stats.privacyRefused());
  check('counting: GPC blocks counting', !stats.counting());
  
  /* Reset GPC, test opt-out. */
  stubs.navigator.globalPrivacyControl = false;
  stats.setOptedOut(true);
  check('optedOut: after setOptedOut(true)', stats.optedOut());
  check('counting: opt-out blocks counting', !stats.counting());

  /* Send under GPC: sendEvent should not send. */
  stats.setOptedOut(false);
  stubs.navigator.globalPrivacyControl = true;
  stubs.sentEvents.length = 0;
  stats.sendEvent({ kind: 'visit', surface: 'board', returning: false }, 'https://webfpv.org/api/stats');
  check('sendEvent: nothing sent under GPC', stubs.sentEvents.length === 0);

  /* Send under opt-out: sendEvent should not send. */
  stubs.navigator.globalPrivacyControl = false;
  stats.setOptedOut(true);
  stubs.sentEvents.length = 0;
  stats.sendEvent({ kind: 'visit', surface: 'board', returning: false }, 'https://webfpv.org/api/stats');
  check('sendEvent: nothing sent under opt-out', stubs.sentEvents.length === 0);

  /* storeSessionAttribution under GPC: should not throw. */
  stats.setOptedOut(false);
  stubs.navigator.globalPrivacyControl = true;
  stubs.sessionStore.clear();
  stats.storeSessionAttribution('test.com', 'test');
  check('storeSessionAttribution: does not throw under GPC', true);

  /* Restore original globals to avoid polluting other tests. */
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      delete global[key];
    } else {
      try {
        global[key] = value;
      } catch (e) {
        /* Some properties might be read-only, ignore. */
      }
    }
  }

  return failed;
}
