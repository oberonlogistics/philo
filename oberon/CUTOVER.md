# Cutover runbook: production onto the fork, release 1

The steps for switching `https://philo.oberonlogistics.com` from the stock upstream image to the fork's
`ol-v0.7.0-1`. It is written for an agent running production on the maintainer's behalf, under the waiver in §1.
Read all of it before the first command. The reasons behind the steps are in [`DEPLOY.md`](DEPLOY.md); this page is
the steps.

## 0. What this release changes

| | Before | After release 1 |
|---|---|---|
| Image | `ghcr.io/philo-crm/philo:0.5.1` (stock) | `ghcr.io/oberonlogistics/philo:ol-v0.7.0-1@sha256:<digest>` |
| Sign-in | Philo's built-in IdP (password) | OL Auth, for the one existing account (`id=1`), which binds by verified email |
| Notifications | Email and web push | The same, **plus** each new lead, added lead and stage move in the OL Notify feed for the Philo users role |
| Data | The production volume | **The same volume**, migrated in place by `0013_user_roles` (adds `role`, `role_confirmed_at`, `disabled_at` to `users`) |

**Not in release 1.** These come later as ordinary upgrades (`ol-v0.7.0-2` or a later version: DEPLOY.md §7), with no
new window:

- the shared chrome (app switcher, account menu, bell in Philo's top bar). The host-script code is in this image
  (philo-crm/philo#78), but it needs the Oberon wiring and the `PHILO_WEB_HOST_*` env, a later change;
- several people signing in, with roles from OL Auth scopes. The code is in this image (#77), but release 1 leaves
  its env unset. Until then, only the account that binds can sign in, and a second OL Auth person is refused;
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
it: the real-copy rehearsal (§6), the window (§7) and both rollbacks (§8), and it stops at every gate. The waiver also
covers three more things DEPLOY.md §1 marks HUMAN or forbids: reading Caddy's site block for Philo (§3), pushing the
one release tag after GATE 2 (§4), and handing the host's env files to Docker, including writing `today.env` and
`philo-ol.env`, without printing their values (§3, §5). The maintainer still decides each gate and does the one OL Auth
sign-in. OL Auth and Notify registration stay with the maintainer.
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
    config`, or `env` / `printenv` inside it. The one exception is `docker compose -p philo-scratch -f <copy> config
    --volumes` in §6 step 8: that flag prints only the names of the file's top-level volumes, one per line.
- **One writer.** Never let two Philo processes open the production volume at once, and never run `sqlite3` writes
  while Philo runs on it.
- **Type every name.** Container and volume names come from §3's record. Before any `stop`, `rm`, `rename` or
  restore, check the name against that record.
- **Keep a log** on the host, at `~/philo-cutover-<date>/log.md`: each command, its time and its outcome, with no
  secrets and no row content. It becomes the record in §9. Everything in that directory is created under
  `umask 077`, so the directory and its subdirectories are mode 700. That is what protects the backups in it: the root
  helper containers write their files 0644.

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
    `packages/server/src/auth/external-idp.ts` (the single-account path release 1 uses is `:410-453`);
  - built-in sign-in (`auth/credentials.ts`, `oauth/routes.ts`) never reads it;
  - the bind sets only `externalSubject` and leaves `password_hash` alone (`external-idp.ts:431-432`).

  So under R1 the bound account signs in with its password as before. If the bind fails in the window, the fix is R1.

## 3. Record what runs today (read-only)

On the production host, without changing anything:

```sh
umask 077
mkdir -p ~/philo-cutover-<date>
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker inspect <philo container> > ~/philo-cutover-<date>/inspect-before.json   # stays on the host: it holds env values
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <philo container> | cut -d= -f1   # env names only
docker image inspect --format '{{index .RepoDigests 0}}' "$(docker inspect --format '{{.Image}}' <philo container>)"
docker run --rm -v <data volume>:/data:ro alpine ls -la /data
docker logs <philo container> 2>&1 | grep -E '^  (identity|rate limits|note: rate limits)'   # the baseline boot lines
```

Write these to the log, with env **names** only and no values:

- the container name, the image, and its digest (the stock rollback image is `ghcr.io/philo-crm/philo:0.5.1@sha256:<that
  digest>`);
- the full launch: env names (the list includes the image's own, such as `PATH`, `NODE_ENV` and `PHILO_DATA_DIR`),
  whether they come from `-e` or an env file (and which), mounts, ports, restart policy
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

### Helpers (in the working directory only)

Each command block may run in a fresh shell, so nothing set in one block survives to the next. Two files in the
working directory carry what later blocks need. Write them once, now:

```sh
umask 077
cd ~/philo-cutover-<date>
printf "D='%s'\n" "$PWD" > vars.sh    # paths and names only, never a secret
printf "STOCK_IMG='%s'\n" 'ghcr.io/philo-crm/philo:0.5.1@sha256:<the digest recorded above>' >> vars.sh
cat > wait.sh <<'EOF'
# sh wait.sh <container> [seconds, default 180]
# Waits for the container to turn healthy. Gives up early if it exits, restarts or turns unhealthy.
c=$1; t=${2:-180}
r0=$(docker inspect --format '{{.RestartCount}}' "$c" 2>/dev/null) || r0=0
end=$(( $(date +%s) + t ))
while :; do
  s=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$c" 2>/dev/null) || s='missing - 0'
  set -- $s
  case "$1 $2" in "running healthy"|exited*|dead*|restarting*|"running unhealthy"|*none) break ;; esac
  [ "$3" -gt "$r0" ] && break
  [ "$(date +%s)" -ge "$end" ] && break
  sleep 2
done
echo "$c: $s (restarts before: $r0)"
[ "$1 $2" = "running healthy" ] && [ "$3" -le "$r0" ]
EOF
```

- **`vars.sh`.** Start every later block that uses `$D`, `$STOCK_IMG`, `$IMG` or `$SECRET_FILE` with
  `. ~/philo-cutover-<date>/vars.sh`. §4 adds `IMG`, and §5 adds `SECRET_FILE`, the **path** of the secret file. No
  value from an env file and no secret ever goes into `vars.sh`.
- **The bounded wait** is `sh "$D/wait.sh" <container>`. It prints the final state and succeeds only on
  `running healthy` with no new restart. The image's `HEALTHCHECK` runs every 30 s, so `healthy` takes about 30 s;
  that is normal. Every "wait for `healthy`" on this page means this command. When it fails:
  - on `philo-imgcheck` or `philo-envcheck` (no real data): read `docker logs <container> 2>&1 | tail -40`, run
    `docker rm -f <container>`, and stop;
  - on `philo-scratch` (a copy of real data): read only `docker logs philo-scratch 2>&1 | grep -iE 'error|config'`,
    under the data rules, and stop;
  - on production: follow the step's own rule.

## 4. Cut and check the release

**GATE 2: the maintainer approves pushing the tag.**

Release 1 is **pinned to fork commit `1041266`**, the `main` this runbook was reviewed against. Later work on `main`
(people management lands with migration `0014`) belongs to release 2, so don't tag a newer commit for release 1.
From a checkout of the fork:

```sh
git fetch origin
git fetch https://github.com/philo-crm/philo.git refs/tags/v0.5.1:refs/tags/v0.5.1 --no-tags   # the fork has no v* tags
git rev-parse 'v0.5.1^{commit}'                                              # must resolve
REL1_COMMIT=10412667e8d89a611f7b5bd02d9fd4cabe05c18a
git merge-base --is-ancestor $REL1_COMMIT origin/main && echo on-main                  # on-main
git diff --name-only v0.5.1 $REL1_COMMIT -- 'packages/server/drizzle/*.sql'           # expect exactly 0013_user_roles.sql
git ls-tree --name-only $REL1_COMMIT packages/server/drizzle/ | grep -c '\.sql$'           # expect 14
git show $REL1_COMMIT:package.json | grep '"version"'                                # expect 0.7.0
git tag -a ol-v0.7.0-1 -m "ol-v0.7.0-1" $REL1_COMMIT
git push origin ol-v0.7.0-1        # this one tag only; never --tags
```

If the diff lists anything but `0013_user_roles.sql`, stop: §8's R2 covers only that migration. Never push the
fetched `v0.5.1` tag.

The **Oberon release image** workflow (`ol-release.yml`) runs on the tag. When it passes, copy the
`ghcr.io/oberonlogistics/philo:ol-v0.7.0-1@sha256:…` line from its job summary into the log. That reference, with its
digest, is the only image production may run. Never use `:latest`, `:edge` or a semver tag from this package.

On the production host, check the image without the data volume:

```sh
printf "IMG='%s'\n" 'ghcr.io/oberonlogistics/philo:ol-v0.7.0-1@sha256:<digest>' >> ~/philo-cutover-<date>/vars.sh
. ~/philo-cutover-<date>/vars.sh
docker pull "$IMG"
docker run -d --name philo-imgcheck -p 127.0.0.1:<free port>:3000 "$IMG"
sh "$D/wait.sh" philo-imgcheck                                                        # running healthy
curl -s http://127.0.0.1:<free port>/version                                          # name philo, version 0.7.0
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<free port>/oberon/philo-host.js   # 200
curl -sI http://127.0.0.1:<free port>/ | grep -i content-security-policy              # present
docker stop philo-imgcheck && docker rm philo-imgcheck
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
`#` comments). `OL_NOTIFY_RESOURCE` must equal the value Notify's `NOTIFY_RESOURCE` holds (§2). Then add the secret without printing it:

```sh
printf "SECRET_FILE='%s'\n" '<the path the maintainer named>' >> ~/philo-cutover-<date>/vars.sh   # the path, not the secret
. ~/philo-cutover-<date>/vars.sh
( umask 077
  { cat /<deploy dir>/philo-ol.env.public; printf 'OL_NOTIFY_CLIENT_SECRET=%s\n' "$(cat "$SECRET_FILE")"; } \
    > /<deploy dir>/philo-ol.env )
stat -c '%a %U' /<deploy dir>/philo-ol.env                       # 600 <deploy user>
grep -c '^OL_NOTIFY_CLIENT_SECRET=.' /<deploy dir>/philo-ol.env   # 1
```

**Leave unset in release 1:**

- `PHILO_OIDC_USER_SCOPE`, `PHILO_OIDC_ADMIN_SCOPE` and `PHILO_OIDC_AGENT_SCOPE`: this image reads them
  (philo-crm/philo#77), but with them unset it keeps the single-account behaviour release 1 relies on (identity spec
  §3, release 1). Setting them is the later release's change, with its own role-confirmation step.
- `PHILO_WEB_HOST_*` and `PHILO_WEB_ASSET_ORIGINS`: this image reads them too (#78), but the chrome isn't in release 1.
- `PHILO_OIDC_AGENT_CLIENT_IDS`: this release would take `*` as a literal client id, not as "any client".
- `PHILO_WEB_CONNECT_ORIGINS`: OL Auth's token endpoint is on its issuer's origin, which the CSP already allows.
- `PHILO_APP_URL` and `PHILO_MCP_URL`: their defaults come from `PHILO_PUBLIC_BASE_URL`.
- `OL_NOTIFY_ISSUER`: it defaults to `PHILO_OIDC_ISSUER`.

**Check the Notify credentials** with the same token request Philo makes (`apps/standalone/src/oberon/notify.ts`,
`TokenSource`): Basic auth, `grant_type=client_credentials`, `scope=notify:post`, `audience=` the Notify resource. The
token endpoint comes from OL Auth's discovery document:

```sh
. ~/philo-cutover-<date>/vars.sh
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
work around it. Philo form-encodes the id and secret inside Basic auth (`notify.ts`, `formEncode`) and curl doesn't,
so the two requests are the same only when both are made of letters, digits and `-_.!~*'()`. If not, a `200` here
doesn't prove Philo's request. This proves the token only. A missing post-as entry (403 `post_as_forbidden`) or a
missing tile or role (`unknown_app`, `unknown_role`) shows up only on a real post, at §7 step 10.

**Test the file on a throwaway container** with its own empty data directory. It has no route from Caddy, and no
leads exist for it to post. It needs today's env, names and values, from §3's record:

- if today's launch uses an env file, pass that file;
- if it passes env with `-e`, rebuild it into a mode-600 file first:
  `( umask 077; docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <philo container> > ~/philo-cutover-<date>/today.env )`.

Without `PHILO_PUBLIC_BASE_URL`, the app URL defaults to `http://localhost:3000`, and under `NODE_ENV=production` the
Notify config refuses it ("invalid PHILO_APP_URL", `notify-config.ts:97`), so the check would fail for the wrong
reason.

```sh
. ~/philo-cutover-<date>/vars.sh
docker run -d --name philo-envcheck -p 127.0.0.1:<free port>:3000 \
  --env-file <today's env file> --env-file /<deploy dir>/philo-ol.env \
  -e PHILO_DATA_DIR=/tmp/envcheck "$IMG"
sh "$D/wait.sh" philo-envcheck                   # running healthy
docker logs philo-envcheck 2>&1 | head -40
docker stop philo-envcheck && docker rm philo-envcheck
```

There is no `--rm`, so a container that exits stays readable. If the wait fails, read the error in
`docker logs philo-envcheck` (a config error names the variable, not its value), `docker rm -f philo-envcheck`, and
stop. The log must show these lines:

- `identity:        external IdP https://auth.oberonlogistics.com (operator client philo), one account`;
- the `oberon notify: posting lead events as philo to https://notify.oberonlogistics.com, for role philo-users,
  linking to https://philo.oberonlogistics.com` line, with no "half configured" error.

## 6. Rehearse on a copy

The agent does this under the §1 waiver, with the data rules in force throughout. It follows DEPLOY.md §4.3, except
for sign-in, and spells its commands out here:

- a scratch volume `philo-scratch` and a container of the same name, on loopback only, with no Caddy route;
- an online backup of production copied in (DEPLOYMENT.md § Backup, online form);
- before the first start, `email.%` settings, `push_subscriptions` and `webhooks` deleted;
- `vapid-keys.json` not copied;
- every `OL_NOTIFY_*` variable unset: the copy gets today's env plus only the identity block of
  `philo-ol.env.public`, never `philo-ol.env`;
- `PHILO_PUBLIC_BASE_URL=http://localhost:<port>`;
- no OL Auth sign-in, and no password sign-in (§2, last item).

**Set up the copy.** Create `rehearsal/` yourself first. If Docker creates a missing bind-mount directory, it is
root-owned, and you can't delete what the helper writes into it.

```sh
. ~/philo-cutover-<date>/vars.sh
umask 077
mkdir -p "$D/rehearsal"                                         # 700, owned by you
grep '^PHILO_OIDC_' /<deploy dir>/philo-ol.env.public > "$D/identity.env"
grep -c '^OL_' "$D/identity.env"                                # 0
date +%s                                                        # backup start, for step 4
docker run --rm -v <data volume>:/data -v "$D/rehearsal":/backup alpine sh -c \
  'apk add --no-cache sqlite >/dev/null && sqlite3 /data/philo.db ".backup /backup/philo-rehearsal.db"'
date +%s                                                        # backup end
docker volume create philo-scratch
test philo-scratch != '<data volume>' || exit 1                 # the guard before anything writes to a volume
docker run --rm -v philo-scratch:/data -v "$D/rehearsal":/backup alpine sh -c \
  'cp /backup/philo-rehearsal.db /data/philo.db && chown -R 1000:1000 /data'
docker run --rm -v philo-scratch:/data alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -bail /data/philo.db "
  DELETE FROM settings WHERE key LIKE '\''email.%'\'';
  DELETE FROM push_subscriptions;
  DELETE FROM webhooks;" && chown -R 1000:1000 /data'
```

**The scratch run.** Every boot below is this command, with the image and the identity file as each step says. Before
each new run, `docker stop philo-scratch && docker rm philo-scratch` if it exists. `-e` overrides the env files, so
the copy uses its own address, data path and port whatever today's env says:

```sh
. ~/philo-cutover-<date>/vars.sh
docker run -d --name philo-scratch -p 127.0.0.1:<port>:3000 -v philo-scratch:/data \
  --env-file <today's env file> [--env-file "$D/identity.env"] \
  -e PHILO_PUBLIC_BASE_URL=http://localhost:<port> -e PHILO_DATA_DIR=/data -e PHILO_PORT=3000 <image>
sh "$D/wait.sh" philo-scratch
```

Run every `sqlite3` below with the container stopped, in the alpine helper on the scratch volume. Check:

1. **Before the first boot:** `PRAGMA integrity_check` is `ok`; `SELECT count(*) FROM users` is 1;
   `SELECT count(*), max(created_at) FROM __drizzle_migrations` is `13|1792992174385`; record
   `SELECT count(*), max(created_at) FROM leads` as **L0**.
2. **Boot `"$IMG"` with `identity.env`.** The wait reports `running healthy`. The boot log
   (`docker logs philo-scratch 2>&1 | grep -E '^  (identity|rate limits|note: rate limits)'`) shows
   `identity:        external IdP https://auth.oberonlogistics.com (operator client philo), one account`, and the rate-limit line
   matches §3's baseline. Drizzle logs nothing when it migrates, so check the migration by query, after stopping:
   - `SELECT count(*), max(created_at) FROM __drizzle_migrations` is `14|1795723669355` (0013's `when` in
     `packages/server/drizzle/meta/_journal.json`);
   - `SELECT count(*) FROM pragma_table_info('users') WHERE name IN ('role','role_confirmed_at','disabled_at')` is 3;
   - `SELECT count(*) FROM users WHERE role = 'admin'` is 1;
   - `PRAGMA integrity_check` is `ok`.
3. `curl -s http://127.0.0.1:<port>/api/v1/auth/config` names issuer `https://auth.oberonlogistics.com` and client
   `philo`.
4. **Time the backup.** Write down how long the online backup in the setup above took on this real-size file.
5. **R1 works for a bound account.** Simulate the bind, with the container stopped:
   ```sh
   docker run --rm -v philo-scratch:/data alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -bail /data/philo.db "
     UPDATE users SET external_subject = '\''https://auth.oberonlogistics.com rehearsal'\'' WHERE id = 1;
     SELECT changes();" && chown -R 1000:1000 /data'     # expect 1
   ```
   Boot `"$IMG"` again **without** `identity.env`. The wait reports `running healthy`, the boot log shows
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
7. **Stock boots on it.** Boot `"$STOCK_IMG"` without `identity.env`. The wait reports `running healthy`, and:
   - `curl -s http://127.0.0.1:<port>/version` answers `0.5.1`;
   - a POST to the copy's intake URL (from its boot log's `intake form:` line, with `localhost:<port>`) returns `201`:
     `curl -s -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' -d '{"name":"Rehearsal","email":"rehearsal@example.com"}' <intake URL>`;
   - after stopping it, `PRAGMA integrity_check` is `ok` and `SELECT count(*) FROM leads` is L0's count plus one.
8. **If production runs under Compose**, rehearse §8 R2's Compose path too. `docker rm philo-scratch` first. Write two
   copies of production's compose file (§3's path), `$D/compose.scratch-fork.yaml` and `$D/compose.scratch-stock.yaml`.
   Keep only the Philo service, and change it like this:
   - `image:` the `IMG` value from `vars.sh` in the fork copy, the `STOCK_IMG` value in the stock copy, typed out;
   - `container_name: philo-scratch` (add it, or replace the existing one);
   - `ports:` only `127.0.0.1:<port>:3000`;
   - `volumes:` only `philo-scratch:/data`, and the top-level `volumes:` holds only `philo-scratch:` with
     `external: true` and **no `name:`**;
   - `env_file:` today's env file and, in the fork copy only, `$D/identity.env`, as absolute paths. Never
     `philo-ol.env`;
   - `environment:` keep today's entries, and set `PHILO_PUBLIC_BASE_URL: http://localhost:<port>`,
     `PHILO_DATA_DIR: /data` and `PHILO_PORT: "3000"` (`environment:` overrides `env_file:`);
   - `restart: "no"`, no `networks:`, and no `${…}` anywhere.

   Check each copy before any `up`. Any other result is a stop:
   ```sh
   . ~/philo-cutover-<date>/vars.sh
   for f in "$D/compose.scratch-fork.yaml" "$D/compose.scratch-stock.yaml"; do
     grep -cF -e '<data volume>' -e 'philo-ol.env' -e '${' "$f"         # 0
     grep -E '^ +(container_name|name):' "$f"                           # only: container_name: philo-scratch
     docker compose -p philo-scratch -f "$f" config --volumes            # only: philo-scratch
   done
   ```
   `config --volumes` prints the top-level volume keys, not a `name:` override, which is why the `name:` grep is
   there too. Then run the R2 path:
   ```sh
   . ~/philo-cutover-<date>/vars.sh
   docker compose -p philo-scratch -f "$D/compose.scratch-fork.yaml" up -d
   sh "$D/wait.sh" philo-scratch && curl -s http://127.0.0.1:<port>/version     # 0.7.0
   docker compose -p philo-scratch -f "$D/compose.scratch-fork.yaml" stop
   ```
   Apply step 6's check and reversal again, then:
   ```sh
   . ~/philo-cutover-<date>/vars.sh
   docker compose -p philo-scratch -f "$D/compose.scratch-stock.yaml" up -d     # recreates philo-scratch on stock
   sh "$D/wait.sh" philo-scratch && curl -s http://127.0.0.1:<port>/version     # 0.5.1
   docker compose -p philo-scratch -f "$D/compose.scratch-stock.yaml" down      # keeps the external volume
   ```
