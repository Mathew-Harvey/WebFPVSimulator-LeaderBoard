# WebFPV Leaderboard

The public board for [WebFPVSimulator](https://github.com/Mathew-Harvey/WebFPVSimulator).
Every published course lives here, with the times flown on it.

The page has two tabs. **Tracks and times** is the board itself. **Freestyle
maps** is every map published from the track builder's freestyle canvas:
no gates and no clock, so no times, and a card per map drawn from the
outlines of its pieces. See [Freestyle maps](#freestyle-maps) below for how
a map is stored. **Site statistics**, in the masthead beside Admin, is a
page of counters about the product: how many are flying now, pilots and
laps by day, which countries, and what they fly on. See
[Site statistics](#site-statistics) below for what is counted and, more to
the point, what is not.

Repository: [Mathew-Harvey/WebFPVSimulator-LeaderBoard](https://github.com/Mathew-Harvey/WebFPVSimulator-LeaderBoard).

The simulator itself keeps nothing. Tracks you build stay in that browser
until you publish them. This page is the copy that other people can fly.

## How the three pages connect

The track document from the builder is the only payload. Up to five
sponsors' marks travel inside it, so a published course wears its sponsor
print on the gates, the upright banners, the flags and any footprint its
author painted on the grass. A mark on the grass is dressing rather than
layout, so adding a sponsor to a course people have already flown does not
clear the times on it.

```
Track builder                 This board                    Simulator
-------------                 ----------                    ---------
Publish  ------------------>  stores the course
                              Fly this course  ---------->  ?map=custom&share={id}
                                                            Post this time  ----->  that course's times
```

A Fly link looks like this:

```
{sim}/?map=custom&share=trk-1a2b3c4d&board={this origin}
```

The simulator fetches `/api/tracks/{id}/document`, builds the world, and
offers to post a lap time back here under the pilot's name.

The **WEBFPV** mark, in the masthead and again in the sticky spine, is the
way back to the front door, and it opens in this tab rather than the
simulator's: it is a way back, and a way back that leaves this page open
behind it is not one. Where the front door is comes from `public/origins.js`
without asking the server, the same way the simulator's address does. A
checkout finds it on `http://127.0.0.1:8080`, the `/board` mount finds
whatever it hangs off, and anything else is `https://webfpv.org`, which is
the one line a fork changes.

## Run locally

Node 22 or newer. No database required: a JSON file in `data/` is enough.

```bash
npm install
npm start          # http://127.0.0.1:3100/
```

Point the simulator at this board by leaving the default
`http://127.0.0.1:3100` in the builder's Publish dialog, or by opening a
Fly link from this page.

```bash
npm test
```

## Postgres, when you want it

Set `DATABASE_URL` and the same process uses the schema in `schema.sql`.
A local instance:

```bash
docker compose up -d
DATABASE_URL=postgres://webfpv:webfpv@127.0.0.1:5432/webfpvleaderboard npm start
```

## Host on Render

`render.yaml` here is a blueprint for a Node web service plus a Postgres
instance, wired to each other. In the dashboard: **New**, **Blueprint**,
pick this repo. That is both halves of the board.

Then set one thing by hand, under the service's **Environment**:

```
SIM_ORIGIN = https://<the simulator's static site>   # or https://webfpv.org/sim
```

No trailing slash. Until it is set the board runs fine but its Fly and
Build buttons point at `http://127.0.0.1:8000`.

Two things about hosting here that are easy to get wrong:

- **Postgres is not optional on Render.** The file store in `data/` is for
  your machine. Render's filesystem is ephemeral, so that file is wiped on
  every deploy and every restart, taking every course and every lap time
  with it. Check `GET /api/health` says `"store":"postgres"`.
- **The free Postgres instance is deleted after 30 days.** Not downgraded,
  deleted. Move to a paid instance before then if the board is meant to
  last, and check the current terms in the dashboard.

`BOARD_TRUST_PROXY` is already set to `1` in the blueprint, which is what
makes the board write `https://` Fly links from behind Render's TLS
termination rather than `http://` ones a browser refuses as mixed content.
Leave `BOARD_PUBLIC_ORIGIN` unset unless a custom domain confuses that, or
the board is mounted under a path such as `https://webfpv.org/board`, where a
forwarded host cannot carry the path and this is the only way to say it.

The full walkthrough, including the simulator's static site and the order
to create things in, is in
[DEPLOY.md in the simulator repo](https://github.com/Mathew-Harvey/WebFPVSimulator/blob/main/DEPLOY.md).

## API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/tracks` | Every published course, with its best time |
| GET | `/api/tracks/:id` | That course and its leaderboard. Each time carries `{ id, hasGhost }` |
| GET | `/api/tracks/:id/document` | The full track document, marks included |
| POST | `/api/tracks` | Publish `{ author, document, editKey?, tags? }` |
| POST | `/api/tracks/:id/times` | Post `{ name, lapMs, ghost? }` |
| GET | `/api/tracks/:id/times/:timeId/ghost` | That time's recorded lap, `{ id, name, lapMs, ghost }` |
| GET | `/api/tracks/:id/gif` | That room's card animation, as `image/gif` |
| POST | `/api/tracks/:id/gif` | Upload `{ gif, editKey? }`. Rooms only |
| GET | `/api/tracks/:id/card` | That track's share card, as `image/jpeg`. HEAD too |
| POST | `/api/tracks/:id/card` | Upload `{ card, editKey? }`, a 1200 by 630 JPEG |
| POST | `/api/tracks/:id/remove` | Take it off the board. Admin only |
| GET | `/api/maps` | Every published freestyle map, each with its drawing and no document |
| GET | `/api/maps/:id` | That map's summary |
| GET | `/api/maps/:id/document` | The map document as published, sponsor prints put back whole |
| POST | `/api/maps` | Publish `{ author, document, plan?, editKey? }` |
| GET | `/api/maps/:id/card` | That map's share card, as `image/jpeg`. HEAD too |
| POST | `/api/maps/:id/card` | Upload `{ card, editKey? }`, with the map's own key |
| POST | `/api/maps/:id/remove` | Take it off the board. Admin only |
| POST | `/api/admin/login` | Sign in `{ email, password }`, get a session token |
| GET | `/api/admin/session` | Who the bearer token is, or a 401 |
| GET | `/api/config` | `{ simOrigin, boardOrigin }` |
| POST | `/api/stats/events` | Add one counted event. Answers 204 and stores no identifier |
| GET | `/api/stats` | The statistics page's numbers. Cached twenty seconds |
| POST | `/api/bugs` | Tester submit `{ kind, title, what, expected?, steps?, reporter?, context? }` |
| GET | `/api/bugs` | Ticket summaries, newest first. `?status=open` `?kind=visual` |
| GET | `/api/bugs/:id` | One full ticket, context included |
| POST | `/api/bugs/:id` | Update `{ status, resolution }` |

A first publish returns an `editKey`. Keep it in the browser that sent
the course. Publishing the same id again without that key is refused.
Changing the flying layout clears the old times, because they were flown
on a different course.

Tags travel beside the author rather than inside the document, so
changing them never clears a time. Leaving `tags` out and sending
`tags: []` are two different requests: left out, a republish keeps the
tags the course already wears, and an empty list takes them all off. The
answer carries the `tags` the course wears afterwards.

## Signing in

**Admin** in the masthead opens a sign in panel. An address on the board's
whitelist and its password get a session token, which the page keeps in
that tab's `sessionStorage` and sends as a bearer header on the admin
routes. It runs out after twelve hours, and closing the tab ends it sooner.

Signed in, the panel is the whole of what an admin can do:

- open any track and take it off the board, with every time flown on it,
- read the bugs inbox at `/bugs` without a separate `BUGS_TOKEN`.

There is no cookie and no session on the server. The token is signed rather
than stored, with a key derived from the whitelist itself, so it survives a
restart and a second instance, and **changing a password invalidates every
token that password minted**.

### The whitelist

`BOARD_ADMINS` on the service. One entry per line, or comma separated:

```
someone@example.com:scrypt:16384:8:1:<saltHex>:<hashHex>
```

Mint one without the password reaching a shell history:

```bash
node scripts/admin-hash.js someone@example.com
```

Setting `BOARD_ADMINS` **replaces** the built-in list rather than adding to
it. That matters, because the built-in list is one address whose password
ships as an scrypt hash in `src/admin.js`: hashing keeps the word itself
out of the history of a public repository, and it does not make a short
password secret, because anybody with the hash can try guesses against it
offline. Treat the default as the thing that gets the screen working on a
checkout, and set `BOARD_ADMINS` on any host that matters.

`BOARD_SESSION_SECRET` is optional and unset by default. It is mixed into
the signing key, so changing it signs every admin out at once without
anybody's password changing.

`email:plain:the password` is also accepted, for a local checkout. It is
not the right answer on a host, and a hash is one command away.

## Taking a track off the board

A signed in admin does it from the track's own sheet: open the track,
**Take off the board**, then press again to confirm. `BOARD_ADMIN_TOKEN`
is the other way in and is what a script uses, because a script has no
browser to sign in from:

```bash
curl -X POST https://webfpv.org/board/api/tracks/trk-xxxxxxxx/remove \
  -H "Authorization: Bearer $BOARD_ADMIN_TOKEN"
```

An edit key is not a way in: it is enough to change a layout, which clears
times that were flown on a layout that no longer exists, and it is not
enough to delete other pilots' records outright.

It answers with what went: `{ id, name, author, times }`. The times go
with the track, and the id is free to publish again afterwards, which is
what makes this the way to replace a track published from a browser
nobody still has. The service logs the removal and who did it.

## Freestyle maps

A map is published the way a track is, to its own routes: nothing that
reads `/api/tracks` ever sees one, so no track reader can fly a map as a
track, and a map's edit key is kept apart from the track keys in the
simulator for the same reason.

**A map is stored as references, not as models.** The document the
builder sends is already a list of pieces, each one a type and the
modifiers that place it: position, heading, size, style, variant, a named
gap's name and points. The Hibari Yard starter is 52 pieces in about nine
kilobytes. No geometry travels and none is stored: the simulator builds
every piece from its own catalogue when the map is flown.

**A sponsor print is stored once, however many maps wear it.** The only
heavy thing a map carries is its logos, up to five embedded images. On
publish each one is taken out of the document into the `assets` table,
keyed by the sha256 of its bytes, and the document keeps `asset:<hash>` in
its place. `map_assets` records which map wears which picture, so removing
or republishing a map drops a picture only when no other map still wears
it. `GET /api/maps/:id/document` puts the images back, so the simulator is
handed exactly what the builder sent.

**The board keeps no list of piece types.** Pieces are added to the
simulator all the time, so a type is checked only for being a plausible
name, and the card's drawing is sent by the builder beside the document:
the ground outline of each piece, measured by the same code that draws the
builder's own 2D view, with a kind that picks its colour here. A piece
added next week is drawn on this board with nothing here changing. An
outline far off the plot is left off the drawing rather than refusing the
map. See `inspectMap` and `inspectMapPlan` in `src/validate.js`.

A Fly link looks like this, and flies the map in the simulator's own
freestyle world without replacing the pilot's own map there:

```
{sim}/?map=built&mapshare=trk-1a2b3c4d&board={this origin}&craft=5inch&fly=1
```

Taking a map off the board is the track's route with `maps` in it, from the
map's sheet or with `BOARD_ADMIN_TOKEN`.

## The card animation

A room's card on the board is an animation of one lap of it, not a plan.
The board renders nothing: the GIF is drawn by the browser that publishes
the room, in `src/share/cardgif.js` in the simulator, and arrives here as
bytes. A field track is refused one, in `inspectGif`, because a sixty
metre course has a plan worth drawing and `public/plan.js` draws it from
the list payload for nothing.

Rooms published before any of that existed have no animation and no
reachable edit key. The simulator's `scripts/boardgif.js` draws theirs and
uploads them with `BOARD_ADMIN_TOKEN`.

`ghost` is the simulator's recorded lap, base64 of the wire format in its
`src/share/ghostdata.js`, attached when the lap was flown in the session
that posts it. The board validates the header against that format,
mirrored in `src/validate.js`, and refuses a blob that does not match the
lap time beside it. Times posted with a ghost show a mint chase link on
the board, and the simulator's Ghost row lists them as rivals.

## The share card

Every track and every map can carry a share card: the picture a link to it
shows when somebody posts it on Facebook, X, WhatsApp, Discord, Slack or
iMessage. It is a 1200 by 630 JPEG of the thing in the simulator's own
renderer with the WebFPV wordmark over it, drawn by the browser that
publishes, in `src/share/card.js` in the simulator, and uploaded here with
the same edit key the publish used. The board renders nothing, as with the
animation; `inspectCard` holds the size, the format and the weight.

A track keeps its card through a rename and loses it with a relayout, the
animation's rule, because the simulator republishes a pilot's tracks in the
background when they change their name and draws nothing then. A map loses
its card on every republish, because nothing republishes a map but the
builder's Publish, which draws the new one straight after.

The listings carry `hasCard` and `cardUtc`, never the bytes. The picture is
named by the edge in front of webfpv.org, which writes a track's name, its
record and its card's address into a shared page's head for link preview
bots only: `edge/preview.js` in the simulator. The card's address carries
`?v=` with its stamp, so it is cached for good and a new card is a new URL.

**Copy link hands out `?track=` and `?map=`, not `#track=`.** A fragment
never leaves the browser, so a crawler asked for `#track=` fetches the
board's front page and draws the board's own card. The page swaps the query
for the hash as it loads, so everything else routes as before, and every
`#track=` link already out there still opens its sheet.

Everything published before cards existed has none and no reachable edit
key. The simulator's `scripts/boardcards.js` draws theirs and uploads them
with `BOARD_ADMIN_TOKEN`.

## Site statistics

Opened from the masthead's **Site statistics** link, beside Admin, and at
`#stats`. It was the second tab until the freestyle maps took that place. It
is **counters, never events**: the store holds one row
per UTC day and one row per day per dimension, and that is the finest grain
there is. There is no row anywhere in this repository that describes one
visitor, one visit or one lap.

What is stored, in `stats_days` and `stats_dims`:

| Counted | Where it comes from |
| --- | --- |
| Pilots, new and returning | one visit per browser per UTC day, from any of the three pages |
| Sessions | a simulator page load where the quad left the launch stand |
| Laps, flight time, crashes | deltas the simulator flushes once a minute |
| Country | two letters put on the request by the edge, never looked up here |
| Source | `direct`, a sponsor's slug, or `other` |
| Aircraft, input, map | the session that reported them |

What is **not** stored, and has no field in the wire format to arrive in: an
address, a user agent, a referrer, a screen size, a pilot name, a track id,
or any timestamp finer than the day. No cookie is set. The one per tab
string, used to answer "how many are flying now", is a random value the
browser makes at page load; the server holds it in memory for three minutes
and no table ever sees it.

New or returning is decided **by the browser**, from a first seen date it
keeps in its own local storage under `webfpv.stats.v1`. It sends the answer,
not the date.

Every dimension is a closed list, which is what stops a stranger with curl
growing a public table: `src/validate.js` refuses an aircraft or a page it
does not know, folds an unknown map or input into `other`, and
`src/sponsors.js` folds an unknown source into `other`. A flush is bounded
to what a minute can hold.

Turning it off. The page carries a **Count this browser** switch, and a
browser sending [Global Privacy
Control](https://globalprivacycontrol.org/) is never counted: the client
checks `navigator.globalPrivacyControl` and sends nothing, and the server
checks the `Sec-GPC` header and stores nothing.

### Sponsor links

`BOARD_SPONSORS` names them. One entry per line or comma separated:

```
BOARD_SPONSORS=rotorriot:Rotor Riot,fpvshop:The FPV Shop
```

A signed in admin sees each sponsor's ready link in the Admin panel:

```
{sim}/?utm_source=rotorriot&utm_medium=sponsor
```

The slug is what travels and must not change once a poster is printed; the
name is what the page prints and can. A visitor following one has the slug
stored in their own browser for thirty days and it rides on their events as
one of a handful of known words. Every `utm_` parameter is stripped from the
address bar on arrival, so a pilot who shares the link they are looking at
does not attribute their friend to a poster they never saw.

Unset is the right default and means no sponsors: every arrival is `direct`
or `other`. The statistics tab does not show the per sponsor numbers; they
are in the `sources` list that `GET /api/stats` returns, so a sponsor can
still check them without asking anybody. The list of sponsors is not
public, because it includes the ones with no traffic yet.

### The country

`edge/router.js` in the simulator's repository puts `x-webfpv-country` on
the request from Cloudflare's own `request.cf.country`, overwriting anything
the client sent. The board believes the header only when `BOARD_TRUST_PROXY`
is `1`, exactly like the forwarded host. On a checkout that is unset, so
every row is `ZZ` and the page prints Unknown. On the bare Render address
it is set and there is no Worker in front, so an honest visitor is Unknown
and a client that writes the header itself is believed: the same trust that
address already extends to `x-forwarded-for`, on a public counter, and the
reason the domain rather than the bare address is the front door.

## Bug tickets

Testers click **Report a bug** in the simulator (or press F8). The form
lands here. The inbox page is `/bugs`. Agents should use the JSON API.

Kinds: `crash`, `blocking`, `wrong`, `visual`, `feel`, `other`.

Statuses: `open`, `in_progress`, `fixed`, `wontfix`, `duplicate`.

Submit is public. Listing and updating need `BUGS_TOKEN` when that
environment variable is set. Locally it is unset, so the tests and a
local agent can read tickets with no header.

```bash
# Open tickets, newest first
curl http://127.0.0.1:3100/api/bugs?status=open

# One ticket, including auto-captured map / GPU / browser
curl http://127.0.0.1:3100/api/bugs/bug-xxxxxxxx

# Claim it, then close it
curl -X POST http://127.0.0.1:3100/api/bugs/bug-xxxxxxxx \
  -H "content-type: application/json" \
  -d "{\"status\":\"in_progress\"}"

curl -X POST http://127.0.0.1:3100/api/bugs/bug-xxxxxxxx \
  -H "content-type: application/json" \
  -d "{\"status\":\"fixed\",\"resolution\":\"What you changed.\"}"
```

On a host with `BUGS_TOKEN` set, add
`-H "Authorization: Bearer $BUGS_TOKEN"` to the GET and update calls.
Testers never need that token, and neither does an admin signed in on the
board: the same tab's session opens this inbox too.

## Licence

GPLv3. See LICENSE.
