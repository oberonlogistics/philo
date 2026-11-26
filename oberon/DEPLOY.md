# Deploying the Oberon Logistics fork of Philo

This is a plan. Nothing in it has run against production yet. Items marked **DECIDE** need a human decision. The
generic operations (data directory, backup, restore, upgrade) are in [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md),
and this page doesn't repeat them.

## 0. Where things stand

| | Today | Target |
|---|---|---|
| Image | Stock upstream `ghcr.io/philo-crm/philo` at `0.5.1` | The fork image (§2), built from a release tag `ol-v<upstream>-<n>` |
| Host | Its own host, Caddy in front, TLS by ACME | The OL apps host: Docker Compose, the shared reverse proxy container, the Cloudflare tunnel |
| Identity | The built-in IdP | OL Auth (`https://auth.oberonlogistics.com`) with the `philo:user` and `philo:admin` scopes (ADR-0012) |
| Chrome, bell | None | The shared chrome and the Notify feed |
| State | One SQLite data directory on the current host | The same directory, moved onto a local named volume |

Do the move in **two phases**. Each phase changes one thing, and each has its own rollback.

1. **Phase 1, the host move.** Production runs `ol-v0.5.1-1` on the OL apps host, still on the built-in IdP. That
   tag's code is v0.5.1. `git diff --stat v0.5.1 origin/main -- packages apps Dockerfile package.json package-lock.json`
   shows one test file changed, so the only thing that changes in this phase is where Philo runs. Phase 1 doesn't
   depend on any open upstream PR.
2. **Phase 2, the integration.** Add the OL Auth, chrome and Notify settings (§4.2) and restart. Rolling back means
   removing those settings and restarting again (identity spec §4.4). Phase 2 can start only when the `up/` and `ol/`
   branches it needs are merged into fork `main` and tagged (§4.2).

**Intake must never break for longer than the cutover window.** The public site posts recruiting leads to
`https://philo.oberonlogistics.com/api/intake/<form_key>`, and its `scripts/health-check.sh` checks the CORS preflight
for that URL from `https://oberonlogistics.com` (a `204` response with that origin allowed).

## 1. Where it runs

| | A. Move to the OL apps host (**recommended**) | B. Stay on the current host |
|---|---|---|
| Ops model | The same as auth, notify, handbook and dash: a deploy directory, a tagged checkout, a compose file plus an uncommitted host override, the shared proxy, the tunnel | A second model to maintain alone: its own Caddy, its own ACME, its own OS updates |
| Exposure | No published ports. Only the tunnel reaches the proxy. | Ports 80 and 443 are open on a public address. |
| SQLite | Must be on a local named volume on that host. Never put it on NFS or a network share. | Unchanged |
| Push (VAPID) | `vapid-keys.json` moves with the data directory, and the origin stays the same, so existing push subscriptions keep working | Unchanged |
| DNS | The `philo` record moves to the tunnel at Cloudflare (§5.3) | Unchanged |
| Rollback | Point DNS back at the old host, whose data directory is left as it was at the freeze (§6) | Not applicable |
| Cost | One cutover window, and Philo shares a host with four other apps (a noisy neighbour, one failure domain) | Nothing now, and it stays different from the other apps for good |

**Recommendation: A.** Keep the old host intact, with Philo stopped, as the rollback target until the soak period ends.
**DECIDE:** how long the soak lasts (proposed: 14 days) and when the old host is shut down.

Before the old host is retired, check two things:

- If the old host has a backup job for Philo's data, set up the same job on the OL apps host first. The new host's
  backups have to include the volume `ol-philo-data` (`docs/DEPLOYMENT.md` § Backup, online form). Keep the copies off
  the host. **DECIDE:** where they go, and how long they are kept. Deleted leads survive in backups, so the retention
  period should be one you can state (DEPLOYMENT.md § Backup).
- Notification email is sent through the SMTP settings stored in the database, so it moves with the data. If the SMTP
  provider allows sending only from known source addresses, the OL apps host's outbound address has to be added there.

## 2. The image

### 2.1 Layering the Oberon files

The PWA has to serve `oberon/web/*` from its own origin at `/oberon/…`, for the chrome's host script (chrome spec
§3.1). The standalone app already serves any file under `apps/web/dist` (`apps/standalone/src/app.ts`, `serveStatic`),
so the image only needs to copy the files in. Add a new file and leave upstream's `Dockerfile` alone:

```dockerfile
# oberon/Dockerfile: the Oberon layer on top of the stock Philo image built from the same commit.
# syntax=docker/dockerfile:1
ARG PHILO_BASE
FROM ${PHILO_BASE}
COPY --chown=node:node oberon/web/*.js oberon/web/*.css /app/apps/web/dist/oberon/
```

