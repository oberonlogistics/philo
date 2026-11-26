# How Philo's events reach the shared feed

Status: **proposed, 2026-11-26.** This is a design. Nothing in it is built yet. It answers how a new lead, and the few
other Philo events worth a person's attention, reach the OL Notify feed, so that the bell in every Oberon Logistics app
shows them.

Sources this is written against: Philo at `origin/main` 9e111df; `oberonlogistics-notify` `docs/SPEC.md` (the feed
§2–§5, bridges §6, configuration §7) at 7e106a0; `oberonlogistics-common` `DESIGN.md` §7 and §9; Handbook's
`docs/deployment.md` ("Notify service account").

## 1. Decision

**Option B: Philo posts to Notify itself, as a first-party client.** A small Oberon module inside the Philo process
listens to Philo's in-process change feed, maps a short table of events to feed items, and posts them with a Notify
service account, `as` Philo's tile. It reaches the feed the same way Handbook does. Two small, generic upstream
changes support it (§11). No bridge adapter is written in `oberonlogistics-notify`.

**DESIGN §7.5 option 3 (both).** Philo shows the shared bell and sends selected items to the shared feed. It keeps its
own channels: email stays the guaranteed channel (ADR-0004), and Web Push and the in-app live stream stay the fast path
(§4).

Option A, a bridge adapter in `oberonlogistics-notify`, is not rejected out of principle. It is rejected because Philo
cannot meet the bridge contract without larger upstream changes than B needs, and because it moves more lead data and a
stronger credential out of Philo. The appendix records what A would take.

## 2. What Philo has today

