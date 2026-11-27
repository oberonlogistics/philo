# Cutover runbook: production onto the fork, release 1

The steps for switching `https://philo.oberonlogistics.com` from the stock upstream image to the fork's
`ol-v0.6.0-1`. It is written for an agent running production on the maintainer's behalf. Read all of it before
the first command. The reasons behind the steps are in [`DEPLOY.md`](DEPLOY.md); this page is the steps.

## 0. What this release changes

| | Before | After release 1 |
|---|---|---|
| Image | `ghcr.io/philo-crm/philo:0.5.1` (stock) | `ghcr.io/oberonlogistics/philo:ol-v0.6.0-1@sha256:<digest>` |
| Sign-in | Philo's built-in IdP (password) | OL Auth, for the one existing account (`id=1`), which binds by verified email |
| Notifications | Email and web push | The same, **plus** each new lead, added lead and stage move in the OL Notify feed for the Philo users role |
| Data | The production volume | **The same volume**, migrated in place by `0013_user_roles` (adds `role`, `role_confirmed_at`, `disabled_at` to `users`) |

**Not in release 1.** These come later as ordinary upgrades (`ol-v0.6.0-2` or a later version: DEPLOY.md §7), with no
new window:

- the shared chrome (app switcher, account menu, bell in Philo's top bar), which waits on the host-script seam
  (`up/web-host-script`);
- several people signing in, with roles from OL Auth scopes (`up/oidc-multi-user`). Until then, only the account that
  binds can sign in, and a second OL Auth person is refused;
- MCP agents signing in through OL Auth with self-registered clients (`PHILO_OIDC_AGENT_CLIENT_IDS=*`, identity spec
  U5). Until then, agents use **API keys**. OAuth tokens from the built-in IdP stop working at the cutover.

This splits DEPLOY.md's single window (D6) into this release and a later env-and-image upgrade. The maintainer asked
for it on 2026-11-26, so production moves now instead of waiting for the remaining upstream PRs.

## 1. Rules

- **Gates.** Stop and ask the maintainer at each **GATE**. Don't go past one without an explicit yes.
- **Stop on any surprise.** That means an unexpected output, a check that doesn't match, a name you didn't expect, or
  a step this page doesn't cover. Stop, write down what you saw, and ask. Don't improvise on production.
- **Secrets and data.** Never print, paste or commit `OL_NOTIFY_CLIENT_SECRET`, the host's env files, the database or
  any lead content. That covers chat, PRs, issues, the log and hosted tools. Counts and timestamps are fine.
- **One writer.** Never let two Philo processes open the production volume at once, and never run `sqlite3` writes
  while Philo runs on it.
- **Type every name.** Container and volume names come from §3's record. Before any `stop`, `rm`, `rename` or
  restore, check the name against that record.
- **Keep a log** on the host, at `~/philo-cutover-<date>/log.md`: each command, its time and its outcome, with no
  secrets. It becomes the record in §9.

## 2. Prerequisites (GATE 1: the maintainer confirms each)

- [ ] **OL Auth registration** is done, per [`docs/identity.md`](docs/identity.md) §5:
  - the Philo resource with `https://philo.oberonlogistics.com/api` and `/mcp`;
  - the scopes `philo:user` and `philo:admin`;
  - the roles `philo-users` and `philo-admins`, with the maintainer in both;
  - the public first-party client `philo`, with redirect `https://philo.oberonlogistics.com/auth/callback` and
    post-logout redirect `https://philo.oberonlogistics.com/`;
  - the tile.

  The rehearsal client `philo-dev` isn't needed for this release, so don't create it.
- [ ] **The maintainer's Philo account email equals their verified OL Auth email.** That match is what binds `id=1`.
  If it differs, the first sign-in is refused, and §6 step 8 rolls back to R1.
- [ ] **The Notify service account** exists, per [`docs/notifications.md`](docs/notifications.md) §12: a confidential
  client with `client_credentials`, the `notify:post` scope and audience `https://notify.oberonlogistics.com`, plus
  the post-as entry that lets it post as `philo`. Its client id and secret are on the production host in a mode-600
  file the maintainer names. The secret never passes through chat.
- [ ] **Backups (DEPLOY.md D3).** Either decided, or the maintainer names where the pre-cutover backup in §6 is copied
  off the host.
- [ ] **Access.** A shell on the production host with Docker, and a checkout of `oberonlogistics-web` for
  `scripts/health-check.sh`.
- [ ] **The window.** A low-traffic hour, and the maintainer is available to sign in once during it (OL Auth uses
  passkeys, so an agent can't sign in).

## 3. Record what runs today (read-only)

On the production host, without changing anything:

```sh
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker inspect <philo container> > ~/philo-cutover-<date>/inspect-before.json   # stays on the host: it holds env values
```

Write these to the log, with env **names** only and no values:

- the container name, the image, and its digest (`.Image` and `docker image inspect --format '{{index .RepoDigests 0}}'`);
- the full launch: env names, mounts, ports, restart policy, network, and whether it is a Compose project (the
  `com.docker.compose.*` labels);
- the data volume name and the files on it: `philo.db`, `vapid-keys.json`, `oidc-signing-key.json`;
- Caddy's site block for `philo.oberonlogistics.com` and the upstream address it proxies to;
- any existing backup job.

Stop if the image is anything other than stock `0.5.1`, if there is more than one Philo container, or if the port is
published on anything but loopback or a private network.

Then take the baseline: run `scripts/health-check.sh` from `oberonlogistics-web` and save its output. It must pass.

## 4. Cut and check the release

**GATE 2: the maintainer approves pushing the tag.**

From a checkout of fork `main`, at the v0.6.0 sync (#15) or later:

```sh
git fetch origin
git diff --name-only v0.5.1 origin/main -- 'packages/server/drizzle/*.sql'   # expect exactly 0013_user_roles.sql
grep '"version"' package.json                                                # expect 0.6.0
git tag -a ol-v0.6.0-1 -m "ol-v0.6.0-1" origin/main
git push origin ol-v0.6.0-1        # this one tag only; never --tags
```

If the diff lists anything but `0013_user_roles.sql`, stop: §7's R2 covers only that migration.

The **Oberon release image** workflow (`ol-release.yml`) runs on the tag. When it passes, copy the
`ghcr.io/oberonlogistics/philo:ol-v0.6.0-1@sha256:…` line from its job summary into the log. That reference, with its
digest, is the only image production may run. Never use `:latest`, `:edge` or a semver tag from this package.

On the production host, check the image without the data volume:

```sh
IMG='ghcr.io/oberonlogistics/philo:ol-v0.6.0-1@sha256:<digest>'
docker pull "$IMG"
docker run -d --rm --name philo-imgcheck -p 127.0.0.1:<free port>:3000 "$IMG"
curl -s http://127.0.0.1:<free port>/version                                          # name philo, version 0.6.0
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<free port>/oberon/philo-host.js   # 200
curl -sI http://127.0.0.1:<free port>/ | grep -i content-security-policy              # present
docker stop philo-imgcheck
```

## 5. Prepare and test the environment

Write `/<deploy dir>/philo-ol.env` on the host, with mode 600 and owned by the deploy user. It is **added** to
today's environment: keep every variable today's launch has, especially `PHILO_PUBLIC_BASE_URL` and
`PHILO_TRUSTED_PROXY`.

```sh
# Identity: OL Auth (identity spec §3)
PHILO_OIDC_ISSUER=https://auth.oberonlogistics.com
PHILO_OIDC_CLIENT_ID=philo
PHILO_OIDC_AUDIENCE=https://philo.oberonlogistics.com/api,https://philo.oberonlogistics.com/mcp
PHILO_OIDC_SCOPE=openid email profile offline_access philo:user philo:admin
PHILO_OIDC_RESOURCE=https://philo.oberonlogistics.com/api

# Notify (notifications spec §12.3)
OL_NOTIFY_URL=https://notify.oberonlogistics.com
OL_NOTIFY_RESOURCE=https://notify.oberonlogistics.com
OL_NOTIFY_CLIENT_ID=<the service account's client id>
OL_NOTIFY_CLIENT_SECRET=<from the maintainer's file; never echoed>
OL_NOTIFY_AS=philo
OL_NOTIFY_ROLE=philo-users
```

`docker --env-file` takes values literally, so don't quote them.

**Leave unset in release 1:**

- `PHILO_OIDC_USER_SCOPE`, `PHILO_OIDC_ADMIN_SCOPE` and `PHILO_WEB_HOST_*`: this release doesn't read them.
- `PHILO_OIDC_AGENT_CLIENT_IDS`: this release would take `*` as a literal client id, not as "any client".
- `PHILO_WEB_CONNECT_ORIGINS`: OL Auth's token endpoint is on its issuer's origin, which the CSP already allows.
- `PHILO_APP_URL` and `PHILO_MCP_URL`: their defaults come from `PHILO_PUBLIC_BASE_URL`.

**Test the file on a throwaway container** with its own empty data directory. It has no route from Caddy, and no
leads exist for it to post:

```sh
docker run -d --rm --name philo-envcheck -p 127.0.0.1:<free port>:3000 \
  --env-file <today's env, if it has one> --env-file /<deploy dir>/philo-ol.env \
  -e PHILO_DATA_DIR=/tmp/envcheck "$IMG"
docker logs philo-envcheck 2>&1 | head -40
docker stop philo-envcheck
```

The log must show these lines:

- `identity:        external IdP https://auth.oberonlogistics.com (operator client philo)`;
- the `oberon notify: posting lead events as philo to https://notify.oberonlogistics.com, for role philo-users…`
  line, with no "half configured" error;
- after a few seconds, no Notify setup error (a 401, a 403, or `unknown_app` / `unknown_role`). If one appears, the
  OL Auth or Notify registration is incomplete: stop and tell the maintainer.

## 6. Rehearse on a copy

Do every rehearsal step on a neutralized copy, as DEPLOY.md §4.3 describes:

- a scratch volume `philo-scratch` and a container of the same name, on loopback only;
- an online backup of production copied in;
- before the first start, `email.%` settings, `push_subscriptions` and `webhooks` deleted;
- `vapid-keys.json` not copied;
- every `OL_NOTIFY_*` variable unset;
- `PHILO_PUBLIC_BASE_URL=http://localhost:<port>`.

With the OIDC variables from §5, check:

1. `PRAGMA integrity_check` is `ok` before and after the boot.
2. The boot log shows the migration applied, and `SELECT id, role FROM users` gives `1|admin` (one row).
3. `GET /api/v1/auth/config` names the OL Auth issuer and the `philo` client.
4. **R1 works:** restart the copy without the OIDC variables. The built-in IdP is back, and `/api/v1/auth/config` says
   so.
5. **R2's reversal works**, on the copy, with the container stopped:
   ```sql
   ALTER TABLE users DROP COLUMN disabled_at;
   ALTER TABLE users DROP COLUMN role_confirmed_at;
   ALTER TABLE users DROP COLUMN role;
   DELETE FROM __drizzle_migrations WHERE id = (SELECT max(id) FROM __drizzle_migrations);
   ```
   Check first that the last row is 0013: `SELECT count(*) FROM __drizzle_migrations` equals the number of `.sql`
   files under `packages/server/drizzle/` at the tag. Then start the **stock** `0.5.1` image (by digest) on the copy:
   it boots, `integrity_check` is `ok`, and a lead opens through `/api/v1` with an API key you create on the copy.
6. Write down how long each step took.

Afterwards delete the scratch container, the volume and the backup file. They hold applicants' personal data.

## 7. The window (GATE 3: the maintainer says "go")

Intake is down from step 1 until step 5. The website's form shows its fallback message, and nothing is queued.

1. `date +%s%3N`: write this down as **T0**. Then `docker stop <philo container>`.
2. Make the **pre-cutover backup** with the online form from DEPLOYMENT.md § Backup, into
   `philo-precutover-ol-v0.6.0-1.db` plus `vapid-keys.json` and `oidc-signing-key.json`. Then:
   - Run `PRAGMA integrity_check` on it (expect `ok`).
   - Record `SELECT count(*), max(created_at) FROM leads` (`sqlite3 -readonly` in a helper container; the Philo image
     has no `sqlite3`).
   - Copy the three files to the off-host destination from §2 and check the copy's checksum. **Don't go on until the
     copy is verified.**
3. `docker rename <philo container> <philo container>-stock`: keep it, stopped, for R2.
4. Start the new container under the **original name** with today's launch exactly as recorded in §3. Change only
   two things:
   - the image is `$IMG`;
   - `--env-file /<deploy dir>/philo-ol.env` is added.

   Same volume, same ports, same restart policy, same network. If today's launch is Compose, edit the image and
   `env_file` in its file, back up the original first, and `docker compose up -d`. Wait for `healthy`.
5. Check the boot log:
   - the migration applied;
   - `identity:        external IdP …`;
   - `rate limits:     per caller, from X-Forwarded-For (PHILO_TRUSTED_PROXY=true)`;
   - the `oberon notify: posting lead events…` line, with no Notify error.

   Intake is open again.
6. `scripts/health-check.sh` passes, including `OK   Philo intake preflight from https://oberonlogistics.com`.
7. Check the leads: `SELECT count(*), max(created_at) FROM leads WHERE created_at <= <T0>` (read-only) matches step 2.
8. **The maintainer signs in** at `https://philo.oberonlogistics.com` through OL Auth, and confirms they see their
   leads and that a lead's attachment opens. If sign-in is refused (an email mismatch, a client or redirect error),
   go to R1 straight away.
9. The maintainer checks that an existing API key works against `/api/v1`, for example
   `curl -H "Authorization: Bearer <key>" https://philo.oberonlogistics.com/api/v1/funnels`.
10. **One test lead**, with the maintainer's OK: submit it through the real website form. It must:
    - show the success message;
    - appear in Philo;
    - send the new-lead email;
    - show in the OL Notify bell of another OL app (the maintainer checks), and be logged as posted with no error in
      `docker logs`.

    Then delete it in Philo.

The window closes when all ten pass. Record the time.

## 8. Rollback

Leads arrive again from step 5 on, so a rollback must keep them.

**R1: environment only (identity or Notify trouble; the image itself works).** Remove
`--env-file /<deploy dir>/philo-ol.env` and recreate the container with the same image, on the same volume. The
built-in IdP comes back with the same account, password and signing key. The migration stays applied, and this image
understands it. Nothing is restored, so nothing is lost. Check with step 6 and a password sign-in by the maintainer.

**R2: back to stock (only if the fork image itself fails).**

1. Stop the new container.
2. Make an online backup of the **new** database to `philo-postcutover-ol-v0.6.0-1.db`, and keep it.
3. If `SELECT count(*) FROM users` is 1, apply §6 step 5's reversal (rehearsed). Otherwise, stop and ask: the
   maintainer decides between revoking the other accounts' credentials and restoring with carry-over (DEPLOY.md §6).
4. `docker rm` the new container, `docker rename <philo container>-stock <philo container>`, and `docker start` it.
5. Run step 6 and one test lead again.

## 9. Afterwards

- Keep both named backups until the next release has run cleanly. Delete them under the D3 retention.
- Delete the `-stock` container once the maintainer agrees release 1 is staying.
- Open a fork PR (branch `ol/after-cutover-1`, from `origin/main`) that updates:
  - DEPLOY.md §0's "Today" column: the image reference with its digest, OL Auth for one account, and the Notify feed
    on;
  - DEPLOY.md D3 and D10, with what was used;
  - the integration tracker (fork issue #3).

  Include no secrets, no env values beyond those on this page, and no lead data.
- The next release adds the chrome, several people and MCP agents through OL Auth. It goes through DEPLOY.md §7, plus
  that release's own env additions and its own rehearsal.
