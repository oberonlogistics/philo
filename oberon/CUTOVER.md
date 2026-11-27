# Cutover runbook: production onto the fork, release 1

The steps for switching `https://philo.oberonlogistics.com` from the stock upstream image to the fork's
`ol-v0.6.0-1`. It is written for an agent running production on the maintainer's behalf, under the waiver in §1.
Read all of it before the first command. The reasons behind the steps are in [`DEPLOY.md`](DEPLOY.md); this page is
the steps.

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
  U5). Until then, agents use **API keys**. Connectors holding built-in OAuth tokens keep working **for up to an
  hour** after the cutover, because built-in access tokens still resolve in external mode
  (`packages/server/src/auth/middleware.ts:65-71`), and then get 401. Their refresh tokens stay in the database and
  work again only under R1. Release 1 doesn't run identity spec §4.4's optional token `DELETE`.

This splits DEPLOY.md's single window (D6) into this release and a later env-and-image upgrade. The maintainer asked
for it on 2026-11-26, so production moves now instead of waiting for the remaining upstream PRs.

## 1. Rules

**Maintainer waiver, 2026-11-26.** For release 1 only, the maintainer waives the rule that agents never touch
production or a copy of its data (DEPLOY.md §1 and §4.3, identity spec §4.3). The agent running this page does all of
it: the real-copy rehearsal (§6), the window (§7) and both rollbacks (§8), and it stops at every gate. The maintainer
still decides each gate and does the one OL Auth sign-in. OL Auth and Notify registration stay with the maintainer.
The waiver ends when release 1's window closes or is rolled back. Later releases go back to DEPLOY.md's HUMAN marks
unless the maintainer waives them again, with a date.

- **Gates.** Stop and ask the maintainer at each **GATE**. Don't go past one without an explicit yes.
- **Stop on any surprise.** That means an unexpected output, a check that doesn't match, a name you didn't expect, or
  a step this page doesn't cover. Stop, write down what you saw, and ask. Don't improvise on production.
- **Data rules**, for production's database and any copy of it:
  - Run only counts (`count(*)`), `max()` of timestamp columns, PRAGMAs, and schema queries (`sqlite_master`,
    `pragma_table_info`), plus the writes this page spells out.
  - Never `SELECT` lead, event, attachment or user rows, nor rows of `api_keys`, `sessions` or the token tables. No
    `SELECT *`, no `.dump`, no `.schema` piped through anything that prints rows.
  - Never paste a database error that quotes row content. Write "an error quoting row content, at step N" in the log,
    and stop.
  - Read production's container logs only through a `grep` for the lines this page names.
  - Delete the copy straight after the rehearsal (§6, last step).
- **Secrets.** Never print, paste or commit `OL_NOTIFY_CLIENT_SECRET`, the host's env files or their values. That
  covers chat, PRs, issues, the log and hosted tools.
  - Read the secret only inside a subshell, as `"$(cat "$SECRET_FILE")"`, into a file or a pipe. Never `cat` it on
    its own, never put it in a command's arguments, and never `echo` it.
  - Once a container has `philo-ol.env`, its config holds the secret. Run `docker inspect` on it only with
    `--format` on a field other than `.Config.Env`, or redirected to a mode-600 file. Never run `docker compose
    config`, or `env` / `printenv` inside it.
- **One writer.** Never let two Philo processes open the production volume at once, and never run `sqlite3` writes
  while Philo runs on it.
- **Type every name.** Container and volume names come from §3's record. Before any `stop`, `rm`, `rename` or
  restore, check the name against that record.
- **Keep a log** on the host, at `~/philo-cutover-<date>/log.md`: each command, its time and its outcome, with no
  secrets and no row content. It becomes the record in §9. Everything in that directory is created under
  `umask 077`.

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
  If it differs, the first sign-in is refused, and §7 step 8 rolls back to R1.