9. Write down how long each step took.
10. **Delete the copy straight away**, before anything else. It holds applicants' personal data:
    ```sh
    . ~/philo-cutover-<date>/vars.sh
    docker rm -f philo-scratch 2>/dev/null
    docker volume rm philo-scratch
    docker run --rm -v "$D":/w alpine rm -rf /w/rehearsal     # the helper deletes whatever root wrote there
    test ! -e "$D/rehearsal" && echo gone                    # gone
    docker volume ls -q | grep -cx philo-scratch              # 0
    ```

## 7. The window

**About 30 minutes before, after GATE 1 and the rehearsal:**

- Take an online backup of production with step 2's command, but into `"$D/prewindow"` (production keeps running;
  the online form is safe on a live database), and copy it off the host with the §2 tool, timing both. If the tool
  sends only changes (`rsync`), step 2 then copies only what changed since. Keep this copy until §9.
- Add the backup time from §6 step 4 to this copy time. **If the two exceed 8 minutes**, tell the maintainer at
  GATE 3: the window is 15 minutes (D5), and steps 3 to 5 need the rest.

**GATE 3: the maintainer says "go".**

Intake is down from step 1 until step 5, and the window has a **15-minute budget** (DEPLOY.md D5). The website's form
shows its fallback message, and nothing is queued.

