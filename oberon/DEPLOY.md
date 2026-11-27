# Deploying the Oberon Logistics fork of Philo

This is a plan. Nothing in it has run against production yet. Items marked **DECIDE** need a human decision. The
generic operations (data directory, backup, restore, upgrade) are in [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md),
and this page doesn't repeat them.

## 0. Where things stand

| | Today | Target |
|---|---|---|
| Host | Its own host, Caddy in front, TLS by ACME | **The same host**, the same Caddy, the same DNS record |
| Image | Stock upstream `ghcr.io/philo-crm/philo` at `0.5.1` | `ghcr.io/oberonlogistics/philo:ol-v<upstream>-<n>@sha256:<digest>` (§2) |
| Identity | The built-in IdP | OL Auth (`https://auth.oberonlogistics.com`) with the `philo:user` and `philo:admin` scopes (ADR-0012) |
| Chrome, bell | None | The shared chrome and the Notify feed |
| State | One SQLite data volume on the current host | **The same volume**, not copied anywhere |

The cutover is **one window**: the image, the OL Auth settings, the chrome and the Notify settings change together,
on the current host, on the existing data volume. An intake gap of up to 15 minutes is accepted. (Not chosen: moving
to the shared OL apps host, and splitting the work into a host phase and an integration phase.)

**Intake must never break for longer than the window.** The public site posts recruiting leads to
`https://philo.oberonlogistics.com/api/intake/<form_key>`, and its `scripts/health-check.sh` checks the CORS preflight
for that URL from `https://oberonlogistics.com` (a `204` response with that origin allowed).

## 1. Who does what

**HUMAN** marks every step that touches production, real data, OL Auth, Caddy, Cloudflare or a release tag. The human
runs those steps. Agents prepare the commands and never run them.

- Agents never read production, a copy of its data, or the host's env files.
- Agents rehearse this whole runbook only on a **synthetic** instance: a fresh stock v0.5.1 with made-up leads, an
  attachment, a push subscription and a webhook, upgraded to the fork tag through §5 and rolled back through §6.
- A rehearsal on a copy of production is HUMAN work (§4.3), and it must not reach real people.

## 2. The image

### 2.1 The Oberon layer: `oberon/Dockerfile`

The PWA has to serve `oberon/web/*` from its own origin at `/oberon/…`, for the chrome's host script (chrome spec
§3.1). The standalone app already serves any file under `apps/web/dist` (`apps/standalone/src/app.ts`, `serveStatic`),
so the image only needs to copy the files in. [`oberon/Dockerfile`](Dockerfile) does that, and upstream's
`Dockerfile` stays untouched:

```dockerfile
# oberon/Dockerfile (abridged): the Oberon layer on top of the stock Philo image built from the same commit.
ARG PHILO_BASE
FROM busybox:1.37@sha256:<index digest> AS oberon-web
COPY oberon/web/ /in/
RUN mkdir /out && find /in -maxdepth 1 -type f \( -name '*.js' -o -name '*.css' \) -exec cp {} /out/ \;

FROM ${PHILO_BASE}
COPY --from=oberon-web /out/ /app/apps/web/dist/oberon/
```

- **The base image is built first, from the same commit:** `docker build -t philo-upstream:local .` (upstream's
  `Dockerfile`), then `docker build -f oberon/Dockerfile --build-arg PHILO_BASE=philo-upstream:local .`.
  `PHILO_BASE` has no default, so forgetting it fails the build instead of layering onto a stale local image.
- **A throwaway busybox stage picks the files:** only the top-level `oberon/web/*.js` and `*.css` reach the image, so
  `README.md` and a later `oberon/web/test/` stay out without touching `.dockerignore`. A `COPY` glob would fail the
  build whenever no `.css` (or no `.js`) file exists; `find` copies zero files happily. busybox is pinned by its
  multi-arch index digest.
- **No `--chown`:** the served files stay root-owned and `0644`, readable but not writable by the app's `node` user,
  like the rest of `dist`. A file-write bug as `node` can't then plant a script served same-origin to every user.
