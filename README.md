<p align="center"><img src="buzzme_logo.png" alt="BuzzMe" width="160"></p>

# BuzzMe

BuzzMe is a mobile-friendly platform for meeting random strangers. Its signature feature is **random video chat**; voice-only and text-only chat are lighter modes of the same product. Guests pick a nickname and a mode, get matched with a stranger, and can press **Next**, **Stop** or **Report** at any time.

Design and decisions: [Technical Overview](BuzzMe%20%E2%80%94%20Technical%20Overview.md).

## Status

| Area | State |
| --- | --- |
| Server foundation: config, database, IP hashing, ban check, 18+ confirmation | Working |
| Matching: one queue per mode, Next and Stop, never re-pairs the last partner | Working |
| Text chat relay and the online count | Working |
| Rate limits and abuse protection | Working |
| Report flow | Next |
| Browser client | Not started (a plain test client comes first) |
| Voice and video: WebRTC signaling, TURN relay | Not started |
| Admin tools, accounts, Redis for several servers | Later |

## Quick start

You need Node.js 20 or newer and a PostgreSQL database.

`````bash
git clone https://github.com/MegaMinds-Corporation/buzzme.git
cd buzzme
npm install
cp .env.example .env        # then fill in the values (see Configuration)
npm run db:migrate          # creates the bans and reports tables (safe to repeat)
npm start
`````

Check that it is up:

`````bash
curl http://localhost:3000/health
# {"status":"ok","uptime":3}
`````

Generate a value for `IP_HASH_SECRET`:

`````bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
`````

In GitHub Codespaces, add the forwarded URL of your browser client to `ALLOWED_ORIGINS` once you have one.

## Configuration

Set these in `.env` (see `.env.example`). The server refuses to start if a required value is missing or invalid.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | none | PostgreSQL connection string. Keep `sslmode=verify-full` for hosted databases. |
| `IP_HASH_SECRET` | yes | none | At least 32 characters. Used to hash IPs and device tokens. **Changing it later makes every stored hash unmatchable, which lifts all bans.** |
| `PORT` | no | `3000` | Port to listen on. |
| `NODE_ENV` | no | `development` | `development`, `production` or `test`. |
| `ALLOWED_ORIGINS` | in production | empty | Comma-separated browser origins allowed to open a WebSocket. Connections without an `Origin` header (native apps, scripts) are always accepted. |
| `TRUSTED_PROXY_HOPS` | no | `0` | How many of your own proxies (Nginx, a platform load balancer) sit in front of the server. A wrong value lets clients fake their IP. |
| `MAX_CONNECTIONS_PER_IP` | no | `100` | Simultaneous connections allowed per address. |
| `JOIN_RATE_PER_MINUTE` | no | `120` | Join attempts allowed per address per minute, valid or not. |
| `JOIN_TIMEOUT_MS` | no | `60000` | A connection that has not finished joining by then is dropped. |

Other limits live in `src/limits.js`:

| Limit | Default |
| --- | --- |
| Largest single socket message | 32 KB |
| Next presses | burst of 5, then 20 per minute, per visitor |
| Chat messages | burst of 10, then 120 per minute, per visitor |
| Any events from one connection | burst of 100, then 50 per second (going over disconnects it) |

Next and message limits are per visitor, and connection and join limits are per address. Many people share one public address on mobile networks, offices and campuses, so the per-address defaults are generous and nobody is throttled by their neighbours' chatting.

## The live protocol

The client talks to the server over Socket.IO. Events implemented today:

| Client to server | Payload |
| --- | --- |
| `join` | `{ ageConfirmed: true, nickname, mode?, deviceToken? }`. `ageConfirmed` must be the boolean `true`. `nickname` is 2 to 20 letters, numbers, spaces, `_` or `-`. `mode` is `video` (default), `voice` or `text`. `deviceToken` is an optional string of up to 128 characters. |
| `next` | none. Leave the current partner, if any, and search for someone new. |
| `stop` | none. End the session or leave the queue. The connection stays open. |
| `message` | `{ text }`. Plain text, at most 500 characters. |

| Server to client | Payload |
| --- | --- |
| `waiting` | none. In the queue. |
| `matched` | `{ partnerNickname, initiator }`. `initiator: true` means this side sends the WebRTC offer. |
| `message` | `{ text }`. From the partner. |
| `partner_left` | none. The partner pressed Next or Stop, or disconnected. |
| `online` | `{ count }`. People currently on the service. |
| `error` | `{ code }`, one of the codes below. |

| Error code | Meaning |
| --- | --- |
| `invalid` | Malformed input, or an event sent at the wrong time (for example `message` before joining, or joining twice). |
| `banned` | The address or device is banned. The connection is closed. |
| `rate_limited` | Too many connections, joins, Next presses or messages. |
| `server_error` | Something failed on the server. Safe to retry. |

Behaviour to build the client around:

- A connection joins once. To change mode, reconnect.
- After `partner_left` the visitor is idle until the client sends `next`, so the UI should offer "Find someone new" or send it automatically.
- Next never gives the person you just left. With only two people online, both keep waiting until a third arrives.
- A message sent when there is no partner is dropped without an error.
- Nicknames and messages come from strangers: render them as plain text, never as HTML.

Planned: `signal` and `report` events, and temporary TURN credentials inside `matched`.

## Privacy rules kept by the code

- Chat messages are relayed from memory and never stored or logged.
- Raw IP addresses are never stored or logged, only an HMAC hash.
- A partner only ever receives a nickname and message text: no socket id, session id, address or device token.
- The ban check runs on every join and fails closed: if the database cannot answer, the visitor is not admitted.

## Project layout

`````
src/
  server.js        starts the server, handles shutdown
  app.js           HTTP and Socket.IO setup, origin check, join flow, connection limits
  realtime.js      connects sockets to the matchmaker: matched, message, next, stop, online
  matchmaker.js    queues, pairing and sessions, no sockets inside
  validate.js      join and message validation
  clientIp.js      real client address behind proxies
  hash.js          HMAC hashing of IPs and device tokens
  rateLimiter.js   token-bucket limiter
  limits.js        default limits
  config.js        environment variables, validated at startup
  db.js            PostgreSQL pool and the ban check
db/schema.sql      bans and reports tables
scripts/           migrate.js and all tests
`````

## Tests

| Command | What it runs | Needs the database |
| --- | --- | --- |
| `npm test` | IP handling, join validation, matchmaker, realtime, limiter, limits | no |
| `npm run test:db` | database queries, ban lookups, database timeout | yes |
| `npm run test:smoke` | starts a real server and checks the join flow end to end | yes |
| `npm run test:all` | everything above | yes |

## License

MIT. See [LICENSE](LICENSE).
