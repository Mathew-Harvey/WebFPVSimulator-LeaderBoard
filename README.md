# WebFPV Leaderboard

The public board for [WebFPVSimulator](https://github.com/Mathew-Harvey/WebFPVSimulator).
Every published course lives here, with the times flown on it.

Repository: [Mathew-Harvey/WebFPVSimulator-LeaderBoard](https://github.com/Mathew-Harvey/WebFPVSimulator-LeaderBoard).

The simulator itself keeps nothing. Tracks you build stay in that browser
until you publish them. This page is the copy that other people can fly.

## How the three pages connect

The track document from the builder is the only payload. The logo travels
inside it, so a published course wears its sponsor print on every gate and
every flag.

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

This repo is ready for a Render Web Service plus a Render Postgres
instance. `render.yaml` is the blueprint.

1. Create the service from this repo. Start command is `npm start`.
2. Attach a Postgres database. Render sets `DATABASE_URL`.
3. Set `SIM_ORIGIN` to wherever the simulator is hosted, no trailing slash.
4. Optionally set `BOARD_PUBLIC_ORIGIN` to this service's public URL so
   Fly links can post times back even behind a proxy.

## API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/tracks` | Every published course, with its best time |
| GET | `/api/tracks/:id` | That course and its leaderboard |
| GET | `/api/tracks/:id/document` | The full track document, logo included |
| POST | `/api/tracks` | Publish `{ author, document, editKey? }` |
| POST | `/api/tracks/:id/times` | Post `{ name, lapMs }` |
| GET | `/api/config` | `{ simOrigin, boardOrigin }` |
| POST | `/api/bugs` | Tester submit `{ kind, title, what, expected?, steps?, reporter?, context? }` |
| GET | `/api/bugs` | Ticket summaries, newest first. `?status=open` `?kind=visual` |
| GET | `/api/bugs/:id` | One full ticket, context included |
| POST | `/api/bugs/:id` | Update `{ status, resolution }` |

A first publish returns an `editKey`. Keep it in the browser that sent
the course. Publishing the same id again without that key is refused.
Changing the flying layout clears the old times, because they were flown
on a different course.

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
Testers never need that token.

## Licence

GPLv3. See LICENSE.
