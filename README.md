# WebFPV Leaderboard

The public board for [WebFPVSimulator](https://github.com/Mathew-Harvey/WebFPVSimulator).
Every published course lives here, with the times flown on it.

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
SIM_ORIGIN = https://<the simulator's static site>
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
Leave `BOARD_PUBLIC_ORIGIN` unset unless a custom domain confuses that.

The full walkthrough, including the simulator's static site and the order
to create things in, is in
[DEPLOY.md in the simulator repo](https://github.com/Mathew-Harvey/WebFPVSimulator/blob/main/DEPLOY.md).

## API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/tracks` | Every published course, with its best time |
| GET | `/api/tracks/:id` | That course and its leaderboard |
| GET | `/api/tracks/:id/document` | The full track document, marks included |
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