There is **no intake hold in Caddy** this time (DEPLOY.md §5 step 3). The hold kept intake closed while the operator
confirmed their role: with roles from IdP scopes, an account needs a role confirmed in the last 30 days. Release 1
leaves the role scopes unset, so boot's `accessPolicyOf` gives `rolesFromIdp: false`
(`packages/server/src/boot.ts:54`), and `hasAccess` ignores `role_confirmed_at` (`packages/server/src/auth/access.ts:65-72`), and nothing has to happen before leads flow again. Intake reopens as soon
as the new container is healthy, and Caddy isn't touched.

1. `docker stop <philo container>`. Then `date +%s%3N`: write this down as **T0** (after the stop, so no lead lands
   between T0 and the backup).
2. Make the **pre-cutover backup** with the online form from DEPLOYMENT.md § Backup, into a 700 directory of its own
   (the Philo image has no `sqlite3`, so the helper does it all):
   ```sh
   . ~/philo-cutover-<date>/vars.sh
   ( umask 077; mkdir -p "$D/precutover" )
   docker run --rm -v <data volume>:/data -v "$D/precutover":/backup alpine sh -c \
     'apk add --no-cache sqlite >/dev/null &&
      sqlite3 /data/philo.db ".backup /backup/philo-precutover-ol-v0.7.0-1.db" &&
      cp /data/oidc-signing-key.json /data/vapid-keys.json /backup/ &&
      sqlite3 -readonly /backup/philo-precutover-ol-v0.7.0-1.db "PRAGMA integrity_check; SELECT count(*), max(created_at) FROM leads;"'
   ```
   - `PRAGMA integrity_check` prints `ok`.
   - Write the lead count and `max(created_at)` to the log.
   - Copy the three files (`philo-precutover-ol-v0.7.0-1.db`, `oidc-signing-key.json`, `vapid-keys.json`) to the
     off-host destination from §2 and check the copy's checksum. **Don't go on until the copy is verified.**

   **Abort:** production is untouched until step 3. If anything in steps 1–2 fails, or step 2 isn't done by
   **T0 + 10 minutes**, run `docker start <philo container>`, then `. ~/philo-cutover-<date>/vars.sh` and the bounded
   wait (`sh "$D/wait.sh" <philo container>`), then `scripts/health-check.sh`, and stop. Tell the maintainer.
3. Set the stock container aside for R2:
   - **`docker run` launch:** `docker rename <philo container> <philo container>-stock`, then
     `docker update --restart=no <philo container>-stock`, so a daemon restart or a reboot can't bring it back as a
     second writer.
   - **Compose launch:** don't rename (Compose finds its container by label, and `up -d` would recreate the renamed
     one and remove it). Copy the compose file to `compose.yaml.stock` next to it, and check that the stock image
     from §3 is still present (`docker image inspect <stock image@digest>`). Run no `docker image prune` until §9.
4. Start the new container under the **original name** with today's launch exactly as recorded in §3
   (`. ~/philo-cutover-<date>/vars.sh` first, for `$IMG` and `$D`). Change only two things:
   - the image is `$IMG`;
   - `--env-file /<deploy dir>/philo-ol.env` is added.

   Same volume, same ports, same restart policy, same network. Under Compose, edit only the image and add
   `philo-ol.env` to `env_file` in the compose file, then `docker compose up -d` with the project and file recorded
   in §3. Then the bounded wait: `sh "$D/wait.sh" <philo container>`.

   **If the wait fails, or the container isn't healthy by T0 + 12 minutes,** don't wait longer. It may be
   crash-looping under production's restart policy. Read only
   `docker logs <philo container> 2>&1 | grep -iE 'error|config'`, under the data rules:
   - a config error that names an `OL_` or `PHILO_OIDC_` variable means **R1**;
   - anything else, including no matching line, means **R2**.
5. Check the boot log (`docker logs <philo container> 2>&1 | grep -E '^  (identity|rate limits|note: rate limits)|oberon notify'`):
   - `identity:        external IdP https://auth.oberonlogistics.com (operator client philo), one account`;
   - the rate-limit line is the same as §3's baseline (the `PHILO_TRUSTED_PROXY=true` line if today's launch sets it:
     D9 is still open);
   - the `oberon notify: posting lead events…` line, with no Notify error.

   A wrong or missing identity or Notify line means R1.

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
(`EXTERNAL_ONLY`, `packages/server/src/config.ts:229-247`), and Notify without its issuer is "half configured". So R1 also turns the
Notify feed off.