- It inherits `USER node`, the `HEALTHCHECK`, `VOLUME /data` and `CMD`. `.dockerignore` doesn't exclude `oberon/`.

### 2.2 Published by a fork-only workflow

[`.github/workflows/ol-release.yml`](../.github/workflows/ol-release.yml) ("Oberon release image"). Upstream's
`docker-publish.yml` is untouched, because every sync would conflict on it. It is recorded in `oberon/AGENTS.md`.

- `on: push: tags: ['ol-v*']`, plus `workflow_dispatch` with an existing tag as input. Both must match
  `^ol-v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$`. Only `oberonlogistics/philo` runs it.
- **The tagged commit must be on `main`** (`git merge-base --is-ancestor HEAD origin/main`), so code that skipped the
  fork merge bar can't be published, by tag or by dispatch. The tag's `<upstream version>` must equal the root
  `package.json` `version`.
- Build the upstream `Dockerfile` (load only, never pushed), then `oberon/Dockerfile` with `PHILO_BASE` set to it.
- Smoke-test the **layered** image, as upstream's workflow does for the stock one: `GET /version` returns
  `name: philo` and the `package.json` `version`. Then every `oberon/web/*.js` and `*.css` in the checkout must be
  served at `/oberon/<file>` with 200 (none today; `philo-host.js` once the chrome lands). And once upstream's
  standalone app sets a `Content-Security-Policy`, `GET /` must still carry it (skipped while the source has none).
- Push `ghcr.io/oberonlogistics/philo:<tag>` only, and print `<image>:<tag>@sha256:<digest>` in the job summary:
  that is the reference production pins (rule 1 below). Each action is pinned by SHA, as upstream does.

**The package is shared with stock images.** Upstream's `docker-publish.yml` publishes `${{ github.repository }}`,
which in the fork is the same `ghcr.io/oberonlogistics/philo`:

- every push to fork `main` publishes `:edge`, built from the upstream `Dockerfile`, **without** the Oberon layer;
- any `v*` tag that reaches origin publishes `:0.5.1`, `:0.5`, `:0` and `:latest`, also stock.

So only the tag and digest keep production on the right image. The rules:

1. Production pins `ghcr.io/oberonlogistics/philo:ol-v<…>-<n>@sha256:<digest>`. Never `:latest`, `:edge` or a semver tag
   from this package.
2. The stock rollback image comes from **upstream's** package, pinned: `ghcr.io/philo-crm/philo:0.5.1@sha256:<digest>`.
   Record the digest of the image production runs today (`docker inspect`) in the pre-checks.
3. Never push `v*` tags to origin. After `git fetch upstream --tags`, push only the one `ol-v*` tag by name (§7).
4. A rebuild via `workflow_dispatch` produces a new digest under the same tag. The pin by digest keeps production on
   the image that passed the rehearsal.

## 3. Running it on the current host

### 3.1 The committed files

`oberon/deploy/compose.yaml`, a sketch (not a file yet). The values in angle brackets are placeholders, set in the
uncommitted host override.

```yaml
# Production on its current host. From the deploy directory, a checkout of the release tag:
#   docker compose -f oberon/deploy/compose.yaml -f oberon/deploy/compose.ol.yaml -f <host override> up -d
name: ol-philo

services:
  philo:
    image: ${OL_PHILO_IMAGE:?pin ghcr.io/oberonlogistics/philo:ol-v…@sha256:… in the host override}
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: 10m, max-file: "5" } }
    # Reachable only by Caddy: a loopback port if Caddy runs on the host (the override may swap this
    # for Caddy's Docker network). Never a public port.
    ports: ["127.0.0.1:${OL_PHILO_PORT:?}:3000"]
    volumes:
      - philo-data:/data
    environment:
      PHILO_PUBLIC_BASE_URL: https://philo.oberonlogistics.com
      # Safe only because nothing but Caddy can reach the port (DEPLOYMENT.md § PHILO_TRUSTED_PROXY).
      PHILO_TRUSTED_PROXY: "true"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/version"]
      interval: 30s
      timeout: 3s
      start_period: 10s
      retries: 3

volumes:
  philo-data:
    external: true                      # production's existing volume: no copy, no move
    name: ${OL_PHILO_VOLUME:?set to the existing data volume}
```

