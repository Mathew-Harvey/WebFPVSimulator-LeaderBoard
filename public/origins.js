/*
 * origins.js: where the simulator is, worked out without asking the server.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 */

/*
 * /api/config is the authority and still outranks everything here. But
 * bindLinks used to run only after that request came back, and the hrefs
 * written into the HTML are loopback addresses. So one failed request, a
 * database down, a 502 in front of the service, a browser offline, left
 * every link on a public board pointed at http://127.0.0.1:8000 with
 * nothing saying so. A visitor clicking Open the simulator got a connection
 * refused for a simulator that was up the whole time.
 *
 * DRL Simulator gated startup on a login and took roughly seven years of
 * maps and leaderboard entries down with its servers in December 2025. The
 * board owns times, not the simulator, and nothing here needs the board to
 * be reachable for a link to be right.
 *
 * It lives in its own file, taking the page's address as an argument rather
 * than reading `window`, because that is what makes it checkable in Node.
 * The rest of app.js cannot be: it touches `document` at module load.
 */

/* Empty covers a file:// URL, whose hostname is ''. */
const LOOPBACK_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLoopback(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname == null ? '' : hostname));
}

/*
 * Two layouts can be answered from the board's own address, and they are the
 * two that exist:
 *
 *   loopback       the simulator is served by scripts/serve.js on port 8000,
 *                  which is what DEPLOY.md says and what every checkout does.
 *   a /board mount the simulator is its sibling at /sim, which is the
 *                  production layout: webfpv.org/board and webfpv.org/sim.
 *
 * Anything else, a board on its own host with the simulator on another one,
 * cannot be derived from here and returns null. A guess would be worse than
 * an absence: the caller leaves those links alone rather than pointing them
 * somewhere confidently wrong, and waits for /api/config, which is the one
 * case only the server can answer.
 *
 * `here` is the board page's own directory, HERE in app.js, so that a board
 * at /board/ and a bug page at /board/bugs both answer /board.
 */
export function guessSimOrigin(location, here) {
  if (!location || !here) {
    return null;
  }
  const host = location.hostname;
  if (isLoopback(host)) {
    const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${host || '127.0.0.1'}:8000`;
  }
  const path = String(here.pathname || '/').replace(/\/+$/, '');
  if (/\/board$/.test(path)) {
    return `${location.origin}${path.replace(/\/board$/, '/sim')}`;
  }
  return null;
}