- [ ] **The Notify service account** exists, per [`docs/notifications.md`](docs/notifications.md) §12: a confidential
  client with `client_credentials`, the `notify:post` scope and audience `https://notify.oberonlogistics.com`, plus
  the post-as entry that lets it post as `philo`. The maintainer gives its client id (not a secret) and names a
  mode-600 file on the production host that holds **only the secret**, on one line. The secret never passes through
  chat. The maintainer also confirms that Notify's `NOTIFY_RESOURCE` holds exactly
  `https://notify.oberonlogistics.com` (D8; notifications spec §12).
- [ ] **Backups (DEPLOY.md D3).** Either decided, or the maintainer names where the pre-cutover backup in §7 is copied
  off the host, and with what tool.
- [ ] **Access.** A shell on the production host with Docker, and a checkout of `oberonlogistics-web` for
  `scripts/health-check.sh`.
- [ ] **The window.** A low-traffic hour, and the maintainer is available to sign in once during it (OL Auth uses
  passkeys, so an agent can't sign in).
- [ ] **The maintainer accepts that the first OL Auth sign-in is untested before the window.** The rehearsal copy has
  no registered redirect, so the bind of `id=1` (the email match, the first real OL Auth token, its audience and
  resource, userinfo) runs for the first time at §7 step 8. DEPLOY.md §6 R1 asks the rehearsal to confirm a password
  sign-in for the bound account; release 1 replaces that with a simulated bind (§6 step 5) and this code reading:
  - `external_subject` is declared at `packages/server/src/db/schema.ts:213` and read only in
    `packages/server/src/auth/external-idp.ts:240-262`;
  - built-in sign-in (`auth/credentials.ts`, `oauth/routes.ts`) never reads it;
  - the bind sets only `externalSubject` and leaves `password_hash` alone (`external-idp.ts:259-263`).

  So under R1 the bound account signs in with its password as before. If the bind fails in the window, the fix is R1.

## 3. Record what runs today (read-only)

On the production host, without changing anything:

```sh
umask 077
mkdir -p ~/philo-cutover-<date>
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker inspect <philo container> > ~/philo-cutover-<date>/inspect-before.json   # stays on the host: it holds env values
docker image inspect --format '{{index .RepoDigests 0}}' "$(docker inspect --format '{{.Image}}' <philo container>)"
docker run --rm -v <data volume>:/data:ro alpine ls -la /data
docker logs <philo container> 2>&1 | grep -E '^  (identity|rate limits|note: rate limits)'   # the baseline boot lines
```

Write these to the log, with env **names** only and no values:

- the container name, the image, and its digest (the stock rollback image is `ghcr.io/philo-crm/philo:0.5.1@sha256:<that
  digest>`);
- the full launch: env names, whether they come from `-e` or an env file (and which), mounts, ports, restart policy
  (`--format '{{.HostConfig.RestartPolicy.Name}}'`), network, and whether it is a Compose project (the
  `com.docker.compose.*` labels; if so, the compose file's path and project name);
- the data volume name and the files on it: `philo.db`, `vapid-keys.json`, `oidc-signing-key.json`;
- Caddy's site block for `philo.oberonlogistics.com` and the upstream address it proxies to;
- the baseline boot lines (if the log has rotated past them, write "not in the log");
- any existing backup job.

Stop if:

- the image is anything other than stock `0.5.1`;
- there is more than one Philo container;
- the port is published on anything but loopback or a private network;
- Caddy proxies to a **container IP** rather than a loopback port or a container name: the new container gets a new
  IP, and Caddy would return 502.

Then take the baseline: run `scripts/health-check.sh` from `oberonlogistics-web` and save its output. It must pass.

## 4. Cut and check the release

**GATE 2: the maintainer approves pushing the tag.**

From a checkout of fork `main`, at the v0.6.0 sync (#15) or later:

```sh
git fetch origin
git fetch https://github.com/philo-crm/philo.git refs/tags/v0.5.1:refs/tags/v0.5.1 --no-tags   # the fork has no v* tags
git rev-parse 'v0.5.1^{commit}'                                              # must resolve
git diff --name-only v0.5.1 origin/main -- 'packages/server/drizzle/*.sql'   # expect exactly 0013_user_roles.sql
git ls-tree --name-only origin/main packages/server/drizzle/ | grep -c '\.sql$'   # expect 14
git show origin/main:package.json | grep '"version"'                         # expect 0.6.0
git tag -a ol-v0.6.0-1 -m "ol-v0.6.0-1" origin/main
git push origin ol-v0.6.0-1        # this one tag only; never --tags
```

If the diff lists anything but `0013_user_roles.sql`, stop: §8's R2 covers only that migration. Never push the
fetched `v0.5.1` tag.

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

`philo-ol.env` is **added** to today's environment: keep every variable today's launch has, especially
`PHILO_PUBLIC_BASE_URL` and `PHILO_TRUSTED_PROXY`. Write its non-secret part as `/<deploy dir>/philo-ol.env.public`:

```sh
# Identity: OL Auth, identity spec §3's release-1 subset
PHILO_OIDC_ISSUER=https://auth.oberonlogistics.com
PHILO_OIDC_CLIENT_ID=philo
PHILO_OIDC_AUDIENCE=https://philo.oberonlogistics.com/api,https://philo.oberonlogistics.com/mcp
PHILO_OIDC_SCOPE=openid email profile offline_access philo:user philo:admin
PHILO_OIDC_RESOURCE=https://philo.oberonlogistics.com/api

# Notify (notifications spec §12.3)
OL_NOTIFY_URL=https://notify.oberonlogistics.com
OL_NOTIFY_RESOURCE=https://notify.oberonlogistics.com
OL_NOTIFY_CLIENT_ID=<the service account's client id>
OL_NOTIFY_AS=philo
OL_NOTIFY_ROLE=philo-users
```

`docker --env-file` takes values literally, so don't quote them, and put no comment after a value (only whole-line
`#` comments). `OL_NOTIFY_RESOURCE` must equal the value Notify's
`NOTIFY_RESOURCE` holds (§2). Then add the secret without printing it:

```sh
SECRET_FILE=<the maintainer's file>
( umask 077
  { cat /<deploy dir>/philo-ol.env.public; printf 'OL_NOTIFY_CLIENT_SECRET=%s\n' "$(cat "$SECRET_FILE")"; } \
    > /<deploy dir>/philo-ol.env )
stat -c '%a %U' /<deploy dir>/philo-ol.env                       # 600 <deploy user>
grep -c '^OL_NOTIFY_CLIENT_SECRET=.' /<deploy dir>/philo-ol.env   # 1
```

**Leave unset in release 1:**

- `PHILO_OIDC_USER_SCOPE`, `PHILO_OIDC_ADMIN_SCOPE`, `PHILO_OIDC_AGENT_SCOPE` and `PHILO_WEB_HOST_*`: this release
  doesn't read them (identity spec §3, release 1).
- `PHILO_OIDC_AGENT_CLIENT_IDS`: this release would take `*` as a literal client id, not as "any client".
- `PHILO_WEB_CONNECT_ORIGINS`: OL Auth's token endpoint is on its issuer's origin, which the CSP already allows.
- `PHILO_APP_URL` and `PHILO_MCP_URL`: their defaults come from `PHILO_PUBLIC_BASE_URL`.
- `OL_NOTIFY_ISSUER`: it defaults to `PHILO_OIDC_ISSUER`.

**Check the Notify credentials** with the same token request Philo makes (`apps/standalone/src/oberon/notify.ts`,
`TokenSource`): Basic auth, `grant_type=client_credentials`, `scope=notify:post`, `audience=` the Notify resource. The
token endpoint comes from OL Auth's discovery document:

```sh
TOKEN_URL=$(curl -s https://auth.oberonlogistics.com/.well-known/openid-configuration |
  grep -o '"token_endpoint" *: *"[^"]*"' | cut -d'"' -f4)
echo "$TOKEN_URL"      # must be https://auth.oberonlogistics.com/…: Philo sends the secret nowhere else
( printf 'user = "%s:%s"\n' '<the service account client id>' "$(cat "$SECRET_FILE")" |
  curl -s -o /dev/null -w '%{http_code}\n' -K - \
    -d grant_type=client_credentials -d scope=notify:post \
    -d audience=https://notify.oberonlogistics.com "$TOKEN_URL" )
```

Expect `200`. `printf` is a shell builtin, so the secret never reaches a process's arguments, and `-o /dev/null`
discards the token. A `400` or `401` means the client, its secret or its grant is wrong: stop and tell the
maintainer. If the secret holds a `"` or a `\`, curl's config syntax needs them escaped: stop and ask rather than
work around it. Philo form-encodes the id and secret inside Basic auth (`notify.ts`, `formEncode`) and curl doesn't, so
the two requests are the same only when both are made of letters, digits and `-_.!~*'()`. If not, a `200` here
doesn't prove Philo's request. This
proves the token only. A missing post-as entry (403 `post_as_forbidden`) or a missing tile or
role (`unknown_app`, `unknown_role`) shows up only on a real post, at §7 step 10.

**Test the file on a throwaway container** with its own empty data directory. It has no route from Caddy, and no
leads exist for it to post. It needs today's env, names and values, from §3's record:

- if today's launch uses an env file, pass that file;
- if it passes env with `-e`, rebuild it into a mode-600 file first:
  `( umask 077; docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <philo container> > ~/philo-cutover-<date>/today.env )`.

Without `PHILO_PUBLIC_BASE_URL`, the app URL defaults to `http://localhost:3000`, and under `NODE_ENV=production` the
Notify config refuses it ("invalid PHILO_APP_URL", `notify-config.ts:97`), so the check would fail for the wrong
reason.

```sh
docker run -d --rm --name philo-envcheck -p 127.0.0.1:<free port>:3000 \
  --env-file <today's env file> --env-file /<deploy dir>/philo-ol.env \
  -e PHILO_DATA_DIR=/tmp/envcheck "$IMG"
until [ "$(docker inspect --format '{{.State.Health.Status}}' philo-envcheck)" = healthy ]; do sleep 2; done
docker logs philo-envcheck 2>&1 | head -40
docker stop philo-envcheck
```

If it exits instead of turning healthy, read the error in `docker logs philo-envcheck` (a config error names the
variable, not its value) and stop. The log must show these lines:

- `identity:        external IdP https://auth.oberonlogistics.com (operator client philo)`;
- the `oberon notify: posting lead events as philo to https://notify.oberonlogistics.com, for role philo-users,
  linking to https://philo.oberonlogistics.com` line, with no "half configured" error.

## 6. Rehearse on a copy

The agent does this under the §1 waiver, with the data rules in force throughout. It follows DEPLOY.md §4.3 (the
commands for the scratch volume and the neutralising `DELETE`s are there), except for sign-in:

- a scratch volume `philo-scratch` and a container of the same name, on loopback only;
- an online backup of production copied in (DEPLOYMENT.md § Backup, online form), into `~/philo-cutover-<date>/rehearsal/`;
- before the first start, `email.%` settings, `push_subscriptions` and `webhooks` deleted;
- `vapid-keys.json` not copied;
- every `OL_NOTIFY_*` variable unset: the copy gets today's env plus only the identity block of
  `philo-ol.env.public`, never `philo-ol.env`;
- `PHILO_PUBLIC_BASE_URL=http://localhost:<port>`;
- no OL Auth sign-in, and no password sign-in (§2, last item).

Run every `sqlite3` below with the container stopped, in the alpine helper on the scratch volume. Check:

1. **Before the first boot:** `PRAGMA integrity_check` is `ok`; `SELECT count(*) FROM users` is 1;
   `SELECT count(*), max(created_at) FROM __drizzle_migrations` is `13|1792992174385`; record
   `SELECT count(*), max(created_at) FROM leads` as **L0**.
2. **Boot with the identity variables.** Wait for `healthy`. The boot log shows
   `identity:        external IdP https://auth.oberonlogistics.com (operator client philo)`, and the rate-limit line
   matches §3's baseline. Drizzle logs nothing when it migrates, so check the migration by query, after stopping:
   - `SELECT count(*), max(created_at) FROM __drizzle_migrations` is `14|1795723669355` (0013's `when` in
     `packages/server/drizzle/meta/_journal.json`);
   - `SELECT count(*) FROM pragma_table_info('users') WHERE name IN ('role','role_confirmed_at','disabled_at')` is 3;
   - `SELECT count(*) FROM users WHERE role = 'admin'` is 1;
   - `PRAGMA integrity_check` is `ok`.
3. `curl -s http://127.0.0.1:<port>/api/v1/auth/config` names issuer `https://auth.oberonlogistics.com` and client
   `philo`.
4. **Time the backup.** Write down how long step 1's online backup took on this real-size file.
5. **R1 works for a bound account.** Simulate the bind, with the container stopped:
   ```sh
   docker run --rm -v philo-scratch:/data alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -bail /data/philo.db "
     UPDATE users SET external_subject = '\''https://auth.oberonlogistics.com rehearsal'\'' WHERE id = 1;
     SELECT changes();" && chown -R 1000:1000 /data'     # expect 1
   ```
   Restart the copy **without** the identity variables. It turns `healthy`, the boot log shows
   `identity:        built-in IdP at http://localhost:<port>/oauth`, and `/api/v1/auth/config` names that issuer and
   the client `philo-web`.
6. **R2's reversal works**, on the copy, with the container stopped. First check that the last applied migration is
   0013: `SELECT count(*), max(created_at) FROM __drizzle_migrations` is `14|1795723669355`. Then:
   ```sh
   docker run --rm -v philo-scratch:/data alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -bail /data/philo.db "
     BEGIN;
     ALTER TABLE users DROP COLUMN disabled_at;
     ALTER TABLE users DROP COLUMN role_confirmed_at;
     ALTER TABLE users DROP COLUMN role;
     DELETE FROM __drizzle_migrations WHERE created_at = 1795723669355;
     COMMIT;" && chown -R 1000:1000 /data'
   ```
   `-bail` stops at the first error, before `COMMIT`, so a failure leaves nothing half applied. Afterwards
   `__drizzle_migrations` is `13|1792992174385` and the three columns are gone (the `pragma_table_info` count is 0).
   A leftover root-owned `-wal` or `-shm` would make the database read-only for `node`, hence the `chown`.
7. **Stock boots on it.** Start the **stock** `0.5.1` image, by the digest from §3, on the copy, with the same env as
   step 5. It turns `healthy`, and:
   - `curl -s http://127.0.0.1:<port>/version` answers `0.5.1`;
   - a POST to the copy's intake URL (from its boot log's `intake form:` line, with `localhost:<port>`) returns `201`:
     `curl -s -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' -d '{"name":"Rehearsal","email":"rehearsal@example.com"}' <intake URL>`;
   - after stopping it, `PRAGMA integrity_check` is `ok` and `SELECT count(*) FROM leads` is L0's count plus one.
8. **If production runs under Compose**, rehearse §8 R2's Compose path too: a copy of the compose file with the
   project name, container name, volume and port changed to the scratch ones, brought up on the fork image and then
   back on `compose.yaml.stock`.
9. Write down how long each step took.
10. **Delete the copy straight away**, before anything else: `docker rm` the `philo-scratch` container if it
    remains, `docker volume rm philo-scratch`, and `rm -r ~/philo-cutover-<date>/rehearsal`. Check that
    `docker volume ls -q | grep -c philo-scratch` is 0. They hold applicants' personal data.

## 7. The window

**About 30 minutes before, after GATE 1 and the rehearsal:**

- Take an online backup of production and copy it off the host with the §2 tool, timing both. If the tool sends
  only changes (`rsync`), step 2 then copies only what changed since. Keep this copy until §9.
- Add the step 2 backup time from §6 to this copy time. **If the two exceed 8 minutes**, tell the maintainer at
  GATE 3: the window is 15 minutes (D5), and steps 3 to 5 need the rest.

**GATE 3: the maintainer says "go".**

Intake is down from step 1 until step 5, and the window has a **15-minute budget** (DEPLOY.md D5). The website's form
shows its fallback message, and nothing is queued.

There is **no intake hold in Caddy** this time (DEPLOY.md §5 step 3). The hold kept intake closed while the operator
confirmed their role: with roles from IdP scopes, an account needs a role confirmed in the last 30 days. Release 1
boots with roles on the accounts (`packages/server/src/boot.ts:54`), so `hasAccess` ignores `role_confirmed_at`
(`packages/server/src/auth/access.ts:58`), and nothing has to happen before leads flow again. Intake reopens as soon
as the new container is healthy, and Caddy isn't touched.

1. `docker stop <philo container>`. Then `date +%s%3N`: write this down as **T0** (after the stop, so no lead lands
   between T0 and the backup).
2. Make the **pre-cutover backup** with the online form from DEPLOYMENT.md § Backup, into
   `philo-precutover-ol-v0.6.0-1.db` plus `vapid-keys.json` and `oidc-signing-key.json`. Then:
   - Run `PRAGMA integrity_check` on it (expect `ok`).
   - Record `SELECT count(*), max(created_at) FROM leads` (`sqlite3 -readonly` in a helper container; the Philo image
     has no `sqlite3`).
   - Copy the three files to the off-host destination from §2 and check the copy's checksum. **Don't go on until the
     copy is verified.**

   **Abort:** production is untouched until step 3. If anything in steps 1–2 fails, or step 2 isn't done by
   **T0 + 10 minutes**, run `docker start <philo container>`, wait for `healthy`, run `scripts/health-check.sh`, and
   stop. Tell the maintainer.
3. Set the stock container aside for R2:
   - **`docker run` launch:** `docker rename <philo container> <philo container>-stock`, then
     `docker update --restart=no <philo container>-stock`, so a daemon restart or a reboot can't bring it back as a
     second writer.
   - **Compose launch:** don't rename (Compose finds its container by label, and `up -d` would recreate the renamed
     one and remove it). Copy the compose file to `compose.yaml.stock` next to it, and check that the stock image
     from §3 is still present (`docker image inspect <stock image@digest>`). Run no `docker image prune` until §9.
