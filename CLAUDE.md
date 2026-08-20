# CLAUDE.md

Project conventions. Read fully before any turn. These are decisions already made, not options.

## What this is

The public board for WebFPVSimulator. One Node service and one Postgres. It stores published courses and the times flown on them, and it serves a single static page that reads them back. It is not the simulator and it does not render anything: every course thumbnail on the board is the simulator's own `src/share/orbit.html`, in a cross origin iframe.

The three repositories are one product. `Mathew-Harvey/WebFPVSimulator` holds the simulator and the track builder and is the copy of record for anything shared; `Mathew-Harvey/landingpage-WebFPVSimulator-` is the front door. Read the simulator's `CLAUDE.md` before changing anything that has to agree across the three, and `DEPLOY.md` there for how they are wired together.

## Decisions already made

**Licence is GPLv3.** Every file gets a header. Do not add a dependency with an incompatible licence.

**One runtime dependency, `pg`, and it is the only one.** The page has none at all: no framework, no bundler, no build step. Adding one needs an argument first.

**The page's styles are inline in the HTML.** Same reason as the simulator's: the styling must not depend on a server's MIME table.

**The palette is the simulator's, unchanged.** Cream for lit type, sakura for chrome, amber for an instrument, mint for a record, slate for type that should recede. A visitor arriving here from the simulator or the builder is looking at the same furniture, and that is deliberate.

**Every response is credential free.** No cookie, no Authorization header, no session. Reflecting the request origin is therefore the same grant as `*`, and it is written that way so that adding credentials later fails closed rather than silently sharing them.

**The site icon comes from the simulator's `scripts/icons.js`.** `public/icon.svg`, `public/favicon.ico` and `public/apple-touch-icon.png` are generated output, in mint, which is the colour this page paints a record in. Regenerate, do not edit: `node scripts/icons.js mint ../WebFPVSimulator-LeaderBoard/public` from a checkout of the simulator beside this one.

## Style

- Plain JavaScript. No TypeScript, no framework, no state library.
- Prefer one file doing an obvious thing over three files doing a clever thing.
- No em dashes or en dashes in prose, comments, commit messages or documentation. Use a comma, colon or full stop.
- Long explanatory comments that say why, not what. Match the voice already in `src/server.js` and `public/index.html`.

## Working rules

- `npm test` runs `src/selftest.js` and is cheap. Run it for anything touching the store, the API surface or validation.
- Never report a check as passing without having run it in the same turn. If a check was not run, say so, say why, and say what was done instead. A green check that cannot see the thing that changed is not evidence either.
- The simulator's `npm run verify` is expensive and does not cover this repository. Do not reach for it here.
- Never change a threshold to make a check pass. Argue for the change instead.

## Review

- **Do not run adversarial review, multi agent review or a review workflow unless directed.** Read your own diff, run the cheap checks, and hand the work over. Fan out only when the request asks for it.
- When a review does run, its findings are written down whether or not they were acted on, and a finding that was declined is recorded with the reason.