| Fact | Where |
|---|---|
| The change feed is an **in-process, in-memory** publisher. Each event has a random UUID id, a type, a time, the funnel, and (except `lead.deleted`) the whole lead record. | `packages/server/src/events/feed.ts:27`, `:61` |
| Types: `lead.created`, `lead.updated`, `lead.stage_changed` (with `from`, the stage it left), `lead.deleted` (the id only), `funnel.changed`. Quarantined (spam) leads publish nothing. | `events/feed.ts:12`, `:76`; ADR-0010 |
| An event has **no actor**. The timeline records one (`user:<id>`, `api_key:<id>`, `oauth:<client>`, `form:<key>`), but the change event does not carry it. | `auth/middleware.ts:32`; `leads/routes.ts:220` |
| `lead.created` fires for an intake submission, for a lead promoted out of spam (both with `formId` set and `source` = the form's name), and for a lead filed through REST or MCP (`formId` null). | `intake/routes.ts:230`, `:336`; `leads/routes.ts:182`, `:255` |
| A stage move that changes nothing publishes nothing. Deleting a spam lead publishes nothing. | `leads/routes.ts:222`, `:210` |
| `GET /api/v1/events` streams the feed as SSE. There is **no event cursor, no `id:` line and no replay**: a client that is disconnected misses what happened meanwhile. The stream ends every 15 minutes. | `events/routes.ts:19`; `sse.ts:19` |
| Webhooks post each event to a registered URL, with **two retries** (10 s, 60 s), in memory: a restart loses retries in flight. | `webhooks/deliver.ts:21`, `:167`; ADR-0010 |
| The feed is built in `bootServer`, which does not return it, so an entrypoint cannot listen to it. | `boot.ts:53`, `:78`; `apps/standalone/src/index.ts:7` |
| **API keys have no scopes.** Every key acts with its user's full authority, including minting more keys and deleting leads. | `auth/api-keys.ts:143`; ADR-0007 |
| One account. With an external IdP, the account is bound to `"<iss> <sub>"`, and a second person is refused. The API never returns the bound subject. | `auth/external-idp.ts:102`, `:130`; `auth/routes.ts:29` |
| Push titles carry the lead's name and the body its email and phone. | `push/service.ts:86` |
| A lead's page in the PWA is `/leads/<id>`, under `PHILO_APP_URL`. Lead ids are `AUTOINCREMENT` and never reused. | `apps/web/src/AppShell.tsx:24`; `push/service.ts:96`; `db/schema.ts:10` |

## 3. Why B and not A

| | A: bridge in notify | B: Philo posts |
|---|---|---|
| A durable source with a cursor (SPEC §6.1, §6.2 item 1) | **None exists.** The SSE stream and webhooks are in memory, with no cursor or replay. Meeting the contract needs a durable change log upstream, which ADR-0010 chose not to build ("revisit with a durable outbox"). | Not needed. The module listens in process and sees every event as it is published. |
| The credential | **A Philo API key with full authority**, stored on Notify's host: it can read every lead, delete leads and mint keys that outlive it. DESIGN §7.7 requires a read-only credential, so production needs scoped keys upstream, which contests ADR-0007. | **A `notify:post` service account** in Philo's environment. Notify's post-as list limits it to Philo's tile, and Notify reaches only people who can open that tile. |
| Lead data leaving Philo | Every lead event carries the whole record, contact details, intake fields and operator `details` (ADR-0008) included, to the bridge, including every `lead.updated`. | Only the item's title, body and link, chosen by the mapping (§6). |
| Who did it | Not in the event, for either option. Both need the actor upstream (§11, U1). | Same. |
| Recipients | The bridge cannot read the bound subject, so it needs a role or a subject configured by hand. | The same role (§8). |
| Upstream work | A durable change log with a cursor, scoped API keys (an ADR against ADR-0007), the actor on events. | The actor on events, and `bootServer` returning its change feed (§11). Both are small and additive. |
| Fork footprint | None in Philo. The adapter lives in the notify repo. | One new module, its tests, and about three lines in `apps/standalone/src/index.ts`. The fork must run its own image, which the chrome integration needs anyway. |
| Delivery | At most what the source gives. Over SSE, everything published while the bridge or Philo restarts is lost. | Best effort, in memory, with bounded retries, like webhooks. A Philo restart loses retries in flight. |

Both options are best effort in practice, because Philo has no durable change log. A feed item is the cross-app
notice, not the record. A new lead is never lost, because its email is the guaranteed channel (ADR-0004) and the lead
itself is in Philo. B gets the same delivery with a weaker credential, less data in flight, and less upstream work.
The fork guide (`oberon/AGENTS.md`, "Where a change goes") names this split: a generic seam upstream, and the Notify
adapter as a small `ol/` change.

## 4. DESIGN §7.5: option 3, and Philo's own channels

| Channel | Keep? | Why |
|---|---|---|
| Email on a new submission | **Yes, unchanged** | ADR-0004: the guaranteed channel. Notify is optional (SPEC §1) and best effort here, so it never replaces email. |
| Web Push | **Yes, unchanged** | It reaches the operator's phone when no Oberon app is open. The bell only shows when an app is open. |
| In-app live stream (`/push/live`) | **Yes** | It is the fallback for browsers with no push service, and it shows a notification while Philo is open. |
| Change stream (`/api/v1/events`) | **Yes** | It keeps the board live. It is not a notification channel. |
| Shared bell | **Added** (`ol/spec-chrome`) | Philo has no bell of its own, so the one-bell rule of DESIGN §7.4 holds. |

So a new lead reaches the operator by email, by push, and as an item in the bell of every Oberon app. That is the point:
someone working in another app sees the lead without Philo open. The bell item says less than the push does (§6).

Philo records this choice in its fork docs, not in upstream's `docs/DESIGN.md`.

## 5. The mapping table

The module reads the change event and posts nothing for anything not in this table. `⟨form⟩` is the lead's `source`
when it was created through a form (the form's name, set at intake). `⟨stage⟩` and `⟨from⟩` are stage names. All three are
chosen by the operator, never by the person who filled in the form.

| Philo event, when | Operations | Kind, severity | Title | Body |
|---|---|---|---|---|
| `lead.created`, `formId` set (a form submission, or promoted out of spam) | post `new` | `action`, `info` | *New lead from ⟨form⟩* (no source: *New lead from a form*) | *Waiting in ⟨stage⟩. Open it to see who it is.* |
| `lead.created`, `formId` null, actor `api_key:` or `oauth:` (needs U1) | post `added` | `info`, `info` | *An agent added a lead* | *It's in ⟨stage⟩. Open it to see who it is.* |
| `lead.stage_changed`, any actor | resolve `new` | | | |
| `lead.stage_changed`, actor `api_key:` or `oauth:` (needs U1) | resolve `new`, then post `moved` | `info`, `info` | *An agent moved a lead to ⟨stage⟩* | *It was in ⟨from⟩. Open it to see what changed.* |
| `lead.deleted` | withdraw `new`, `added`, `moved` | | | |
| `lead.created` by `user:` (the operator in the PWA), `lead.updated`, `funnel.changed`, anything else | nothing | | | |

Every post has `to: {roles: [OL_NOTIFY_ROLE]}` (§8) and `href` = the lead's page (§9). Resolve and withdraw send no
`recipients`, which means everyone who has the item, so they need nothing from OL Auth.

Reasons for the choices:

- **A new lead is `action` (*Needs you*).** It waits on the person to get back to whoever filled in the form. It is
  settled when the lead leaves the stage it arrived in, whoever moved it. That is the closest signal Philo has to "has
  been dealt with". The cost is an operator who never moves leads: their items stay *Needs you* until the lead is moved
  or deleted. Notify keeps unresolved `action` items until they are settled. If that proves noisy, make the row `info`.
  Nothing else changes.
- **The operator's own changes post nothing.** ADR-0004: stage moves are made by the person who would be notified. An
  agent's moves and filings are made for them, without them (ADR-0007), so they belong in the bell (DESIGN §7.4, "things
  that happen without the person"). Until U1 lands, the module cannot tell the two apart, so it ships with only rows 1, 3
  and 5. The agent rows switch on when the event carries the actor.
- **A lead filed by the operator in the PWA posts nothing.** It is not news to them, and email ignores it too.
- **`lead.updated` posts nothing.** It fires on every edit, note and attachment, and nearly all of them come from the
  person reading the bell.
- **No `danger` item.** Nothing in Philo's feed is that urgent. A future candidate is "couldn't send the new-lead email"
  (the guaranteed channel failing). Email failures are not on the change feed, so that needs its own seam. It is out of
  scope here (§13).

Text rules applied by the module before posting: titles at most 120 code points and bodies at most 280 (SPEC §4.1). A
title that would run over is cut at the last whole word that fits and ends in `…`. White space in a name, including
line breaks, is collapsed to single spaces, and control and bidi characters are removed, so Notify's text rules
(§4.1 rule 2) never refuse an item because of how a stage was named.

## 6. No lead data in the feed

**Decision: no item carries a lead's name, email, phone, intake fields, `details`, notes or attachment names.** Not in
`title`, `body`, `href` or `dedupe_key`. An item names the form, the stage and the lead's number (in the link only).

- **The feed is shared.** The bell is on the screen in every Oberon app, often in front of other people. The item says
  that something arrived and where it is. Philo, behind its own sign-in, says who.
- **Erasure.** Deleting a lead in Philo erases it, with no tombstone (`leads/routes.ts:202`; ADR-0010 keeps even the
  event down to the id). Notify stores titles and bodies for 30 days, or until an `action` item is settled. A name
  copied there would outlive the erasure whenever the withdraw is lost (a restart, Notify down). With no lead data in the
  item, a lost withdraw leaves a link to a missing lead, nothing more.
- **Outsider text (DESIGN §4, §9).** A lead's name is text a stranger typed into a form. The bell renders a title as plain
  bold text, with no outsider fill, so a name like *Payment failed: update your card* would read as our words. DESIGN
  §9 forbids writing around a stranger's text as if it were ours, and §4 keeps outsider text out of headings.
- **Notify's cheap secret check (SPEC §4.1 rule 3)** would refuse some intake values (a long reference number in a
  name), and the post would be lost.

The push notification keeps the name, as it does today. It goes only to the operator's own devices.

## 7. Dedupe keys and settling

Keys are `philo:lead:<id>:<what>`, with `<what>` one of `new`, `added`, `moved`. Notify keys items per (`as`, key,
person). The longest is under 40 characters.

- **`new` and `added` name one occurrence.** A lead is created once, and ids are never reused, so neither key is ever
  posted twice for different matters. Promoting a lead out of spam is its first post, because quarantined leads publish
  nothing.
- **`moved` is one item per lead, replaced.** A second agent move posts different text under the same key, so Notify
  replaces the item and makes it unread again. A burst of agent moves across many leads gives one item per lead, not one
  per move. A move back to a stage already reported is identical content, which Notify treats as a no-op. That is
  acceptable for an `info` item.
- **Settling.** A stage change resolves `new` (its *Needs you* drops). A deletion withdraws all three keys: the lead is
  gone, so its items go too. Resolve and withdraw are idempotent and never 404 (SPEC §4), so a key that was never posted
  costs nothing.
- **Order.** For one lead, operations are sent in the order the events happened, each accepted before the next (§10).
  For a lead with a stage change, the resolve is sent before the `moved` post.

## 8. Recipients

**Decision: an OL Auth role, `OL_NOTIFY_ROLE`, whose only member is the person bound to Philo's account.**

- Philo has one account, and with OL Auth exactly one OL Auth person can sign in to it (`external-idp.ts:130`). The
  people who should get its items are "whoever uses Philo". OL Auth already answers that question, and Notify reaches
  a role's members only if they can open Philo's tile (SPEC §4.1 rule 6).
- **The alternative, the bound subject,** would have the module read `users.external_subject`, split it into issuer and
  subject, and check the issuer. That reaches into Philo's schema from fork code, and it breaks when the operator signs
  in through a different issuer. A subject configured by hand goes stale when the binding changes.
- **The risk of a role** is an OL Auth person who holds it but cannot sign in to Philo. They would see *New lead from
  ⟨form⟩* and a link they cannot open. Because no lead data is in the item (§6), that leaks only that leads arrive.
  The operator steps (§12) say to keep the role to the bound person.
- This is the pattern Handbook uses (`HANDBOOK_APPROVER_ROLE`).

## 9. `href`

`<PHILO_APP_URL>/leads/<id>`, for example `https://philo.oberonlogistics.com/leads/123`. The route is
`/^\/leads\/(\d+)$/` (`apps/web/src/AppShell.tsx:24`), the same link push and email use (`push/service.ts:96`,
`email/render.ts:42`). Notify accepts it only on the launch origin of Philo's tile (SPEC §4.1 rule 5), so the tile's
launch URL must be on the same origin as `PHILO_APP_URL`. The module refuses to start when the two origins differ (§12.3).

## 10. The Oberon module

`apps/standalone/src/oberon/notify.ts`: a new file, so it never conflicts with an upstream sync. It is compiled into
`apps/standalone/dist` with the rest, so the Dockerfile does not change. The entrypoint
`apps/standalone/src/index.ts` gains an import and one call:

```ts
const server = bootServer(config)
startOberonNotify(server.changes, loadOberonNotifyConfig(process.env, config))   // off when unconfigured
```

That edit goes into the table of upstream files the Oberon layer edits, in `oberon/AGENTS.md`.

Behaviour:

- **Off unless configured.** With none of the `OL_NOTIFY_*` variables set, it does nothing and Philo runs as upstream.
  If some are set but not all, or a value is invalid, boot fails with one message that names each variable and never
  shows a value. A configuration error is the operator's to fix. Notify being down at run time is not (next item).
- **Notify is never required.** The listener only enqueues, and never throws into the feed or the request
  (`ChangeFeed.publish` already isolates listeners, `events/feed.ts:61`). Intake, email, push and webhooks are
  unaffected by anything Notify or OL Auth does.
- **Token.** Client credentials at the issuer's `token_endpoint` (from its discovery document): `scope=notify:post`,
  `audience=OL_NOTIFY_RESOURCE`. The token is kept until 60 s before `expires_in`, and never longer than 15 minutes. A 401
  from Notify drops it and retries once with a new one. Every call to OL Auth has a deadline (10 s) and reads at most 64 KiB.
- **Posting.** `POST /v1/notifications`, `/resolve`, `/withdraw` (SPEC §4), each with `as = OL_NOTIFY_AS` and the key from
  §7. Deadline 30 s per call, longer than Notify's own 20 s budget for a post, so a slow post that succeeds is not sent
  twice.
- **Order and queue.** One queue in memory, sent one operation at a time, oldest first, so every lead's operations stay
  in order. At most 1,000 waiting operations. When the queue is full, the oldest are dropped and counted.
- **Retries.** Network errors, timeouts, 408, 429 and 5xx are retried after 10 s, 60 s and 5 min, honouring a longer
  `Retry-After` up to 5 min. After that the operation is dropped and counted. Retries are bounded because nothing can
  fix a missed notice after the fact. Philo's webhooks make the same trade. 401 and 403 are retried on the same
  schedule, because they mean setup the operator has yet to finish (post-as list, scope). Any other 4xx (for example 422
  `validation_failed`, `href_not_allowed`, `unknown_role`) is dropped at once, logged with Notify's problem `code`.
- **Logging.** Event type, lead id, key, status and problem code only. **Never a title, a body, a token or the client
  secret.** The client secret is never put in an error message.
- **On shutdown,** what is still queued is dropped. The lead's email has already been sent or is in Philo's own retry
  sweep.

## 11. Upstream changes (vendor-neutral)

Each is an `up/` branch from `upstream/main`, a PR against the upstream repository, and is described there without
naming Oberon or any of its services.

**U1. `up/change-event-actor`: say who made each change.** Add `actor` to every change event, using the timeline's
vocabulary (`user:<id>`, `api_key:<id>`, `oauth:<client>`, `form:<key>` for intake). It is passed through `publish` and
`publishLead` from `actorOf(c)` in the routes, and from the form for intake. It shows up in the SSE stream, in webhook
bodies and in the SDK's `ChangeEvent` type (`packages/sdk/src/types.ts:250`), all in the same PR, as upstream's rule on
API shape requires. The generic case for it: a webhook receiver that writes back to Philo (an automation that moves a lead
when it qualifies) has to recognise its own changes to avoid a loop. And "a person did this" vs "an agent did this" is
what an integration most often branches on. The timeline already records it. It is additive, contests no ADR, and
needs only a line in ADR-0010's event description or DESIGN.md. **It is not a blocker:** without it, rows 2 and 4 of §5
stay off.

**U2. `up/boot-change-feed`: let an entrypoint listen to the change feed.** `bootServer` returns `changes` (the
`ChangeFeed`, or a narrow `{listen}` view of it) in `BootedServer`, and `ChangeEvent` is exported from `@philo/server`.
The generic case for it: a custom build or an embedding host can attach an in-process consumer (a chat notifier, a
metrics counter) to the events webhooks already get, without a webhook round trip to itself and without a second
`ChangeFeed`. It is a few lines plus a test that a listener attached to the returned feed receives an event a route
publishes. **It is not a blocker either:** if upstream declines, the fork edits `boot.ts` to return it (one line,
recorded in `oberon/AGENTS.md`).

**Not needed for B:** scoped or read-only API keys, and a durable change log with a cursor. Both are good upstream ideas
(ADR-0007 and ADR-0010 each name them as the upgrade path), and both are prerequisites for option A (appendix). Neither
is proposed now.

## 12. Configuration, as exact steps

Placeholders: `<philo-client>` is the client id of Philo's tile in OL Auth (the public client `ol/spec-auth`
registers). `<philo-notify>` is the new service account's client id. `<philo-role>` is the role slug. `<notify>` is
Notify's resource identifier (`https://notify.oberonlogistics.com` in Notify's SPEC §2, still marked TODO there; use
the value Notify's `NOTIFY_RESOURCE` actually holds).