`oberon/deploy/compose.ol.yaml` holds only the **non-secret** OL environment from §3.3. Dropping that `-f` is the fast
rollback (§6, R1). The host override holds `OL_PHILO_IMAGE`, `OL_PHILO_PORT`, `OL_PHILO_VOLUME` and the one secret,
`OL_NOTIFY_CLIENT_SECRET` (in an env file with mode 600). Never put that secret in the repository.

**DECIDE (D10):** move production's launch to this compose file in the window (recommended: one way to start it,
and the env lives in files), or keep its current `docker run` and pass the same env with `--env-file`. Either way,
record the current launch command (`docker inspect`) before the window, because rollback R2 needs it.

### 3.2 Caddy and caching (HUMAN)

- Caddy's upstream stays the same address and port, so its site block shouldn't need a change. `POST /mcp` streams,
  so don't add a write timeout.
- **`X-Forwarded-For` must carry the caller's address (D9).** Philo reads it right to left and stops at the
  rightmost public address. If Caddy is the first hop, its default (it replaces the header with the peer address) is
  right. If the `philo` record is proxied through Cloudflare, Caddy sees Cloudflare's addresses, and every caller
  behind one edge shares a rate-limit budget; then Caddy must trust Cloudflare's ranges (`trusted_proxies`). Check
  which applies in the rehearsal: Caddy's access log next to Philo's per-caller limits.
- At Cloudflare, make sure no WAF, bot-fight or challenge rule applies to `/api/intake/*`. A cross-origin `fetch`
  can't solve a challenge, and the health check's `OPTIONS` preflight wouldn't notice. The test lead in §5 does.
- **Cache of `/oberon/*`.** Philo sets `Cache-Control` only for HTML, `/assets/*`, `/sw.js` and the manifest, so
  browsers (and Cloudflare, if proxied) cache `/oberon/philo-host.js` heuristically. Version the URL per release:
  `PHILO_WEB_HOST_SCRIPT_URL=/oberon/philo-host.js?v=<tag>` (the chrome implementation must accept a query string).
  Alternatively, have Caddy add `Cache-Control: no-cache` for `/oberon/*`.

### 3.3 The OL environment

Each line names the branch it depends on. A setting whose branch isn't in the deployed tag either has no effect or is
a startup error, so cut the tag only after all of them are merged into fork `main`. Release 1 is the exception: it
sets only the lines already merged, as [`CUTOVER.md`](CUTOVER.md) §5 lists.

The identity lines are a copy of identity spec §3, which is the single source: change them there first, and keep
this copy identical. On an image without `up/oidc-multi-user` and `up/oidc-any-agent-client`, the scope and agent
lines are silently ignored, and `*` is read as a literal client id (identity spec §3).

`docker --env-file` takes values literally, so the values have no quotes and no comment after a value (only whole-line `#` comments).