It inherits `USER node`, the `HEALTHCHECK`, `VOLUME /data` and `CMD`. The glob takes only the top level, which leaves
out `oberon/web/test/`. `.dockerignore` doesn't exclude `oberon/`. Until `oberon/web/` exists (the chrome work), the
build fails on the COPY. For phase 1, use the stock build by itself (`ol-philo-base:<sha>` below).

### 2.2 Build locally or pull from GHCR

| | A. Build on the OL apps host from the tagged checkout (**recommended**) | B. Pull a CI-built image from GHCR |
|---|---|---|
| Matches the other apps | Yes. They are built on the host and tagged `<app>:<git sha>`. | No |
| What the host needs | Docker with BuildKit. Building takes a few minutes and needs npm registry access. | Only `docker pull`. The fork is public, so the package can be public. |
| Smoke test | Run by hand (§5.4 post-checks). Fork CI already boots the upstream image on every PR. | CI checks `/version` before it pushes. |
| Work needed | None | A new workflow file (below) |

**Recommendation: A**, so that every OL app has one ops model. The image is fully determined by the tag, and rolling
back means pointing at an image tag that is already on the host. **DECIDE.**

```sh
# In the deploy directory's checkout. The human runs this on the OL apps host.
git fetch --tags origin && git checkout --detach ol-v0.5.1-1
SHA=$(git rev-parse --short=12 HEAD)
docker build -t ol-philo-base:$SHA .
docker build -f oberon/Dockerfile --build-arg PHILO_BASE=ol-philo-base:$SHA -t ol-philo:$SHA .   # once oberon/web exists
# then set OL_PHILO_IMAGE=ol-philo:$SHA (phase 1: ol-philo-base:$SHA) in the host override
```

**If you choose B:** upstream's `docker-publish.yml` doesn't fire on `ol-v*` tags. On pushes to `main` it publishes
`:edge` (`type=edge,branch=main`), and that image is the upstream `Dockerfile` without the Oberon layer. Don't edit
that file, because every sync would conflict on it. Add `.github/workflows/oberon-image.yml` instead:

- `on: push: tags: ['ol-v*']`, plus `workflow_dispatch` with a tag input that must match `^ol-v[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$`.
- Build the upstream `Dockerfile` (load only), then `oberon/Dockerfile` with `PHILO_BASE` set to that image.
- Run the same `/version` smoke test as `docker-publish.yml`, and also check that `GET /oberon/philo-host.js` returns 200.
- Push to a separate package, `ghcr.io/oberonlogistics/philo-ol:<tag>`, so it never shares tags with the `:edge`
  image built from the upstream `Dockerfile`. Pin each action by SHA, as upstream does.
- Record the new file in `oberon/AGENTS.md`. It is a new file, not an edit to an upstream file.

## 3. Compose

### 3.1 The committed file: `oberon/deploy/compose.yaml`

This is a sketch, not a file yet. The values in angle brackets are placeholders.

```yaml
# The fork's production stack on the OL apps host. Run from the deploy directory:
#   docker compose -f oberon/deploy/compose.yaml -f <host override> up -d
name: ol-philo

x-logging: &logging
  driver: json-file
  options: { max-size: 10m, max-file: "5" }

services:
  philo:
    image: ${OL_PHILO_IMAGE:?set OL_PHILO_IMAGE in the host override}
    restart: unless-stopped
    logging: *logging
    # No `ports:`. Only the shared proxy reaches philo:3000, over its network.
    networks: [proxy]
    volumes:
      - philo-data:/data
    environment:
      PHILO_PUBLIC_BASE_URL: https://philo.oberonlogistics.com
      # Safe only because nothing but the proxy can reach the port (DEPLOYMENT.md § PHILO_TRUSTED_PROXY).
      PHILO_TRUSTED_PROXY: "true"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/version"]
      interval: 30s
      timeout: 3s
      start_period: 10s
      retries: 3

networks:
  proxy:
    external: true
    name: ${OL_PROXY_NETWORK:?set OL_PROXY_NETWORK in the host override}

volumes:
  philo-data:
    name: ol-philo-data   # A local volume. Never NFS: SQLite in WAL mode needs local locking.
```

Phase 2 adds a second committed file, `oberon/deploy/compose.ol.yaml`, that holds only the **non-secret** OL
environment from §4.2. Phase 2 starts by adding that `-f`, and it is rolled back by taking the `-f` off again. The
uncommitted host override holds `OL_PHILO_IMAGE`, `OL_PROXY_NETWORK` and the one secret,
`OL_NOTIFY_CLIENT_SECRET` (in an env file with mode 600). Never put that secret in the repository.