### 12.1 OL Auth (an administrator, once)

1. Check that Philo's tile exists for `<philo-client>` and that its launch URL is on Philo's origin
   (`https://philo.oberonlogistics.com/`). This is part of `ol/spec-auth`. Without a tile, Notify answers 422
   `unknown_app`, and the module retries for ever.
2. Create the role `<philo-role>` (for example `philo-operator`) and add exactly one member: the person bound to Philo's
   account. That person must also be able to open Philo's tile, or Notify leaves them out.
3. Register a service account: confidential, client-credentials grant, scope `notify:post`, audience `<notify>`. Its
   client id `<philo-notify>` must not be `<philo-client>`. OL Auth shows the secret once. Store it with Philo's other
   production secrets, never in this repository.

### 12.2 Notify (its operator, once)

1. Add the post-as line to `NOTIFY_POST_AS` (SPEC §7), keeping the lines already there:
   `{"<philo-notify>": ["<philo-client>"], ...}`.
2. Restart `notify serve`. The list is read at start. Until this line is in place, every post answers 403
   `post_as_forbidden`, and the module keeps retrying it.
3. No `BRIDGE_ADAPTERS` or `BRIDGE_PHILO_*` variables: there is no Philo bridge.

### 12.3 Philo (the fork's deployment)

| Variable | Value |
|---|---|
| `OL_NOTIFY_URL` | Notify's origin, https. |
| `OL_NOTIFY_RESOURCE` | `<notify>`, exactly as registered, with no trailing slash. Default: `OL_NOTIFY_URL`. |
| `OL_NOTIFY_ISSUER` | The OL Auth issuer, https. Default: Philo's external IdP issuer, when one is configured. |
| `OL_NOTIFY_CLIENT_ID`, `OL_NOTIFY_CLIENT_SECRET` | The service account from 12.1 step 3. |
| `OL_NOTIFY_AS` | `<philo-client>`. |
| `OL_NOTIFY_ROLE` | `<philo-role>`. |

