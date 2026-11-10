BuzzMe — Project Status, Restructure Plan and Roadmap
Version 1.1 · November 2026 · Draft for team review
This document replaces the earlier plan notes. It records where the project stands today, how we will restructure the backend into a layered (MVC-style) layout, what we will build next and in what order, and the design decisions we have already agreed on.
1. Product vision
BuzzMe has two faces inside one app:
Buzz: A random stranger communication platform where users can connect through video, voice-only, or text-only chat. Video is the signature feature, while voice and text provide lighter alternatives. Users can join as guests with limited access or create an account to unlock additional features and functionality. Registered users authenticate through a sign-up and login system. After joining, users choose a nickname and communication mode, get matched with strangers, and can press Next, Stop, or Report during a conversation.
Feed: an anonymous posting section with comments and likes, where visibility and interaction can be limited to a specific area.
In both faces, other users only ever see an alias or nickname. Security and protection between strangers are core requirements, not extras.
2. Where we are today
Stack: Node.js, Express 5, Socket.IO, PostgreSQL (via `pg`), dotenv. Code lives in `MegaMinds-Corporation/buzzme`.
Built and tested
Area	What exists
Foundation	Config loading with validation, `.env.example`, server scaffold, graceful shutdown, `/health` endpoint
Database	PostgreSQL schema (`bans`, `reports`), migrate script, connection pool with timeouts
Identity protection	Client IP detection with trusted-proxy hops, HMAC-SHA256 hashing of IPs and device tokens (raw IPs never stored)
Join flow	Nickname and mode validation, 18+ confirmation, ban check on join (fails closed), join timeout for stuck sockets
Matching	In-memory matchmaker with one FIFO queue per mode, Next gives a new person, same-mode matching only
Real-time events	`join`, `next`, `stop`, `message`; server emits `waiting`, `matched`, `message`, `partner_left`, `online`, `error`
Abuse limits	Per-IP connection cap and join rate, per-socket Next and message rate, global event flood cap, origin check, 32 KB message cap
Tests	About ten test scripts (smoke, IP, join, bans, database, DB timeout, matchmaker, realtime, rate limiter, limits), all passing
Not built yet
Report flow (the `reports` table exists but nothing writes to it)
Ban creation (the `bans` table is read-only today; nothing creates bans)
WebRTC `signal` relay and ICE candidate filtering
TURN credentials in the `matched` event (the spec requires them)
Heartbeats and idle timeouts, nickname filtering, data retention cleanup
Accounts, admin tools, blocks, verification
The Feed (posts, comments, likes, areas)
Redis-backed coordination, CI, deployment setup
Differences between the spec and the code
The overview document says MySQL; the code and schema use PostgreSQL. The overview should be updated to say PostgreSQL.
The overview says `matched` carries TURN credentials; the code does not send them yet.
3. Why restructure
The code itself is good: it is testable, uses dependency injection and has a strong test suite. The problem is navigation. Everything sits in one flat `src/` folder, and `app.js` (about 150 lines) mixes server setup, origin checks, per-IP connection caps, rate limiting, the join timer and the whole `join` handler. A new teammate has to read it top to bottom to learn where anything lives.
BuzzMe is a backend with no server-rendered pages, so there is no classic View layer. The client is the view, and the socket event payloads (`matched`, `message`, `partner_left`) play that role. We therefore use a layered layout that follows MVC principles: handlers call controllers, controllers call services, and models talk to the database.
4. Target architecture
Layers and rules
Layer	Responsibility	Must not
`sockets/`, `routes/`	Map incoming events and HTTP requests to controllers	Contain business logic
`middleware/`	Cross-cutting checks (origin, connection caps, rate limits, later authentication)	Talk to the database directly
`validators/`	Check the shape and content of incoming payloads	Have side effects
`controllers/`	Handle one feature flow (join, chat, report, signal) and decide what to emit	Write SQL
`services/`	Reusable logic (matchmaker, rate limiter, TURN credentials, signal filter, moderation)	Know about sockets or HTTP
`models/`	All database access, one file per table or entity	Know about sockets or HTTP
`config/`, `utils/`	Settings, database pool, small helpers (hashing, client IP)	Hold feature logic
Dependencies flow one way: handlers, then controllers, then services and models. We keep the dependency-injection style of `createApp`, so tests can still pass in fake dependencies.
Folder structure
```
src/
  config/        index.js, limits.js, database.js
  models/        Ban.js, Report.js, (later) User.js, RefreshToken.js, Post.js, Comment.js, Like.js
  controllers/   joinController, chatController, reportController, signalController,
                 (later) authController, adminController, postController
  services/      matchmaker, rateLimiter, presence, turnCredentials,
                 signalFilter, moderation, (later) tokenService, feedService
  middleware/    originCheck, connectionCap, eventLimit, joinTimeout,
                 (later) socketAuth, httpAuth
  validators/    join, message, signal, report, (later) post, comment
  routes/        health, (later) auth, admin, posts
  sockets/       index.js
  utils/         hash, clientIp
  app.js         builds Express + Socket.IO, nothing else
  server.js      starts the server and handles shutdown
tests/           all test scripts
db/              schema.sql, migrations/
docs/            events.md, architecture.md
scripts/         migrate.js
```
Where today's files go
Today	After the restructure
`src/config.js`, `src/limits.js`	`src/config/index.js`, `src/config/limits.js`
`src/hash.js`, `src/clientIp.js`	`src/utils/hash.js`, `src/utils/clientIp.js`
`src/matchmaker.js`, `src/rateLimiter.js`	`src/services/`
`src/validate.js`	split into `src/validators/join.js` and `src/validators/message.js`
`src/db.js`	pool in `src/config/database.js`, ban query in `src/models/Ban.js`
Origin check, connection cap, event limiter, join timer inside `app.js`	`src/middleware/`
`join` handler inside `app.js`	`src/controllers/joinController.js`
`src/realtime.js`	`chatController.js` plus a small `presence` service for the online count
`scripts/test-*.js`	`tests/`
5. Part A: restructure steps
Each step is one small commit on the branch `refactor/layered-structure`, and `npm test` must pass before the next step starts. We work one step at a time and discuss each before moving on.
Prep. Teammates merge or pause their work, create the branch and confirm the baseline is green (`npm run test:all`).
Folders and pure moves. Move config and limits into `config/`, hash and client IP into `utils/`, test scripts into `tests/`, and fix imports.
Services. Move the matchmaker and rate limiter into `services/`.
Validators. Split `validate.js` into join and message validators.
Models. Split `db.js` into the pool and a `Ban` model.
Middleware. Extract the origin check, per-IP connection cap, event limiter and join timer from `app.js`.
Controllers. Move the join handler into `joinController`; split `realtime.js` into `chatController` and `presence`.
Wiring. Add `sockets/index.js`; shrink `app.js` to building Express and Socket.IO.
Docs and merge. Add a folder map to the README, update the overview (PostgreSQL), merge the branch.
6. Part B: roadmap after the restructure
Milestone 1: Text MVP complete
Report flow. Add the `report` event, a `Report` model and `reportController`. Keep the last ~20 messages of each session in an in-memory buffer and save them as the snapshot only when a report is filed. This is more trustworthy than a client-supplied snapshot and still stores no chat otherwise. A report ends the session and is rate limited.
Ban creation. Create, lift and expire bans in the `Ban` model, including temporary bans and an automatic rule such as N reports within a time window.
Heartbeats and idle timeouts. Socket.IO ping settings plus an idle-session timeout.
Nickname filtering. A blocklist and reserved names (admin, support, BuzzMe team) in the join validator.
HTTP hardening and retention. `helmet` (HSTS, CSP) and a scheduled purge of old reports and expired bans using retention periods the team chooses.
Milestone 2: Voice and video
`signal` relay. Validate type (offer, answer, ice) and size, allow it only in video and voice modes, deliver only to the current partner, and drop `host` and `srflx` ICE candidates, including candidate lines inside the SDP.
TURN credentials. Generate coturn time-limited HMAC credentials and add them to `matched`. Write the coturn config: block private ranges, set quotas, serve TLS on port 443.
Media-state events. Relay mute and camera state so the partner's UI can show it.
Reconnect handling. A short grace period so a flaky mobile connection does not end the chat. This is the hardest item, so it comes last in the milestone.
Milestone 3: Accounts and safety
Authentication. A `users` table, argon2 password hashing (or social login), access and refresh tokens, register, login and logout, email verification and password reset, and an `io.use()` socket middleware. Guests keep working. Bans and reports gain `user_id`.
Admin API. Admin roles, report review, ban and unban.
Blocks and verification. Blocked accounts are never matched again. Phone or age verification is an open decision.
Milestone 4: The Feed
Posts, comments and likes (details in section 8).
Areas and visibility rules.
Feed moderation tools in the admin API.
Milestone 5: Scale and release
CI and deployment. GitHub Actions running `npm test`, plus PM2 or Docker and Nginx with TLS. CI can be set up any time after the restructure.
Redis-backed queues and rate limits for more than one instance; structured logs without chat text; metrics.
Load testing and tuning.
Extras worth doing early
`docs/events.md`, a list of every socket event, so whoever builds the frontend has a contract.
A throwaway HTML test client so we can try matching and video end to end before the real frontend exists.
7. Identity and privacy design
These decisions apply to both faces of the product.
Two separate public identities. The chat nickname is picked per session. The Feed alias is a separate identity. Nothing visible to other users links the two. If they were linked, anyone could meet someone in a video chat and then read everything that person posted. No "chat with this poster" or "see this person's posts" features in version 1; they may return later as an opt-in.
One private account on the server. Bans and reports need to know it is the same person, so the server keeps that link. Clients never see it.
Private `users` table. It holds only private data (email, password hash). Chat and Feed aliases are kept separate from it.
No internal IDs exposed. Posts and comments use random public IDs so two posts cannot be connected to one account by their IDs.
Reserved and filtered names apply to nicknames and aliases alike.
Honest anonymity. BuzzMe is anonymous to other users, not to the platform. Administrators and legal requests can reach the account behind a post. The privacy policy must say so, and the product must never promise absolute anonymity.
Personal data. Accounts mean storing real personal data, so data-protection rules apply (for example Ghana's Data Protection Act, and GDPR if Europeans use the app). We should get qualified advice before launch.
8. The Feed: design brief
Why it is worth building
It gives people a reason to open the app when the chat queue is empty, it gives them a reason to return after a chat ends, and a local feed fits the meet-strangers brand.
Risks the team accepts
Posts are public, persistent and searchable, so moderation load is much higher than for ephemeral chat.
Our current rule that chat messages are never stored does not apply to posts. The privacy and moderation story needs its own rules.
Anonymous posting depends on accounts, so the Feed cannot ship before Milestone 3.
App stores require apps with user-generated content to have reporting, blocking, filtering and active moderation.
Scope for the first version
Text only. No images or video in posts at the start.
Accounts required to post, comment or like. Reading can be open.
Per-thread aliases such as "Anon 3", so comment threads make sense without revealing identity. Optional persistent handles can come later if the team wants a community feel.
Plain REST over PostgreSQL, kept as its own module so it does not touch the real-time matching code.
Areas and visibility
Each post has a `visibility` of `global` or `area`, and the server checks it on every read, like and comment.
Areas are predefined zones (for example a city or a campus), not radius searches. We store only an `area_id`, never coordinates.
Location is a soft restriction. IP geolocation and phone GPS can both be faked, so the area check reduces casual access but is not a guarantee.
The team still needs to decide how local an area should be: a whole city, a neighborhood or a campus.
Data model sketch
Table	Key fields
`posts`	id, public_id, author_id, area_id, visibility, body, created_at, deleted_at
`comments`	id, post_id, author_id, thread_alias, body, created_at, deleted_at
`likes`	post_id, user_id (unique together: one like per user per post)
`areas`	id, name
`reports`	extended with target type and target id so posts and comments can be reported
The feed uses cursor-based pagination.
Moderation from day one
Report button, automatic hiding after N reports, keyword filters, rate limits on posting and commenting, an admin review queue, fast takedown, a retention policy and clear terms of use.
9. Open decisions
Decision	Notes
Frontend technology	Web, Flutter, React Native or other. The backend contract stays client-agnostic; tokens will use the Socket.IO `auth` option so every client type works.
Which user details accounts collect	Email only, or social login so passwords are never stored. Fewer details means less risk.
Age and phone verification	Approach not yet chosen.
Hosting provider and region	Latency for West African users, and forced-relay TURN bandwidth is the main running cost.
Retention periods	For reports and for hashed IP data.
Feed area size	City, neighborhood or campus.
Persistent Feed handles	Per-thread aliases only, or optional reputation handles later.
10. Working agreement
Work on branches; merge only when `npm test` passes.
Deliver one step or file at a time and discuss it before moving on.
Prefer terminal commands (`mkdir`, `git mv`, `nano`) over pasting whole files where practical.
Keep chat text out of logs, analytics and backups.
Update this document at the end of each milestone.