### 3.2 The shared proxy and the tunnel

- Add a route for `philo.oberonlogistics.com` that sends traffic to `philo:3000` on the proxy network. Philo needs no
  websocket upgrade, no path rewrite and no subpath. Don't let a write timeout cut long responses: `POST /mcp` streams.
- **`X-Forwarded-For` has to carry the caller's address.** Philo reads it from right to left and stops at the
  rightmost public address. If the shared proxy is Caddy, by default it ignores an incoming `X-Forwarded-For` from an
  untrusted peer and writes only the tunnel connector's private address. Then every caller shares one rate-limit
  budget, and one flood of intake posts throttles every applicant. Trust the tunnel connector for this route (for
  Caddy: `trusted_proxies static private_ranges`), so that the client address that Cloudflare put in the header is
  kept. Check this after cutover (§5.4).
- At Cloudflare, make sure no WAF, bot-fight or challenge rule applies to `/api/intake/*`. A cross-origin `fetch`
  can't solve a challenge, so the website's form would fail. The `OPTIONS` preflight in the health check wouldn't
  catch that, because only the `POST` is challenged. The test lead in §5.4 does catch it.
- Caching: the PWA's `/assets/*` files are immutable, and everything else is `no-cache` or set by Philo. Cloudflare's
  defaults are fine.

## 4. Configuration

### 4.1 Phase 1

Only the two variables in the compose sketch. With the built-in IdP, the issuer is `PHILO_PUBLIC_BASE_URL`, which
doesn't change. Signed-in devices, API keys and connector grants are all in the moved database, and the IdP's signing
key moves with them, so they keep working across the host move.

### 4.2 Phase 2

Each line says which merged branch it depends on. A setting whose branch isn't in the deployed tag either has no
effect or is a startup error, so tag only after all of them are merged.

```sh
# Identity: identity spec §3, adjusted for ADR-0012 (several users, two roles)
PHILO_OIDC_ISSUER=https://auth.oberonlogistics.com
PHILO_OIDC_CLIENT_ID=philo
PHILO_OIDC_AUDIENCE=https://philo.oberonlogistics.com/api,https://philo.oberonlogistics.com/mcp   # up/oidc-audiences
PHILO_OIDC_SCOPE="openid email profile offline_access philo:user philo:admin"                    # up/oidc-sign-in-request
PHILO_OIDC_RESOURCE=https://philo.oberonlogistics.com/api                                         # up/oidc-sign-in-request
PHILO_OIDC_USER_SCOPE=philo:user                                                                  # ADR-0012 implementation
PHILO_OIDC_ADMIN_SCOPE=philo:admin                                                                # ADR-0012 implementation
PHILO_OIDC_AGENT_CLIENT_IDS=*                                                                     # any-agent-client (identity spec U5)

# Chrome: chrome spec §3.3                                                                        # up/pwa-csp, UP-2..UP-4, ol/ chrome
PHILO_WEB_HOST_SCRIPT_URL=/oberon/philo-host.js
PHILO_WEB_HOST_CONFIG='{"notifyUrl":"https://notify.oberonlogistics.com","notifyResource":"<notify resource>"}'
PHILO_WEB_ASSET_ORIGINS=https://auth.oberonlogistics.com
PHILO_WEB_CONNECT_ORIGINS=https://auth.oberonlogistics.com,https://notify.oberonlogistics.com

# Notify: notifications spec §12.3                                                                # ol/ notify module, change-feed seam
OL_NOTIFY_URL=https://notify.oberonlogistics.com
OL_NOTIFY_RESOURCE=<notify resource, exactly as Notify's NOTIFY_RESOURCE holds it>
OL_NOTIFY_CLIENT_ID=<the philo notify service account>
OL_NOTIFY_CLIENT_SECRET=<secret: host override only>
OL_NOTIFY_AS=philo
OL_NOTIFY_ROLE=<role slug>
```

- `PHILO_APP_URL` and `PHILO_MCP_URL` stay unset, because their defaults are the production addresses.
- **OL Auth registration** follows identity spec §5, with ADR-0012's scopes in place of the single `philo:use`. Register
  the scopes `philo:user` and `philo:admin` on the Philo resource, both with `dynamic_clients: true`. Register a role
  that holds `philo:user`, and an admin role that holds both. The `philo` client's scope list carries both scopes.
  The production account (`id=1`) binds by verified email (identity spec §4.1) and becomes an admin through the admin
  scope.