Checked at boot: all set or none; https everywhere when `NODE_ENV=production`; `PHILO_APP_URL`'s origin is the origin
the links will use (the module cannot read the tile itself, so the operator checks 12.1 step 1).

To check it end to end: submit a test lead through a form. The bell in any Oberon app should show *New lead from
⟨form⟩*, and Philo's log should show the post accepted. Then move the lead: the item's *Needs you* drops.

## 13. Test plan (in this fork, Vitest, `apps/standalone/test/oberon/`)

No real OL Auth or Notify. A fake issuer (discovery and a token endpoint) and a fake Notify (the three POST routes,
recording requests and answering what a test scripts) run in process, in the style of `testkit/fake-notify.ts` in the
notify repository, which is not imported here.

**Mapping (pure, unit).**
- Each row of §5 gives exactly its operations, keys, kind, severity, title, body and href. Every event not in the table
  gives nothing.
- No lead data: a lead whose name, email, phone, fields and `details` are marker strings produces items in which no
  marker appears in any field.
- Without `actor` (before U1): rows 2 and 4 produce nothing, and a stage change still resolves `new`. With `actor: user:1`,
  likewise. With `api_key:3` or `oauth:x`, they post.
- Text: a title over 120 code points is cut at a word and ends in `…`. Control and bidi characters and line breaks in a
  stage name never reach the item. No source gives *New lead from a form*.