4. Start the new container under the **original name** with today's launch exactly as recorded in §3. Change only
   two things:
   - the image is `$IMG`;
   - `--env-file /<deploy dir>/philo-ol.env` is added.

   Same volume, same ports, same restart policy, same network. Under Compose, edit only the image and add
   `philo-ol.env` to `env_file` in the compose file, then `docker compose up -d`. Wait for `healthy`.
5. Check the boot log (`docker logs <philo container> 2>&1 | grep -E '^  (identity|rate limits|note: rate limits)|oberon notify'`):
   - `identity:        external IdP https://auth.oberonlogistics.com (operator client philo)`;
   - the rate-limit line is the same as §3's baseline (the `PHILO_TRUSTED_PROXY=true` line if today's launch sets it:
     D9 is still open);
   - the `oberon notify: posting lead events…` line, with no Notify error.

   Drizzle logs nothing when it migrates, and a failed migration stops the boot, so `healthy` is the migration's
   check here; §6 step 2 checked its result by query.

   Intake is open again. Record the time: it should be under T0 + 15 minutes. If it isn't, tell the maintainer now.
6. `scripts/health-check.sh` passes, including `OK   Philo intake preflight from https://oberonlogistics.com`.
7. Check the leads: `SELECT count(*), max(created_at) FROM leads WHERE created_at <= <T0>` (read-only) matches step 2.
8. **The maintainer signs in** at `https://philo.oberonlogistics.com` through OL Auth, and confirms they see their
   leads and that a lead's attachment opens. This is the bind, untested until now (§2). If sign-in is refused (an
   email mismatch, a client or redirect error), go to R1 straight away.