- **DECIDE:** `OL_NOTIFY_ROLE`. Is it the user role (everyone who works leads) or the admin role? Each member must also
  be able to open the Philo tile (notifications spec §12.1).
- **DECIDE:** Notify's resource identifier. Notify's own SPEC still marks `https://notify.oberonlogistics.com` as
  "TODO: confirm".

## 5. Data and cutover

**Who does what.** The human runs every step that reads or writes real data, and binds rehearsal containers to
`127.0.0.1`. Agents never read production or a copy of its data. Agents rehearse this whole runbook only on a
synthetic instance: a fresh stock v0.5.1 with made-up leads, an attachment and a push subscription, run through §5.2
to §5.4 against a scratch volume.

### 5.1 What moves

The whole data directory moves, as one consistent set (DEPLOYMENT.md § What is in the data directory):

| File | Why it matters |
|---|---|
| `philo.db` | Everything: leads, timeline, **attachments** (their bytes are in `lead_attachment_blobs`, not in separate files), users, API keys, push subscriptions, SMTP settings, intake form keys |
| `vapid-keys.json` | Without it, every device loses its push subscription |
| `oidc-signing-key.json` | Keeps built-in IdP sessions alive in phase 1. After phase 2 it has no effect, but keep it for the rollback in §6. |
| `session-key` | Only if present. Unused, so it can be left out. |

The form key in the website's intake URL is a row in `intake_forms`, so it moves with the database. The URL and the
website stay the same.

### 5.2 Dry run against a copy (the human, days before)

1. On the current host, take an online backup (DEPLOYMENT.md § Backup, "a consistent copy while it runs"). Production
   keeps running. Copy the `.db` file and the two key files to the OL apps host over an encrypted channel.
2. Restore them into a **scratch** volume (DEPLOYMENT.md § Restoring the online backup, including the `chown`). Start
   the image you built, on that volume, published on `127.0.0.1:<port>` only, with no proxy route.
3. Run `sqlite3 … 'PRAGMA integrity_check'` (expect `ok`) and compare `SELECT count(*) FROM leads` and
   `FROM lead_attachments` with production. `GET /version`, then sign in through an SSH port forward and open a lead
   that has an attachment.
4. Phase 2 rehearsal: repeat on a scratch copy with the §4.2 settings and the rehearsal client `philo-dev` (identity
   spec §4.3).
5. Write down how long steps 1 and 2 took, because that sets the length of the window. Delete the scratch volume and
   every copy afterwards. They hold applicants' personal data.

### 5.3 Freeze and intake

Running the old and new instances at the same time while DNS changes is **rejected**. Each would have its own SQLite
file, and any lead that reached the old one after the copy would be lost. Use a **short maintenance window**: proposed
at most 15 minutes, at a low-traffic hour, with the old instance **stopped** for the whole window so there is never a
second writer.

While the window is open, a request to the old host gets a 502 from Caddy. The website's form (`public/js/driverleadform.js` in the website repo)
then shows *"Your submission was not received. Try again, or email … or call …"*. No applicant is told a submission
went through when it didn't, but those submissions are not queued anywhere. **DECIDE:** accept that for a window of at
most 15 minutes (recommended), or turn the website's `LEADS_ENABLED` off for the window, which takes two website
deploys and shows "Applications are not open on this page yet" instead.

To keep the DNS part short:

- At least a day before, check how the `philo` record is served. If it is DNS-only with a long TTL, lower the TTL to
  60 s.
- With a remotely managed tunnel, adding the public hostname `philo.oberonlogistics.com` creates the CNAME, but only
  after the old record is deleted. Prepare both edits ahead of time.

### 5.4 Cutover runbook (phase 1)

**Pre-checks** (the day before and again at T-0):

- [ ] The release tag is cut and its image is built on the OL apps host (§2.2). The dry run (§5.2) passed.
- [ ] The proxy route and the `X-Forwarded-For` trust (§3.2) are configured. The tunnel hostname is prepared but not
      yet live.
- [ ] Baseline: the website repository's `scripts/health-check.sh` passes against `https://oberonlogistics.com`. Save the output.
- [ ] Record `SELECT count(*) FROM leads` and the most recent `leads.created_at` on production.
- [ ] Phase 2 only: OL Auth registration is done (§4.2). **The rehearsal client `philo-dev` has been deleted** before
      `PHILO_OIDC_AGENT_CLIENT_IDS=*` goes live, because with `*` any client registered at OL Auth, including one with
      a loopback redirect, is admitted as an agent. The operator's Philo email equals their verified OL Auth email
      (identity spec §4.1).