- **`docker run` launch:** stop the new container, check that it is the new one, and remove it:
  ```sh
  . ~/philo-cutover-<date>/vars.sh
  docker stop <philo container>
  [ "$(docker inspect --format '{{.Config.Image}}' <philo container>)" = "$IMG" ] && docker rm <philo container>
  ```
  If the check fails, stop: that is not the container you started. Otherwise start it again with today's launch,
  `"$IMG"` and no `--env-file /<deploy dir>/philo-ol.env`.
- **Compose launch:** remove the `philo-ol.env` entry from `env_file` and `docker compose up -d`.

Then the bounded wait, `sh "$D/wait.sh" <philo container>`. If it fails, the image itself fails: go to R2.

The built-in IdP comes back with the same account, password and signing key. The migration stays applied, and this
image understands it. Nothing is restored, so nothing is lost. Check with §7 step 6, the boot line
`identity:        built-in IdP at https://philo.oberonlogistics.com/oauth`, and a password sign-in by the maintainer.

**R2: back to stock (only if the fork image itself fails).** D5's 15-minute budget covers the window only. R2 has its
own target: intake back within **15 minutes of R2 step 1**. It is about §6's backup time plus one reversal and one
boot. Tell the maintainer when R2 starts, and again if it passes that target.

1. `docker stop <philo container>` (this also stops a crash-looping container).
2. Make an online backup of the **new** database, with §7 step 2's command but into `"$D/postcutover"` and the file
   `philo-postcutover-ol-v0.7.0-1.db`. Keep it.
3. Read what the migration left, on the production volume, with Philo stopped:
   ```sh
   docker run --rm -v <data volume>:/data alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -bail /data/philo.db "
     SELECT count(*) FROM users;
     SELECT count(*), max(created_at) FROM __drizzle_migrations;" && chown -R 1000:1000 /data'
   ```
   Drizzle's migrator runs the whole batch in one transaction (`drizzle-orm`, `SQLiteSyncDialect.migrate`: one
   `BEGIN` … `COMMIT`, `ROLLBACK` on error), so a failed boot leaves either all of 0013 or none of it:
   - **`13|1792992174385`:** 0013 never committed. Skip the reversal.
   - **`14|1795723669355` and 1 user:** apply §6 step 6's reversal (rehearsed), `chown` included, with
     `-v <data volume>:/data` in place of `-v philo-scratch:/data`. Then check that `__drizzle_migrations` is
     `13|1792992174385` and the `pragma_table_info` count is 0.
   - **`14|1795723669355` and more than 1 user:** stop and ask. The maintainer decides between revoking the other
     accounts' credentials and restoring with carry-over (DEPLOY.md §6).
   - **Anything else:** stop.
4. Bring the stock container back:
   - **`docker run` launch:** check both names, then swap them back:
     ```sh
     . ~/philo-cutover-<date>/vars.sh
     [ "$(docker inspect --format '{{.Config.Image}}' <philo container>)" = "$IMG" ] && docker rm <philo container>
     docker inspect --format '{{.Config.Image}}' <philo container>-stock     # the image recorded in §3
     docker rename <philo container>-stock <philo container>
     docker update --restart=<the policy recorded in §3> <philo container>
     docker start <philo container>
     ```
     If either check fails, stop.
   - **Compose launch:** put `compose.yaml.stock` back in place of the compose file and `docker compose up -d`.

   Then the bounded wait, `sh "$D/wait.sh" <philo container>`, and check that the image's digest is the one from §3:
   `docker image inspect --format '{{index .RepoDigests 0}}' "$(docker inspect --format '{{.Image}}' <philo container>)"`.
   If the wait fails, stop and tell the maintainer: what is left is DEPLOY.md §6's restore with carry-over, and the
   maintainer decides it.
5. Run §7 step 6 and, with the maintainer's OK, one test lead again.

## 9. Afterwards

- Keep both named backups and the pre-window copy (`precutover/`, `postcutover/` if R2 ran, and `prewindow/` in
  `~/philo-cutover-<date>/`, plus their off-host copies) until the next release has run cleanly. Delete them under the
  D3 retention.
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

## Release 2 (chrome and several users)

**Draft.** An env-and-image upgrade on top of release 1, through DEPLOY.md §7, with one small data migration:
`0014_account_links` adds the empty `account_links` table (people management, philo-crm/philo#80, landed early as
fork PR #19). It needs no window: intake is down only while the container is swapped (upgrade step 2, about a minute,
while the new container migrates and turns healthy), and only signed-in pages change. The §1 waiver doesn't cover
it; the maintainer runs it or gives a new one. Re-check this section against the release's own commit before using
it.

| | After release 1 | After release 2 |
|---|---|---|
| Image | `ol-v0.7.0-1` | The release-2 tag (`ol-v0.7.0-2`, or `ol-v<next>-1` if a sync lands first), which contains `oberon/web/philo-host.js` from `ol/chrome-wiring`, self-registered agents (philo-crm/philo#79, landed early as fork PR #17) and people management (philo-crm/philo#80, fork PR #19) |
| Data | Release 1's volume, 14 migrations | **The same volume**, migrated in place by `0014_account_links` (adds the `account_links` table, which stays empty under OL Auth: invite and reset links are the built-in IdP's) |
| Top bar | Philo's own account menu | The shared bell, app switcher and account menu (chrome spec §3); Philo's menu returns on any chrome failure, and `/sign-out` always works |
| Sign-in | Only `id=1`, by its bound subject | Every OL Auth person with a Philo role, with the role their token's scopes give (identity spec §4.5) |
| Agents | API keys | Also MCP agents that register themselves with OL Auth (`PHILO_OIDC_AGENT_CLIENT_IDS=*`, ID-U5), each acting as the person who connected it, with that person's role. API keys keep working |
| Removing someone | Nothing to remove: one account | An admin deactivates them through the people API (`PATCH /api/v1/users/:id`, ADR-0012), at once. There is no People screen in this build |

### Release 2: prerequisites (the maintainer confirms each)

- [ ] **The maintainer holds the Philo admins role** (`philo-admins`) at OL Auth **before the first sign-in on
  release 2** (identity spec §4). Roles come from scopes from then on: without the admins role, `id=1` signs in as a
  user and nobody can reach Server settings.
- [ ] **Everyone who should use Philo** is in `philo-users`; admins, the maintainer included, are in both (as release 1's
  §2 puts it). Notify posts to `philo-users` (`OL_NOTIFY_ROLE`), so an admin only in `philo-admins` signs in but gets no
  new-lead notifications in the bell. Anyone outside both roles is refused.
- [ ] **The `philo` client** holds `auth:apps`, `auth:account` and `notify:read`, with the audiences
  `https://auth.oberonlogistics.com/api` and `https://notify.oberonlogistics.com`, and is first-party (identity spec
  §5, "Public client"). Without them Philo works, but the chrome falls back to Philo's own menu.
- [ ] **The tile** has `launch_url` `https://philo.oberonlogistics.com/`, required scope `philo:user`, and a tint and
  glyph no other app uses (chrome spec §3.4).
- [ ] **For agents** (identity spec §5): the Philo resource and both scopes are `dynamic_clients: true`, and the
  rehearsal client `philo-dev` is **deleted** (identity spec §4.3 step 4), because `*` admits every client OL Auth
  issued a Philo token to.
- [ ] **If nobody has used the PWA for 30 days**, `id=1`'s role confirmation has lapsed (identity spec §4.4). On
  release 1 every admitted token refreshes it (`keepConfirmed` in `external-idp.ts`, at most hourly), so what counts is
  the last sign-in or agent request, not the cutover date. The rehearsal below reads it. Once the role scopes are on, a
  lapsed `id=1` fails `hasAccess` until the maintainer signs in on release 2 (the upgrade, step 3): its API keys answer
  401, and the admin fallback for new-lead email and the VAPID contact skip it. Do step 3 right after step 2.
- [ ] **An admin's API key for the people API** (below): the maintainer has one for `id=1`, or creates one after
  signing in on release 2. It stays with the maintainer. The production host has `jq` and a `curl` of 7.55 or later
  (`curl -H @file`).

### Release 2: cut and check the release

**The maintainer approves pushing the tag.** The release-2 commit is a fork `main` at or after fork PR #19, the
merge that landed people management. From a checkout of the fork:

```sh
git fetch origin
git fetch https://github.com/philo-crm/philo.git refs/tags/v0.5.1:refs/tags/v0.5.1 --no-tags   # the fork has no v* tags
REL2_COMMIT=<the full SHA of the main commit to release>
git merge-base --is-ancestor $REL2_COMMIT origin/main && echo on-main                          # on-main
git merge-base --is-ancestor 076e66672b377b752497adf90dabc8413344518a $REL2_COMMIT && echo people  # people (fork PR #19)
git merge-base --is-ancestor cfb9bd99599096529ba756d01840372ad016593c $REL2_COMMIT && echo agents  # agents (fork PR #17)
git ls-tree --name-only $REL2_COMMIT oberon/web/philo-host.js                                  # oberon/web/philo-host.js
git diff --name-only v0.5.1 $REL2_COMMIT -- 'packages/server/drizzle/*.sql'    # exactly 0013_user_roles.sql, 0014_account_links.sql
git ls-tree --name-only $REL2_COMMIT packages/server/drizzle/ | grep -c '\.sql$'                # 15
git show $REL2_COMMIT:packages/server/drizzle/meta/_journal.json | grep -c '"when": 1795751123839'   # 1 (0014's)
git show $REL2_COMMIT:package.json | grep '"version"'                                         # names <version>
git tag -a <tag> -m "<tag>" $REL2_COMMIT
git push origin <tag>        # this one tag only; never --tags
```

`<tag>` is `ol-v<version>-<n>` (§0's table): `ol-v0.7.0-2` while the version is `0.7.0`. If the diff lists anything
but those two migrations, stop: the rollback below covers only 0014 on top of release 1. Never push the fetched
`v0.5.1` tag. Then take the image reference with its digest from the workflow's job summary and check it on the host
without the data volume, as §4 does, before it goes into `vars.sh`.

### Release 2: working directory

Release 2 has its own, set up like §3's helpers, with `vars.sh` naming the release-2 image. Everything below that
borrows a §5–§7 command runs it with this `vars.sh`, not release 1's.

```sh
umask 077
mkdir -p ~/philo-release2-<date> && cd ~/philo-release2-<date>
printf "D='%s'\n" "$PWD" > vars.sh    # paths and names only, never a secret
printf "IMG='%s'\n" 'ghcr.io/oberonlogistics/philo:<tag>@sha256:<digest>' >> vars.sh
grep '^SECRET_FILE=' ~/philo-cutover-<release 1 date>/vars.sh >> vars.sh   # the path, for §5's rebuild
grep '^IMG=' ~/philo-cutover-<release 1 date>/vars.sh | sed 's/^IMG=/R1_IMG=/' >> vars.sh   # release 1's image
cp ~/philo-cutover-<release 1 date>/wait.sh .
. ./vars.sh
[ "$(docker inspect --format '{{.Config.Image}}' <philo container>)" = "$R1_IMG" ] && echo r1   # r1
docker ps -a --format '{{.Names}}' | grep -cx '<philo container>-r1'                          # 0
```

If the first check doesn't print `r1`, production isn't running release 1's image: stop. `<philo container>`, the
data volume, the launch type and the full launch are §3's record, updated by §7 step 4 (the image is release 1's,
and `--env-file /<deploy dir>/philo-ol.env` is part of the launch). Release 1's `<philo container>-stock` (or
`compose.yaml.stock`) may still exist if §9 hasn't deleted it: leave it alone, it has `--restart=no`.

Keep a `log.md` here, as §1 says.

### Release 2: the people API