9. The maintainer checks that an existing API key works against `/api/v1`, for example
   `curl -H "Authorization: Bearer <key>" https://philo.oberonlogistics.com/api/v1/funnels`.
10. **One test lead**, with the maintainer's OK: submit it through the real website form. It must:
    - show the success message;
    - appear in Philo;
    - send the new-lead email;
    - show in the OL Notify bell of another OL app (the maintainer checks), and be logged as
      `oberon notify: accepted post type=lead.created …` in `docker logs`. A `setup error` line here (403
      `post_as_forbidden`, `unknown_app`, `unknown_role`) means the Notify registration is incomplete: R1, or fix
      the registration while Philo retries (10 s, 60 s, 300 s, then dropped).

    Then delete it in Philo.

The window closes when all ten pass. Record the time.

## 8. Rollback

Leads arrive again from step 5 on, so a rollback must keep them.

**R1: environment only (identity or Notify trouble; the image itself works).** Remove the whole `philo-ol.env`, not
single variables: `PHILO_OIDC_SCOPE` or `PHILO_OIDC_RESOURCE` without the issuer is a boot error
(`packages/server/src/config.ts:143-145`), and Notify without its issuer is "half configured". So R1 also turns the
Notify feed off.

- **`docker run` launch:** stop and `docker rm` the new container, then start it again with today's launch, `$IMG`
  and no `--env-file /<deploy dir>/philo-ol.env`.