**Client (fake issuer and fake Notify).**
- The token is fetched once and reused, refreshed before expiry, and dropped and refetched once on 401.
- Order: create, then move, then delete of one lead arrive as post `new`, resolve `new`, (post `moved`), withdraw ×3, in
  that order, each after the previous one was answered.
- Retries: 503 with `Retry-After` is retried after the right wait (fake timers), and dropped and counted after the third
  retry. 422 is dropped at once, and the log line carries the problem code. 403 is retried.
- Bounded queue: past 1,000 waiting operations the oldest are dropped and counted.
- A slow Notify answer within 30 s is not sent twice.
- Logs: over every test's captured output, no title, body, token or client secret appears (marker values).

**Wired into Philo (integration, `createApp` with the module listening to its feed).**
- A form submission reaches the fake Notify as one post. A spam submission posts nothing, and promoting it posts once.
- An API-key stage move resolves and posts `moved` (with U1). A PWA-session move only resolves. Deleting the lead
  withdraws.
- With Notify answering 500, or unreachable, or hanging: intake still answers its usual 2xx, the email hook and the push
  hook still run, and the request does not wait on Notify.
- Configuration: none set means the module is off and nothing is sent. A partial set fails boot, naming the variables and
  showing no value. `http` URLs are refused in production.

## 14. Open questions