Deactivation (ADR-0012) is `PATCH /api/v1/users/:id` with `{"disabled": true}`, and only an admin may call it
(`packages/server/src/users/routes.ts`; `app.ts`'s role guard). In one transaction it sets `disabled_at` and deletes
everything the account holds: its API keys, its Philo-issued access and refresh tokens, authorization codes and
sessions, its push subscriptions, and its pending links (`deactivate` in `users/service.ts`). An OL Auth token for it
is refused with `403 account_disabled` from its next request, whatever scopes it carries (`verifyExternalToken` in
`auth/external-idp.ts`); API keys and push already go through `hasAccess`, which refuses a disabled account. So it
takes effect at once. Only an open live stream (`/api/v1/events`, `/api/v1/push/live`) runs on, to its 15-minute
limit. `{"disabled": false}` restores sign-in, **not** the deleted keys and tokens: each person makes new keys. It
refuses `cannot_change_self` (`409`, so `id=1` never deactivates itself) and `last_admin` (`409`).

§1's data rules hold for the API too. `GET /api/v1/users` returns names and emails, and a `PATCH` returns the
person, so **never print a response**: print only the status code, or a count with `jq length`, and pass ids
through a variable or a file, never the screen. The maintainer holds the key, so the maintainer writes the header
file and nobody prints it:

```sh
. ~/philo-release2-<date>/vars.sh
( umask 077; : > "$D/admin-key.hdr" )   # the maintainer puts one line in it: Authorization: Bearer <key>
P=https://philo.oberonlogistics.com/api/v1/users
curl -s -o /dev/null -w '%{http_code}\n' -H @"$D/admin-key.hdr" "$P"      # 200
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH -H @"$D/admin-key.hdr" \
  -H 'content-type: application/json' -d '{}' "$P/1"                       # 409: the key is id=1's, and an admin's
```

The empty `PATCH` changes nothing: it answers `409` (`cannot_change_self`) only when the key acts as `id=1` with the
admin role. `401` means the key doesn't resolve (`id=1` lapsed or wrong key); `403` means `id=1` isn't an admin
(the roles rollback's A is 0). Then the API can't be used until the maintainer signs in with `philo-admins`. Delete
the header file (`rm "$D/admin-key.hdr"`) as soon as the step that needed it is done.

### Release 2: checks before the upgrade (read-only)

```sh
O=https://philo.oberonlogistics.com
A=https://auth.oberonlogistics.com/chrome/v1
for f in ol-chrome.js tokens.css fonts.css; do
  curl -s -o /dev/null -w "$f %{http_code} %{redirect_url}\n" -H "Origin: $O" "$A/$f"
done
curl -sI -H "Origin: $O" "$A/ol-chrome.js" | grep -i '^access-control-allow-origin'
curl -s -o /dev/null -w '%{http_code}\n' "$A/..%2Fmedia/x"
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS -H "Origin: $O" \
  -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization' \
  https://notify.oberonlogistics.com/v1/me/notifications
curl -sI -X OPTIONS -H "Origin: $O" -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  https://notify.oberonlogistics.com/v1/me/notifications | grep -i '^access-control-allow-origin'
```

Expect each file `200` with no redirect URL; `access-control-allow-origin: https://philo.oberonlogistics.com` from
OL Auth (the tile's launch origin, so the chrome loads in CORS mode); `404` for the `%2F` path, which is what keeps
`PHILO_WEB_ASSET_ORIGINS`'s prefix meaningful (chrome spec §3.3); and a 2xx preflight naming Philo's origin from
Notify, or the bell can't read the feed. Any other answer: stop and tell the maintainer.

### Release 2: the environment it adds

First keep release 1's two files, in the deploy dir, for the rollbacks. Production's container read
`philo-ol.env` when it was created, so editing the files doesn't change it until upgrade step 2:

```sh
install -m 600 -p /<deploy dir>/philo-ol.env.public /<deploy dir>/philo-ol.env.public.r1
install -m 600 -p /<deploy dir>/philo-ol.env /<deploy dir>/philo-ol.env.r1        # holds the secret: never print it
stat -c '%a %U %n' /<deploy dir>/philo-ol.env*.r1                                  # 600 <deploy user>, both
```

Then add these to `philo-ol.env.public` (§5), and rebuild `philo-ol.env` with the secret as §5 does. Keep
everything release 1 set. `<tag>` is the release-2 tag.

```sh
# Several users: identity spec §3 (philo-crm/philo#77, in v0.7.0)
PHILO_OIDC_USER_SCOPE=philo:user
PHILO_OIDC_ADMIN_SCOPE=philo:admin
PHILO_OIDC_AGENT_SCOPE=philo:user philo:admin offline_access
# Self-registered agents: identity spec §3 (philo-crm/philo#79, fork PR #17)
PHILO_OIDC_AGENT_CLIENT_IDS=*

# Chrome: chrome spec §3.3 (philo-crm/philo#78, in v0.7.0; ol/chrome-wiring)
PHILO_WEB_HOST_SCRIPT_URL=/oberon/philo-host.js?v=<tag>
PHILO_WEB_HOST_CONFIG={"notifyUrl":"https://notify.oberonlogistics.com","notifyResource":"https://notify.oberonlogistics.com"}
PHILO_WEB_HOST_TOKEN_RESOURCES=https://auth.oberonlogistics.com/api,https://notify.oberonlogistics.com
PHILO_WEB_ASSET_ORIGINS=https://auth.oberonlogistics.com/chrome/v1/
PHILO_WEB_CONNECT_ORIGINS=https://notify.oberonlogistics.com
```

The same rules as §5: no quotes, no comment after a value. Check that no placeholder is left (Philo's checks accept a
literal `<tag>` in the script URL):

```sh
grep -n '<' /<deploy dir>/philo-ol.env.public      # nothing
```

`*` means "any client", but only on an image that contains philo-crm/philo#79; on an older one it is a literal client
id that admits no agent. The throwaway container below proves which one the image is.

**Test the file on a throwaway container** exactly as §5 does, with the release-2 image. Then run it twice more, each
time with one `-e` added. Here the failed wait is the expected result, not a stop: read
`docker logs philo-envcheck 2>&1 | tail -5`, then `docker rm -f philo-envcheck`.

- `-e PHILO_OIDC_ADMIN_SCOPE=`: boot **fails** with `PHILO_OIDC_USER_SCOPE and PHILO_OIDC_ADMIN_SCOPE must be set
  together, or neither` (empty counts as unset; identity spec §3).
- `-e PHILO_OIDC_AUDIENCE=`: boot **fails** with `PHILO_OIDC_AGENT_CLIENT_IDS=* needs PHILO_OIDC_AUDIENCE`. That line
  is the proof the image contains #79. An older image reads `*` as a client id and fails later, on
  `PHILO_WEB_HOST_TOKEN_RESOURCES needs PHILO_OIDC_AUDIENCE`: that is the wrong image, so stop.

On the good run, the log must show
`identity:        external IdP https://auth.oberonlogistics.com (operator client philo), roles from scopes philo:user / philo:admin`,
and the Notify line as in §5. Then, before removing it:

```sh
curl -s http://127.0.0.1:<free port>/api/v1/web/config
curl -sI http://127.0.0.1:<free port>/ | grep -i '^content-security-policy'
curl -s http://127.0.0.1:<free port>/oberon/philo-host.js | grep -c 'An opt-in operator host script'
```

The web config names `/oberon/philo-host.js?v=<tag>`, the config above and both token resources. The policy has
`https://auth.oberonlogistics.com/chrome/v1/` in `script-src`, `style-src` and `font-src`, the bare
`https://auth.oberonlogistics.com` in `img-src`, `connect-src` and `frame-src`, Notify in `connect-src`, and no
`'unsafe-inline'`. The script check prints `1`.

### Release 2: rehearse role mode on a copy

Role mode has never run on production's data, so it runs once on a copy first. This is §6 again, with §1's data
rules throughout, under a new waiver in §1's terms (the maintainer gives one, with a date, or runs it). Only what
differs from §6 is written here. As in §6, there is no sign-in on the copy.

1. **Today's env**, rebuilt from the running release-1 container without its OL parts. The secret passes through
   `grep` into nothing and is never printed:
   ```sh
   . ~/philo-release2-<date>/vars.sh
   ( umask 077; docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <philo container> \
       | grep -vE '^(OL_|PHILO_OIDC_|PHILO_WEB_)' > "$D/today.env" )
   grep -cE '^(OL_|PHILO_OIDC_|PHILO_WEB_)' "$D/today.env"          # 0
   ```
   `"$D/today.env"` is "today's env file" in §6's commands.
2. **Set up the copy** with §6's block as written. Its `grep '^PHILO_OIDC_'` now picks up release 2's identity
   lines: `grep -cE '^PHILO_OIDC_(USER|ADMIN|AGENT)_SCOPE=' "$D/identity.env"` is 3, and `grep -cx 'PHILO_OIDC_AGENT_CLIENT_IDS=\*' "$D/identity.env"`
   is 1.
3. **Before the first boot**, with §6's helper and the container stopped:
   - `PRAGMA integrity_check` is `ok`;
   - `SELECT count(*), max(created_at) FROM __drizzle_migrations` is `14|1795723669355` (release 1's last, 0013; any
     other answer is a stop);
   - `SELECT count(*) FROM users` is **U0**, and `SELECT count(*) FROM users WHERE id = 1 AND role = 'admin' AND
     disabled_at IS NULL` is 1;
   - `SELECT max(role_confirmed_at) FROM users WHERE id = 1`, against `date +%s%3N`. More than 2592000000 ms (30 days)
     apart means `id=1` has lapsed (the prerequisite above): write it down and tell the maintainer.
4. **Boot `"$IMG"` with `identity.env`**, with §6's scratch-run command. The wait reports `running healthy`, and the
   boot log (`docker logs philo-scratch 2>&1 | grep -E '^  identity'`) shows
   `identity:        external IdP https://auth.oberonlogistics.com (operator client philo), roles from scopes philo:user / philo:admin`.
   With `*` set, a healthy boot on this image (#79, proven above) also confirms the audience and both scopes are in
   place.
5. **API keys answer.** With the copy running, the maintainer runs this on the host (the key stays with them):
   `curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <key>' http://127.0.0.1:<port>/api/v1/funnels`.
   Expect `200`, or `401` exactly when step 3 found `id=1` lapsed. Anything else is a stop.
6. **After stopping it:** 0014 has applied, and nothing else changed:
   - `SELECT count(*), max(created_at) FROM __drizzle_migrations` is `15|1795751123839` (0014's `when` in
     `packages/server/drizzle/meta/_journal.json`);
   - `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'account_links'` is 1, and
     `SELECT count(*) FROM account_links` is 0;
   - U0 and the `id=1` admin count are unchanged, and `PRAGMA integrity_check` is `ok`. Booting in role mode
     rewrites no role.
7. **Release 1's image boots on it**, which is what the image rollback relies on. Release 1's identity lines go in
   their own file: `grep '^PHILO_OIDC_' /<deploy dir>/philo-ol.env.public.r1 > "$D/identity-r1.env"`. Boot
   `"$R1_IMG"` with `"$D/identity-r1.env"` in place of `identity.env`. The wait reports `running healthy`, and the boot
   log's identity line ends `, one account`. After stopping it, the migration line is still `15|1795751123839` and
   `PRAGMA integrity_check` is `ok`: release 1 applied nothing and left the table alone (the image rollback below says
   why).
8. **0014's reversal works**, on the copy, with the container stopped. It is needed only on the way back to stock
   (the image rollback's last paragraph). The migration line must be `15|1795751123839`. Then:
   ```sh
   docker run --rm -v philo-scratch:/data alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -bail /data/philo.db "
     BEGIN;
     DROP TABLE account_links;
     DELETE FROM __drizzle_migrations WHERE created_at = 1795751123839;
     SELECT changes();
     COMMIT;" && chown -R 1000:1000 /data'                # expect 1
   ```
   Afterwards the migration line is `14|1795723669355`, and
   `SELECT count(*) FROM sqlite_master WHERE name LIKE 'account_links%'` is 0 (the table and both its indexes). Boot
   `"$R1_IMG"` with `identity-r1.env` once more: it turns healthy, and the migration line stays `14|1795723669355`.
9. **`id=1` stays admin on sign-in**, by the code path, since no OL Auth token reaches the copy: `id=1` is already
   bound, so its token finds it by subject (`findOrProvisionAccount` in `external-idp.ts`), and with `philo:admin`
   `confirmRole` keeps `admin` and refreshes the confirmation. Only a PWA token without `philo:admin` demotes it, which
   is why the maintainer must hold `philo-admins` first. The live check is the upgrade's steps 3 and 5.
10. **Delete the copy straight away** with §6 step 10, then `rm "$D/today.env" "$D/identity-r1.env"`.

### Release 2: the upgrade

1. Back up to a named file. This is CUTOVER §7 step 2's online backup, with release 2's directory and file name
   (production keeps running, and the online form is safe on a live database):
   ```sh
   . ~/philo-release2-<date>/vars.sh
   ( umask 077; mkdir -p "$D/prerelease2" )
   docker run --rm -v <data volume>:/data -v "$D/prerelease2":/backup alpine sh -c \
     'apk add --no-cache sqlite >/dev/null &&
      sqlite3 /data/philo.db ".backup /backup/philo-prerelease2.db" &&
      cp /data/oidc-signing-key.json /data/vapid-keys.json /backup/ &&
      sqlite3 -readonly /backup/philo-prerelease2.db "PRAGMA integrity_check; SELECT count(*), max(created_at) FROM leads;"'
   ```
   Expect `ok`, write the count to the log, and copy the three files off the host as §7 step 2 does.
2. **Swap the container**, as §7 steps 3–4 do, so there is never a second writer. Intake is down from the stop until
   the wait passes.
   - **`docker run` launch:** stop release 1's container, check it, and set it aside for the image rollback:
     ```sh
     . ~/philo-release2-<date>/vars.sh
     docker stop <philo container>
     [ "$(docker inspect --format '{{.Config.Image}}' <philo container>)" = "$R1_IMG" ] &&
       docker rename <philo container> <philo container>-r1 &&
       docker update --restart=no <philo container>-r1
     ```
     If the check fails, stop: run `docker start <philo container>` and the bounded wait, and tell the maintainer.
     Otherwise start the new container under the **original name** with release 1's launch exactly as recorded
     (§3, with §7 step 4's `--env-file /<deploy dir>/philo-ol.env`), changing only the image to `"$IMG"`. Same
     volume, ports, restart policy and network. The env file now holds release 2's lines.
   - **Compose launch:** don't rename. Copy the compose file to `compose.yaml.r1` next to it, check that release 1's
     image is still present (`docker image inspect "$R1_IMG" >/dev/null && echo ok`), and run no
     `docker image prune` until release 2 is staying. Edit only `image:` in the compose file, to the `IMG` value
     from `vars.sh` typed out, then `docker compose up -d` with the project and file recorded in §3. Compose stops
     the old container before it creates the new one.

   The first boot applies 0014 before it listens. It logs nothing for that, and a failure there fails the boot,
   with none of 0014 left behind (one transaction, as §8 R2 explains). Then the bounded wait:
   `sh "$D/wait.sh" <philo container>`. If it fails, read only
   `docker logs <philo container> 2>&1 | grep -iE 'error|config'`, under the data rules, and go to the image
   rollback below.
3. The maintainer signs in to the PWA through OL Auth. Check: the top bar shows the bell, the app switcher (with the
   Philo tile current) and the shared account menu, and not Philo's own; Server settings is reachable from the
   account menu (so `id=1` is an admin); the theme picked in the shared menu sticks after a reload; an existing API
   key answers 200 (`curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <key>'
   https://philo.oberonlogistics.com/api/v1/funnels`, or any read the key may make); `/sign-out` signs out.
4. The browser console on a signed-in page shows no `Content-Security-Policy` violation and no "Philo: the host
   script failed" line.
5. A second person from `philo-users` signs in and gets a user's view (no Server settings).
6. An agent connects: the maintainer adds Philo's `/mcp` (`https://philo.oberonlogistics.com/mcp`) to an MCP client
   that registers itself (Claude Code, for example), signs in through OL Auth, and lists leads. The `/mcp` metadata
   (`/.well-known/oauth-protected-resource/mcp`) advertises `philo:user philo:admin offline_access`.
7. `scripts/health-check.sh` and one test lead, with the maintainer's OK.

### Release 2: rollback

The image is compatible with release 1's env, so most rollbacks are an env change on the same image. Removing the
role scopes once release 2 has created accounts is the exception: it needs the account check and may need a data
step (below). Prefer the narrowest rollback that fixes the trouble.

**An env change means recreating the container.** Docker reads `--env-file` only when it creates a container, so
`docker restart` keeps the old env. Each env rollback below edits `/<deploy dir>/philo-ol.env.public`, rebuilds
`philo-ol.env` with §5's secret command, and then recreates on the same image:

- **`docker run` launch:**
  ```sh
  . ~/philo-release2-<date>/vars.sh
  docker stop <philo container>
  [ "$(docker inspect --format '{{.Config.Image}}' <philo container>)" = "$IMG" ] && docker rm <philo container>
  ```
  If the check fails, stop: that is not the container upgrade step 2 started. Otherwise start it again under the
  original name with upgrade step 2's launch (image `"$IMG"`). Leave `<philo container>-r1` alone.
- **Compose launch:** `docker compose up -d --force-recreate` with the project and file recorded in §3.

Then the bounded wait, `sh "$D/wait.sh" <philo container>`. If it fails, go to the image rollback.

- **Chrome trouble only:** remove the five chrome lines, all together (`PHILO_WEB_HOST_CONFIG`,
  `PHILO_WEB_HOST_TOKEN_RESOURCES` and `PHILO_WEB_ASSET_ORIGINS` without `PHILO_WEB_HOST_SCRIPT_URL` are a startup
  error; `PHILO_WEB_CONNECT_ORIGINS` alone is harmless but no longer needed), and recreate. Philo's own menu is back
  and the policy is release 1's.
- **Agent trouble only:** remove `PHILO_OIDC_AGENT_CLIENT_IDS` and recreate. Self-registered agents are refused from
  the next request; API keys keep working.
- **Roles trouble: fix it at OL Auth first, with the scopes still on.** Someone removed from both roles is refused
  (`insufficient_scope`) from their first token without a Philo scope, in the PWA and through agents, and their stored
  role lapses after 30 days, which is when their API keys stop. To cut someone off at once, deactivate them as
  offboarding (below) does. A wrong role is corrected by changing the OL Auth role and signing in again.
- **Roles trouble that OL Auth can't fix:** the env change removes the three `PHILO_OIDC_*_SCOPE` lines, together
  (one without the other is a startup error), and `PHILO_OIDC_AGENT_CLIENT_IDS` (`*` needs both scopes). The boot
  line then ends `, one account` again. **That alone does not shut out accounts created on release 2.** In
  one-account mode a subject that is already bound still signs in with the role stored on its account, its API keys
  keep working, scopes are ignored and the 30-day rule is off (`findOrProvisionOnlyAccount` in `external-idp.ts`,
  `hasAccess` in `access.ts`). Another `philo-admins` member would stay admin indefinitely. And one-account mode never
  promotes, so an `id=1` demoted on release 2 would leave nobody able to reach Server settings.

  So the accounts release 2 created are deactivated first, through the people API, while release 2 still runs with
  the scopes on. The `disabled_at` data step is only the fallback for when no admin can use the API. Do it in this
  order, and start the container only at the end:

  1. **Deactivate through the API**, as an admin, with the scopes still on. Run the people API's checks above first
     (`200`, then `409`); on `401` or `403`, skip to step 2 and let the account check decide. Then deactivate every
     account but `id=1` that isn't already deactivated, keeping their ids in a mode-600 file for the undo (ids only,
     never printed, never in the log):
     ```sh
     . ~/philo-release2-<date>/vars.sh
     P=https://philo.oberonlogistics.com/api/v1/users
     curl -s -H @"$D/admin-key.hdr" "$P" | jq '[.users[] | select(.id != 1 and .status != "disabled")] | length'   # N0
     ( umask 077; curl -s -H @"$D/admin-key.hdr" "$P" \
         | jq '.users[] | select(.id != 1 and .status != "disabled") | .id' > "$D/rollback-disabled.ids" )
     wc -l < "$D/rollback-disabled.ids"                                                                         # N0
     while read -r id; do
       curl -s -o /dev/null -w '%{http_code}\n' -X PATCH -H @"$D/admin-key.hdr" \
         -H 'content-type: application/json' -d '{"disabled":true}' "$P/$id"
     done < "$D/rollback-disabled.ids"                                                                          # 200, N0 times
     curl -s -H @"$D/admin-key.hdr" "$P" | jq '[.users[] | select(.id != 1 and .status != "disabled")] | length'   # 0
     ```
     Write N0 to the log. Any code but `200`, or a last count above 0, is a stop. This deletes those accounts' API
     keys and tokens for good (the people API above); the undo brings back sign-in, not the keys.
  2. **Stop.** `docker stop <philo container>` (under Compose, `docker compose stop` with §3's project and file).
     Check it is the container upgrade step 2 started:
     `docker inspect --format '{{.Config.Image}}' <philo container>` prints the `IMG` value from `vars.sh`.
     Otherwise stop and ask.
  3. **The account check**, read-only, with the container stopped:
     ```sh
     docker run --rm -v <data volume>:/data alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -readonly /data/philo.db "
       SELECT count(*) FROM users WHERE id = 1 AND role = '\''admin'\'' AND disabled_at IS NULL;
       SELECT count(*) FROM users WHERE id <> 1 AND disabled_at IS NULL;
       SELECT count(*), max(created_at) FROM __drizzle_migrations;" && chown -R 1000:1000 /data'
     ```
     Write the three lines to the log. The first is **A**, the second **N**, and the third must be
     `15|1795751123839`, release 2's last migration (anything else: stop and ask).
     - **A is 1 and N is 0:** no data step; step 1 did it all. Go to step 6.
     - **A is 0:** `id=1` was demoted, most likely by a sign-in without `philo-admins`, and step 1's API calls got
       `403`. Prefer the OL Auth fix while the scopes are still on: start the container again unchanged
       (`docker start <philo container>`, or `docker compose start`, then the bounded wait), have the maintainer add
       `philo-admins` and sign in to the PWA, which sets admin again (`confirmRole`), and then start over at step 1.
       Only if that can't be done, step 5's admin write.
     - **A is 1 and N is more than 0:** step 1 couldn't run, or missed someone. Prefer starting the container again
       unchanged and starting over at step 1. Only when no admin can use the API, step 5's disabling write.
  4. **The OK and a backup.** Step 5's writes run only with the **maintainer's OK**, and only after a fresh backup:
     upgrade step 1's block with `prerelease2` and `philo-prerelease2.db` replaced by `rollback-<HHMM>` and
     `philo-rollback-<HHMM>.db`. Expect `ok`, write the count to the log, and copy the three files off the host as
     there.
  5. **The data step, the fallback** for when no admin can use the API, with the container still stopped. Each write
     prints a count. If it prints anything other than the count named here, stop: the UPDATE has already committed,
     so restore the backup just taken (DEPLOYMENT.md § Restoring the online backup, with the container stopped), or
     ask.
     - **The admin write**, only if A is 0 and OL Auth can't fix it. It prints `1`:
       ```sh
       docker run --rm -v <data volume>:/data alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -bail /data/philo.db "
         UPDATE users SET role = '\''admin'\'' WHERE id = 1;
         SELECT changes();" && chown -R 1000:1000 /data'
       ```
     - **The disabling write**, if N is more than 0. Write down `date +%s%3N` as **T1**, run this, then write down
       `date +%s%3N` as **T2**. It prints N:
       ```sh
       docker run --rm -v <data volume>:/data alpine sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 -bail /data/philo.db "
         UPDATE users SET disabled_at = CAST(unixepoch('\''subsec'\'') * 1000 AS integer) WHERE id <> 1 AND disabled_at IS NULL;
         SELECT changes();" && chown -R 1000:1000 /data'
       ```
       `disabled_at` is milliseconds (`timestamp_ms` in `schema.ts`; migration 0013 writes `role_confirmed_at` the
       same way). `hasAccess` then refuses those accounts' sign-ins, API keys and push. Unlike the API, it deletes
       nothing, so their keys work again once it is undone. Write T1, T2 and N to the log.
  6. **The env change and the start.** Edit the env and rebuild it, as above. Then, under `docker run`,
     `docker rm <philo container>` (step 2 checked it) and start it with upgrade step 2's launch; under Compose,
     `docker compose up -d --force-recreate`. Then the bounded wait, and the boot line
     (`docker logs <philo container> 2>&1 | grep -E '^  identity'`) ends `, one account`. Delete
     `"$D/admin-key.hdr"`.

  **Undo it** once the scopes are back on (the env change reverted and the container recreated, as above), with the
  same OK:
  - **After step 1**, through the API, with the people API's checks first:
    ```sh
    . ~/philo-release2-<date>/vars.sh
    P=https://philo.oberonlogistics.com/api/v1/users
    while read -r id; do
      curl -s -o /dev/null -w '%{http_code}\n' -X PATCH -H @"$D/admin-key.hdr" \
        -H 'content-type: application/json' -d '{"disabled":false}' "$P/$id"
    done < "$D/rollback-disabled.ids"                                     # 200, N0 times
    rm "$D/rollback-disabled.ids" "$D/admin-key.hdr"
    ```
    The file holds only the accounts step 1 deactivated, so anyone offboarded (below) stays deactivated. Their sign-in
    is back, but not their API keys: tell each of them to create new ones.
  - **After step 5's disabling write**, with a new backup and the container stopped:
    `UPDATE users SET disabled_at = NULL WHERE id <> 1 AND disabled_at BETWEEN <T1> AND <T2>; SELECT changes();`
    prints N, with step 5's rule for anything else. The bounds leave out anyone offboarded before T1 or after T2.
- **The image itself fails**, or upgrade step 2's wait failed: back to release 1's image, env and container. Release
  1's image runs one-account mode too, so the accounts need the same check.
  1. **Deactivate through the API**, only if release 2 still serves signed-in requests (its wait passed, and the
     people API's checks answer `200` and `409`): the roles rollback's step 1. Otherwise skip it; step 3's data step
     is the fallback.
  2. **Stop.** `docker stop <philo container>` (under Compose, `docker compose stop`). This also stops a
     crash-looping container.
  3. **The roles rollback's steps 3 to 5**: the account check, then, if needed, the OK, a backup and the data step.
     The migration line decides first. Drizzle runs a boot's pending migrations in one transaction (§8 R2), so a
     failed boot leaves all of 0014 or none of it:
     - **`15|1795751123839`:** 0014 applied. Release 1's image runs on it as it is (below): no reversal.
     - **`14|1795723669355`:** 0014 never committed; release 2's first boot failed before it. Nothing to reverse.
     - **Anything else:** stop and ask.

     If A is 0, the OL Auth fix needs release 2 to boot; if it doesn't, use the admin write. If the wait in upgrade
     step 2 failed, nobody signed in on release 2, and the check should find A 1 and N 0.
  4. **Release 1's env files** back, from the copies:
     ```sh
     . ~/philo-release2-<date>/vars.sh
     install -m 600 -p /<deploy dir>/philo-ol.env.public.r1 /<deploy dir>/philo-ol.env.public
     ```
     Rebuild `philo-ol.env` from it with §5's secret command, then
     `cmp -s /<deploy dir>/philo-ol.env /<deploy dir>/philo-ol.env.r1 && echo same` prints `same`. If it doesn't,
     the secret has changed since release 1 (`<philo container>-r1` still holds the old one): stop and tell the
     maintainer.
  5. **Release 1's container** back:
     - **`docker run` launch:** check both names, then swap them back:
       ```sh
       . ~/philo-release2-<date>/vars.sh
       [ "$(docker inspect --format '{{.Config.Image}}' <philo container>)" = "$IMG" ] && docker rm <philo container>
       [ "$(docker inspect --format '{{.Config.Image}}' <philo container>-r1)" = "$R1_IMG" ] &&
         docker rename <philo container>-r1 <philo container> &&
         docker update --restart=<the policy recorded in §3> <philo container> &&
         docker start <philo container>
       ```
       If either check fails, stop.
     - **Compose launch:** put `compose.yaml.r1` back in place of the compose file and `docker compose up -d` with
       the project and file recorded in §3.

     Then the bounded wait, `sh "$D/wait.sh" <philo container>`. Check that
     `docker inspect --format '{{.Config.Image}}' <philo container>` prints the `R1_IMG` value and that the boot line
     ends `, one account`. If the wait fails, stop and tell the maintainer.

  **Why release 1's image needs no reversal.** Both images ship `drizzle-orm` 0.45.2. Its migrator
  (`SQLiteSyncDialect.migrate`) reads only the newest `__drizzle_migrations` row and applies each migration whose
  `when` is later than that row's `created_at`. Release 1's newest migration (0013, `1795723669355`) is earlier than
  0014's row (`1795751123839`), so release 1 applies nothing and touches neither the row nor `account_links`. Its other
  boot checks pass too: the migration count only decides the one-time VACUUM (`before < 10`), and
  `PRAGMA foreign_key_check` stays clean because nothing in release 1 deletes a user, the only row `account_links`
  points to. The rehearsal's step 7 runs this on production's data. Leave the table and the row in place. If release 2
  is tried again later, it finds 0014 applied and applies nothing.

  **Further back, to stock 0.5.1**, only if release 1's image fails too. That is §8 R2, and its checks expect release
  1's state, so 0014 goes first. With the container stopped and a fresh backup taken (upgrade step 1's block, with
  `rollback-<HHMM>`), the migration line must be `15|1795751123839`. Run the rehearsal's step 8 reversal with
  `-v <data volume>:/data` in place of `-v philo-scratch:/data`. It prints `1`, and the migration line is then
  `14|1795723669355`. Then §8 R2 from its step 3, which reverses 0013. Its "more than 1 user: stop and ask" applies,
  and after release 2 it is the likely answer. `account_links` holds nothing worth keeping under OL Auth: invite and
  reset links are refused there (`managed_by_idp`).

Then the upgrade's steps 3, 4 and 7 again: expecting Philo's own menu after a chrome, roles or image rollback, and the
shared chrome still after an agent-only one.

### Release 2: offboarding

To remove someone, an admin deactivates them through the people API, and the maintainer removes their roles at OL
Auth. Deactivation is immediate. It deletes their API keys and Philo-issued tokens, and refuses their OL Auth tokens
from the next request (the people API above). Philo keeps running, and intake isn't touched. Run the people API's
checks first, then:

```sh
. ~/philo-release2-<date>/vars.sh
P=https://philo.oberonlogistics.com/api/v1/users
E='<their address>'
F='[.users[] | select((.email | ascii_downcase) == ($e | ascii_downcase) and .id != 1)]'
curl -s -H @"$D/admin-key.hdr" "$P" | jq --arg e "$E" "$F | length"                          # 1
id=$(curl -s -H @"$D/admin-key.hdr" "$P" | jq --arg e "$E" "$F | .[0].id")
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH -H @"$D/admin-key.hdr" \
  -H 'content-type: application/json' -d '{"disabled":true}' "$P/$id"                         # 200
curl -s -H @"$D/admin-key.hdr" "$P" | jq --arg e "$E" "$F | map(select(.status == \"disabled\")) | length"   # 1
unset E id; rm "$D/admin-key.hdr"
```

A first count of 0 means no such account (or it is `id=1`, which can't deactivate itself): stop. Any code but `200`,
or a last count that isn't 1, is a stop. Write down `date +%s%3N` in the log as the offboarding time, not the
address (no row content in the log). Undo, if it was a mistake: the same `PATCH` with `{"disabled":false}`. That
restores sign-in, not the deleted keys.

**Only if no admin can use the API**, the data step instead. Intake is down from step 1 to step 4:

1. **Stop**, as the roles rollback's step 2 does.
2. **The OK and a backup**, as its step 4 does.
3. **The write.** Write down `date +%s%3N` in the log as the offboarding time. Run step 5's disabling write with
   `WHERE email = '<their address, in lower case>' AND id <> 1 AND disabled_at IS NULL` in place of its `WHERE`.
   `SELECT changes()` must print 1, with step 5's rule for anything else. Unlike the API, this deletes nothing: their
   keys stay in the database, refused by `hasAccess` while `disabled_at` is set. A later `PATCH` with
   `{"disabled":true}` doesn't delete them either, because the account is already deactivated. **Any reactivation,
   the API's `{"disabled":false}` included, brings those keys back.** Write that in the log next to the time.
4. **Start it again unchanged**: `docker start <philo container>` (under Compose, `docker compose start`), then the
   bounded wait.