- **Compose launch:** remove the `philo-ol.env` entry from `env_file` and `docker compose up -d`.

The built-in IdP comes back with the same account, password and signing key. The migration stays applied, and this
image understands it. Nothing is restored, so nothing is lost. Check with §7 step 6, the boot line
`identity:        built-in IdP at https://philo.oberonlogistics.com/oauth`, and a password sign-in by the maintainer.

**R2: back to stock (only if the fork image itself fails).**

1. Stop the new container.
2. Make an online backup of the **new** database to `philo-postcutover-ol-v0.6.0-1.db`, and keep it.
3. If `SELECT count(*) FROM users` is 1, check `__drizzle_migrations` and apply §6 step 6's reversal (rehearsed),
   `chown` included, on the production volume. Otherwise, stop and ask: the maintainer decides between revoking the
   other accounts' credentials and restoring with carry-over (DEPLOY.md §6).
4. Bring the stock container back:
   - **`docker run` launch:** `docker rm` the new container, `docker rename <philo container>-stock <philo container>`,
     `docker update --restart=<the policy recorded in §3> <philo container>`, and `docker start <philo container>`.
   - **Compose launch:** put `compose.yaml.stock` back in place of the compose file and `docker compose up -d`.

   Check that the image's digest is the one from §3.
5. Run §7 step 6 and, with the maintainer's OK, one test lead again.

## 9. Afterwards

- Keep both named backups and the pre-window copy until the next release has run cleanly. Delete them under the D3
  retention.
- Delete the `-stock` container (or `compose.yaml.stock`) once the maintainer agrees release 1 is staying.
- Delete `~/philo-cutover-<date>/inspect-before.json` and `today.env` once the window is closed and R2 is no longer
  wanted. Keep `log.md`.
- Open a fork PR (branch `ol/after-cutover-1`, from `origin/main`) that updates:
  - DEPLOY.md §0's "Today" column: the image reference with its digest, OL Auth for one account, and the Notify feed
    on;
  - DEPLOY.md D3 and D10, with what was used;
  - the integration tracker (fork issue #3).

  Include no secrets, no env values beyond those on this page, and no lead data.
- The next release adds the chrome, several people and MCP agents through OL Auth. It goes through DEPLOY.md §7, plus
  that release's own env additions and its own rehearsal. The §1 waiver doesn't carry over to it.