- **`<philo-client>` and the tile** come from `ol/spec-auth`. This design assumes Philo has one tile whose launch origin
  is `PHILO_APP_URL`'s.
- **Notify's production resource identifier** is still marked TODO in Notify's SPEC §2.
- **New lead as `action`** (§5): confirm with the operator that *Needs you* until the lead is moved is wanted, rather
  than `info`.
- **Email failure as a `danger` item** ("Couldn't send the new-lead email. Check the mail settings.") would tell the
  operator, in any app, that the guaranteed channel is broken. It needs a seam on the email service, not the change feed.
  Proposed as later work.
- **If the human prefers A** (no Oberon code in Philo's process), the appendix lists what it takes. The upstream work
  for A is larger, and two of its changes revisit accepted ADRs.

## Appendix: option A, as it would have to be

Recorded so the decision can be revisited without starting over.

- **Source.** The SSE stream `GET /api/v1/events`. Webhooks are worse for a bridge: the runner pulls, so a webhook source
  needs an inbound listener in the bridge process, reachable from Philo, plus a durable inbox of its own. The SSE event
  id is a random UUID with no order and no replay, so the adapter's cursor could only be "the last event seen", and
  after any gap it must resume from now. Some of what was lost can be caught up for new leads, by reading
  `GET /api/v1/leads?createdAfter=<cursor time>` on reconnect. Stage moves and deletions cannot be caught up. Meeting
  SPEC §6.2's durable cursor properly needs upstream **a durable change log with a monotonic sequence**
  (`GET /api/v1/changes?after=<seq>&limit=`, and `id:` plus `Last-Event-ID` on the SSE stream), with erasure rules for
  the stored lead data. That is ADR-0010's "durable outbox" and needs an ADR.
- **Credential.** A Philo API key, which today has full authority. DESIGN §7.7 requires read-only, so production would
  need **scoped API keys** upstream (a key created with `read`, for example, refused on every non-GET and on the MCP
  tools that write), with an ADR amending ADR-0007, which names per-credential scope as its upgrade path. That is a
  blocker for production, though not for building and testing the adapter.
- **Actor.** U1 is needed as in B.
- **Mapping, keys, text, recipients and href.** As §5–§9, with `dedupe_key` built by the runner as
  `philo:<key>`, with `key` = `lead:<id>:new` and so on.
- **Notify configuration.** `BRIDGE_ADAPTERS=philo`; `BRIDGE_PHILO_AS=<philo-client>`; `BRIDGE_PHILO_URL` (Philo's
  origin); `BRIDGE_PHILO_API_KEY` (the scoped key); `BRIDGE_PHILO_ROLE` (the role); the bridge's own service account,
  `BRIDGE_CLIENT_ID` and `BRIDGE_CLIENT_SECRET`, with its post-as line `{"<bridge>": ["<philo-client>"]}`.
- **Tests (notify repo).** A fake Philo: an SSE server that a test feeds with events, drops and restarts, plus the leads
  list for catch-up. Against it: the §13 mapping cases; the cursor after a restart; the catch-up of new leads after a
  gap; and that the key never reaches a log.