**The switch** (the human):

1. Stop Philo on the current host: `docker stop philo`. Leave Caddy and the host running. The window opens.
2. Take the final copy with the same online-backup command as the dry run. Nothing writes now, so it is the final
   state. Leave the old volume as it is.
3. Copy the files to the OL apps host. Restore them into the volume `ol-philo-data` **before Philo first starts on it**.
   A first start on an empty volume opens first-boot setup to whoever reaches it.
4. `docker compose … up -d`. Wait until the container reports `healthy`. Check `GET /version` from inside the proxy
   network.
5. Switch DNS: delete the old `philo` record and make the tunnel hostname live.

**Post-checks** (the window closes when all of these pass):

- [ ] `scripts/health-check.sh` passes, including `OK   Philo intake preflight from https://oberonlogistics.com`.
- [ ] A test lead through the real website form shows the success message and appears in Philo, and the notification
      email arrives. Then delete the test lead.
- [ ] Two posts from two different networks are rate-limited separately. The boot log has no "trusted proxy" warning.
- [ ] Sign in. Lead count and latest `created_at` match the pre-check. A lead's attachment opens.
- [ ] The bell, meaning push on a device that was already subscribed. In phase 2, the Notify bell in another OL app
      shows the test lead (notifications spec §12.3).
- [ ] An existing API key works against `/api/v1`.

## 6. Rollback

| Situation | Rollback |
|---|---|
| Phase 2 fails | Take `compose.ol.yaml` off and restart. The built-in IdP comes back with the same account (identity spec §4.4). No data moves. |
| Phase 1 fails during the window | Delete the tunnel hostname, put the old DNS record back, and `docker start philo` on the old host. Nothing was written to the new instance. |
| Phase 1 fails after the window | Stop the new instance (now the old one is the only writer again), switch DNS back, and start the old one. Then **carry over what the new instance received in the meantime**: leads with `created_at` after the cutover, their timeline events and attachments, and stage moves. The human exports them from the new database (or through the API, from a copy) and enters them on the old instance. There is no merge tool. |

- The old instance can open only a database that its own version, v0.5.1, has migrated. A fork tag that adds a
  migration (for example, the ADR-0012 roles) can't be rolled back by swapping the image. After such a tag, the only
  way back is to restore the backup taken before the upgrade, then carry over the new data as in the table. Always
  take a backup before an upgrade (DEPLOYMENT.md § Upgrading).
- Keep the old host's stopped container and volume, unchanged, for the whole soak period (§1).

## 7. Releases

- Tag fork releases on fork `main` as `ol-v<upstream version>-<n>`: `ol-v0.5.1-1` first. `<upstream version>` is the
  root `package.json` `version` at that commit, which only syncs change. `<n>` starts at 1 for each upstream version
  and goes up for every fork release on that version.
- When a sync brings in a new upstream release (for example 0.6.0), the next tag is `ol-v0.6.0-1`. A sync that
  brings in only unreleased upstream commits keeps the version and bumps `<n>`.
- `GET /version` reports the upstream version only, so `ol-v0.5.1-1` and `-2` both say `0.5.1`. To see what is
  running, look at the image tag `ol-philo:<sha>` and `git describe` in the deploy checkout.
- Tag with `git tag -s` if signing is set up, or an annotated `git tag -a` otherwise, and push only the tag. Release
  tags don't trigger any workflow unless option 2B is chosen.
- Upgrading is DEPLOYMENT.md § Upgrading applied to this layout: back up first, check out the new tag, build, set
  `OL_PHILO_IMAGE`, `up -d`. Rolling back without a migration means setting the previous image tag. Rolling back with
  one is covered in §6.

## 8. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Where it runs (§1) | The OL apps host |
| D2 | Soak period and when to retire the old host (§1) | 14 days |
| D3 | Backup destination and retention on the new host (§1) | Same job as the other apps' volumes, off the host, with a retention period you can state |
| D4 | Build locally or pull from GHCR (§2.2) | Build locally, `ol-philo:<sha>` |
| D5 | Intake during the window (§5.3) | At most 15 minutes, at a low-traffic hour; the form shows its fallback |
| D6 | Two phases, or host and identity in one window (§0) | Two phases |
| D7 | `OL_NOTIFY_ROLE`: user role or admin role (§4.2) | Open |
| D8 | Notify's resource identifier (§4.2) | Confirm with Notify's operator |
| D9 | How the shared proxy keeps the caller's address in `X-Forwarded-For` (§3.2) | Configure it for the Philo route; check it in the dry run |