```sh
# Identity: identity spec §3 (the single source; keep identical)
PHILO_OIDC_ISSUER=https://auth.oberonlogistics.com
PHILO_OIDC_CLIENT_ID=philo
# up/oidc-audiences (ID-U1, merged)
PHILO_OIDC_AUDIENCE=https://philo.oberonlogistics.com/api,https://philo.oberonlogistics.com/mcp
# up/oidc-sign-in-request (ID-U3, merged)
PHILO_OIDC_SCOPE=openid email profile offline_access philo:user philo:admin
# up/oidc-sign-in-request (ID-U3, merged)
PHILO_OIDC_RESOURCE=https://philo.oberonlogistics.com/api
# up/oidc-multi-user (MU-b)
PHILO_OIDC_USER_SCOPE=philo:user
# up/oidc-multi-user (MU-b)
PHILO_OIDC_ADMIN_SCOPE=philo:admin
# up/oidc-multi-user (MU-b)
PHILO_OIDC_AGENT_SCOPE=philo:user philo:admin offline_access
# up/oidc-any-agent-client (ID-U5)
PHILO_OIDC_AGENT_CLIENT_IDS=*

# Chrome: chrome spec §3.3 (up/pwa-csp, UP-2..UP-4, ol/ chrome)
PHILO_WEB_HOST_SCRIPT_URL=/oberon/philo-host.js?v=<tag>
PHILO_WEB_HOST_CONFIG={"notifyUrl":"https://notify.oberonlogistics.com","notifyResource":"https://notify.oberonlogistics.com"}
PHILO_WEB_ASSET_ORIGINS=https://auth.oberonlogistics.com
PHILO_WEB_CONNECT_ORIGINS=https://auth.oberonlogistics.com,https://notify.oberonlogistics.com

# Notify: notifications spec §12.3 (ol/ notify module, change-feed seam)
OL_NOTIFY_URL=https://notify.oberonlogistics.com
OL_NOTIFY_RESOURCE=https://notify.oberonlogistics.com
OL_NOTIFY_CLIENT_ID=<the philo notify service account>
OL_NOTIFY_CLIENT_SECRET=<secret: host override only>
OL_NOTIFY_AS=philo
OL_NOTIFY_ROLE=<the Philo users role's slug>
```

- `PHILO_APP_URL` and `PHILO_MCP_URL` stay unset, because their defaults are the production addresses.
- `OL_NOTIFY_ROLE` is the Philo **users** role (D7), so everyone who works leads gets the bell. Each member must also
  be able to open the Philo tile (notifications spec §12.1).
- **OL Auth registration (HUMAN)** follows identity spec §5, with ADR-0012's scopes in place of the single
  `philo:use`: the scopes `philo:user` and `philo:admin` on the Philo resource, both with `dynamic_clients: true`; a
  users role that holds `philo:user` and an admin role that holds both; the `philo` client's scope list carries both.
  The production account (`id=1`) binds by verified email (identity spec §4.1). Migration `0013_user_roles` already
  makes it an admin, and the admin scope keeps it one.

## 4. Data

### 4.1 Backups — **open (D3), decide before the cutover**

The data stays on its volume, so the existing backups on the current host carry on as they are. Before the window,
decide: confirm they take the online form (`sqlite3 .backup`, DEPLOYMENT.md § Backup) with both key files, where the
copies go off the host, and a retention period you can state (deleted leads survive in backups). The cutover itself
doesn't wait on a new backup job; it needs only the named pre-cutover backup in §5.

### 4.2 What the volume holds

| File | Why it matters |
|---|---|
| `philo.db` | Everything: leads, timeline, **attachments** (bytes in `lead_attachment_blobs`), users, API keys, push subscriptions, webhooks, SMTP settings, intake form keys |
| `vapid-keys.json` | Without it, every device loses its push subscription |
| `oidc-signing-key.json` | Keeps built-in IdP sessions alive. Unused under OL Auth, but rollback R1 needs it |

The website's form key is a row in `intake_forms`, so the intake URL doesn't change.

### 4.3 Rehearsal on a copy (HUMAN, days before)

It runs on the production host, next to the only copy of the data, so every name is distinct and checked:

```sh
SCRATCH=philo-scratch          # volume and container name; never production's
PORT=<a free loopback port, not OL_PHILO_PORT>
docker volume create "$SCRATCH"
# Online backup from production into ./rehearsal/philo-rehearsal.db (DEPLOYMENT.md § Backup, online form;
# reading production is the only thing this step does to it). Then:
test "$SCRATCH" != "<production volume>" || exit 1   # the guard before anything writes to a volume
docker run --rm -v "$SCRATCH":/data -v "$PWD/rehearsal":/backup alpine sh -c '
  cp /backup/philo-rehearsal.db /data/philo.db && chown -R 1000:1000 /data'
```

**Neutralise the copy before its first start**, so nothing reaches real people:

```sh
docker run --rm -v "$SCRATCH":/data alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 /data/philo.db "
  DELETE FROM settings WHERE key LIKE '\''email.%'\'';   -- no SMTP: the boot sweep re-sends owed new-lead email
  DELETE FROM push_subscriptions;                       -- no pushes to real devices
  DELETE FROM webhooks;"'                               # no deliveries to real receivers
```

- Don't copy `vapid-keys.json` into the scratch volume. A fresh key pair is generated, so even a leftover
  subscription can't be pushed to.
- Leave every `OL_NOTIFY_*` variable unset (or point them at a non-production Notify), so nothing posts to the real feed.
- Set `PHILO_PUBLIC_BASE_URL=http://localhost:24910` and use the rehearsal client `philo-dev` (identity spec §4.3)
  for OL Auth. The redirect is built from the browser's origin, and `philo-dev` registers only
  `http://localhost:24910/auth/callback`, so forward that address to the scratch port:
  `ssh -L 24910:localhost:$PORT`. Override these, as identity spec §4.3 does: `PHILO_PUBLIC_BASE_URL`,
  `PHILO_OIDC_CLIENT_ID=philo-dev`, and `PHILO_OIDC_AGENT_CLIENT_IDS` set to the rehearsal's listed ids, **never `*`**.
  Everything else is identity spec §3. **Release 1 doesn't use this section's sign-in:** it rehearses per
  [`CUTOVER.md`](CUTOVER.md) §6, with no `philo-dev` and the bind checked live. `PHILO_TRUSTED_PROXY=true`
  stays, so the boot-log check below holds; with loopback only, nobody but the host can spoof `X-Forwarded-For`.
- Start it only with `-p 127.0.0.1:$PORT:3000`, `--name "$SCRATCH"`, and no Caddy route. Never `docker stop` or
  restore by a name you didn't type from `$SCRATCH`.

Then check: `PRAGMA integrity_check` is `ok`; migrations applied (boot log); sign-in through OL Auth; a lead with an
attachment opens; the chrome loads (chrome release only, and not with `philo-dev`, which isn't first-party); the boot log shows
`rate limits:     per caller, from X-Forwarded-For (PHILO_TRUSTED_PROXY=true)`. Rehearse rollback R1 and, if the
tag has migrations, the R2 data path (§6) on the same copy. Write down how long each step took. Afterwards delete the
scratch container, volume and `./rehearsal/`: they hold applicants' personal data.

## 5. Cutover runbook (one window, at most 15 minutes)

During the window, Caddy returns 502 for Philo. The website's form (`public/js/driverleadform.js` in the website repo)
then shows *"Your submission was not received. Try again, or email … or call …"*. Nothing is queued, but no applicant
is told a submission went through. Pick a low-traffic hour.

**Pre-checks** (the day before and again at T-0):

- [ ] HUMAN: the tag `ol-v<…>-<n>` is pushed; the workflow passed; the digest is recorded; the layered image pulled
      on the host answers `GET /oberon/philo-host.js` with 200 (a throwaway container on loopback, no data volume).
- [ ] HUMAN: the stock rollback image `ghcr.io/philo-crm/philo:0.5.1@sha256:<digest>` and the current launch command
      are recorded.
- [ ] **Which rollback you hold:** `git diff --name-only v0.5.1 <tag> -- 'packages/server/drizzle/*.sql'`. Empty means
      R2 is only an image swap. Otherwise list each migration, its reversal SQL, what it permits that stock wouldn't
      restrict, and the date its reversal was rehearsed (§6). As of `up/roles-authz` (not yet merged, 2026-11), the
      only one is `0013_user_roles`.
- [ ] HUMAN: OL Auth registration is done (§3.3). **`philo-dev` is deleted** before `PHILO_OIDC_AGENT_CLIENT_IDS=*`
      goes live: with `*`, any client registered at OL Auth, including one with a loopback redirect, is admitted as
      an agent. The operator's Philo email equals their verified OL Auth email.
- [ ] The rehearsal (§4.3) passed, including the D9 check.
- [ ] Baseline: the website's `scripts/health-check.sh` passes. Save the output.

**The switch** (HUMAN):

1. Stop production (`docker stop <production container>`). The window opens. Write down the time as **T0**, in
   Unix milliseconds (`date +%s%3N`): the rollback filters on it.
2. Take the pre-cutover backup into a **named** file, `philo-precutover-<tag>.db`, plus both key files (DEPLOYMENT.md
   online form; nothing writes now). Run `PRAGMA integrity_check` on it (expect `ok`) and record
   `SELECT count(*), max(created_at) FROM leads` with `sqlite3 -readonly` in the helper container (the Philo image
   has no `sqlite3`). Copy the three files off the host. Don't go on until the copy is verified.
3. Turn on the **intake hold** in Caddy (prepared and tested ahead): `/api/intake/*` answers `503`, so the website
   form shows its fallback, while the rest of the site routes to Philo. Reload Caddy.
4. Start the new image on the **same** volume with the full environment (`docker compose … up -d`, or the recorded
   `docker run` with the new image and env file, per D10). Migrations run at boot. Wait for `healthy`.
5. Check the boot log: migrations applied, and the line
   `rate limits:     per caller, from X-Forwarded-For (PHILO_TRUSTED_PROXY=true)`, not the `note: rate limits key on
   the socket address…` warning.
6. **Confirm the operator account's role before agents reconnect.** ADR-0012's 30-day role confirmation for an
   externally managed account counts from the migration that adds roles, not from the cutover. The existing operator
   (`id=1`) signs in to the PWA through OL Auth, which binds the account and confirms its role, then checks that an
   existing API key works against `/api/v1`. **Fallback** if sign-in fails: stop Philo (one writer), run
   `UPDATE users SET role_confirmed_at = <now in ms> WHERE id = 1;` with `sqlite3` in the helper container, start it
   again, and retry — or roll back (§6).
7. Turn off the intake hold and reload Caddy. Intake is open again.

**Post-checks** (HUMAN; they touch production and real data; the window closes when all pass):

- [ ] `scripts/health-check.sh` passes, including `OK   Philo intake preflight from https://oberonlogistics.com`.
- [ ] One test lead through the real website form shows the success message, appears in Philo, and the notification
      email arrives. Then delete it. (It is a real lead and sends real email, so post only one.)
- [ ] Per-caller limits: Caddy's access log shows the test post's real client address, and Philo's `429`s (if any)
      don't fire for unrelated callers. Don't flood intake to test this.
- [ ] Lead count and `max(created_at)` with `WHERE created_at <= T0` match step 2.
- [ ] Sign in through OL Auth. A lead's attachment opens. The chrome renders.
- [ ] The bell: push on a device that was already subscribed, and the Notify bell in another OL app shows the test
      lead (notifications spec §12.3).
- [ ] An existing API key works against `/api/v1`.

## 6. Rollback (HUMAN)

Leads keep arriving once intake is back, so a rollback must not lose leads, stage moves, notes or **deletions** made
after T0 (an erasure honoured after the cutover must not come back).

**R1: environment only (the fast path, no data lost).** Use it when the problem is identity, chrome or Notify and the
fork image itself works. Drop `-f oberon/deploy/compose.ol.yaml` (or the OL env file) and restart the **same image on
the same volume**. The built-in IdP comes back with the same account and signing key (identity spec §4.4), but the account is now
bound to OL Auth, so the rehearsal must confirm built-in password sign-in still works for it; the
migrations stay applied and the fork image understands them. Nothing is restored, so nothing is lost.

**R2: back to the stock v0.5.1 image.** Use it only when the fork image itself fails. Stock v0.5.1 is not supported on
a database a newer binary has migrated (DEPLOYMENT.md § Restore, last paragraph), and there are no down migrations.
`0013_user_roles` only adds three nullable columns to `users` and fills `role`; its DDL can be reversed by hand
(`ALTER TABLE users DROP COLUMN` ×3, then delete its row from `__drizzle_migrations`), but only if that was rehearsed
on the copy. **A migration's reversal must undo what it permits, not just its DDL.** A table or column that narrows
access (roles, disabling, scopes) can't be reversed by dropping it alone: stock v0.5.1 treats every `users` row as a
full operator, so each non-admin or disabled account's API keys, tokens and sessions would gain admin rights. So:

1. Stop the new instance, so there is one writer.
2. Take an online backup of the **new** database first, `philo-postcutover-<tag>.db`. Never delete it: it holds the
   post-T0 data.
3. Pick the data path:
   - **No migrations in the diff:** start the stock image (by digest) with the old launch command on the same volume.
     Done; nothing is lost.
   - **Every migration has a rehearsed hand reversal, and `SELECT count(*) FROM users` is 1:** apply the reversals to
     the volume, then start the stock image on it. Nothing is lost. If there are other accounts, first revoke every
     credential of each account other than `id=1` (delete its rows in `api_keys`, `sessions`, `access_tokens`,
     `refresh_tokens` and `authorization_codes`), rehearsed like the schema reversal. If that can't be done, take the
     next path.
   - **Otherwise:** restore `philo-precutover-<tag>.db` and both key files (DEPLOYMENT.md § Restoring the online
     backup), start the stock image, then **carry over** from `philo-postcutover-<tag>.db` (read with
     `sqlite3 -readonly`): leads with `created_at > T0`, with their `lead_events` and attachments; notes and stage
     moves on older leads (`lead_events` with `created_at > T0`); field edits that write no event (leads with
     `updated_at > T0` and `created_at <= T0`: compare fields); and **deletions** (lead ids present in the
     pre-cutover backup but missing in the post-cutover one, deleted again on the restored instance). Re-enter them
     through the UI or `/api/v1`. There is no merge tool.
4. Run the post-checks again: `scripts/health-check.sh`, one test lead, sign-in, a lead's attachment.

Keep both named backups until the next release has run cleanly; then delete them under the retention decided in D3.

## 7. Releases (HUMAN pushes tags)

- Tag fork releases on fork `main` as `ol-v<upstream version>-<n>`: `ol-v0.5.1-1` first. `<upstream version>` is the
  root `package.json` `version` at that commit, which only syncs change. `<n>` starts at 1 for each upstream version
  and goes up for every fork release on it. **A tag is never reused or moved**, because production pins tag and
  digest.
- When a sync brings in a new upstream release (for example 0.6.0), the next tag is `ol-v0.6.0-1`. A sync that brings
  in only unreleased upstream commits keeps the version and bumps `<n>`.
- Tag with `git tag -s` if signing is set up, or `git tag -a` otherwise, and push **only that tag**:
  `git push origin ol-v0.5.1-1`. Never `git push --tags`: it would push upstream's `v*` tags and publish stock
  `:latest` and semver images into our package (§2.2).
- `GET /version` reports the upstream version only, so `ol-v0.5.1-1` and `-2` both say `0.5.1`. The pinned image tag
  shows which fork release runs.
- Upgrading (HUMAN) is DEPLOYMENT.md § Upgrading in this layout: back up to a named file, set the new tag and digest in
  `OL_PHILO_IMAGE`, bump `?v=` in `PHILO_WEB_HOST_SCRIPT_URL`, `up -d`. Rolling back without a migration means setting
  the previous tag and digest; with one, §6 R2 applies.

## 8. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Where it runs | Decided: the current host, no DNS change |
| D3 | Backups (§4.1) | **Open.** Existing backups continue; confirm form, off-host destination and retention before the cutover |
| D4 | Image source (§2) | Decided: GHCR, `ol-v*` from the fork-only workflow, pinned by digest |
| D5 | Intake during the window (§5) | Decided: at most 15 minutes; the form shows its fallback |
| D6 | Phases | Decided: one window |
| D7 | `OL_NOTIFY_ROLE` (§3.3) | Decided: the Philo users role |
| D8 | Notify's resource identifier (§3.3) | Decided: `https://notify.oberonlogistics.com` |
| D9 | Caddy's `X-Forwarded-For` handling (§3.2) | Check in the rehearsal |
| D10 | Launch via `oberon/deploy/compose.yaml` or the current `docker run` (§3.1) | **Open.** Recommended: compose, on the existing volume |
