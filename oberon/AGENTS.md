# Oberon Logistics fork of Philo: agent guide

This repository, `oberonlogistics/philo`, is Oberon Logistics' fork of the open-source CRM
[`philo-crm/philo`](https://github.com/philo-crm/philo). Its `main` is upstream Philo plus a thin
Oberon layer: the shared chrome from `oberonlogistics-common`, sign-in through OL Auth, and the
shared notification feed in `oberonlogistics-notify`.

Read the upstream guide ([`AGENTS.md`](../AGENTS.md)) for the product, scope guardrails,
schema rules and the shippability bar. **Where the two disagree, this file wins.** It replaces
upstream's "Sync with origin", merge bar, release workflow and versioning sections.

## Remotes and branches

| Remote | Repository | Notes |
|---|---|---|
| `origin` | `oberonlogistics/philo` (public, a GitHub fork) | Everything we push goes here, contribution branches included |
| `upstream` | `philo-crm/philo` (public, AGPL-3.0) | Read-only for us: fetch from it, open PRs against it, never push to it |

| Branch | Base | Merges into | Holds |
|---|---|---|---|
| `main` (default) | — | — | Upstream plus the Oberon layer. What we build, tag and deploy. |
| `ol/<slug>` | `origin/main` | `origin/main` by fork PR | An Oberon-only change |
| `up/<slug>` | `upstream/main` | `philo-crm/philo:main` by PR from the fork | A change any Philo operator could use |
| `sync/upstream-<yyyy-mm-dd>` | `origin/main` | `origin/main` by fork PR, **merge commit only** | Bringing upstream into the fork |

Setting up a fresh clone:

```sh
git clone https://github.com/oberonlogistics/philo.git oberonlogistics-philo
cd oberonlogistics-philo
git remote add upstream https://github.com/philo-crm/philo.git
git fetch upstream --tags
```

## Where a change goes

Ask whether a Philo operator who has never heard of Oberon would want it.

- **Yes → `up/<slug>`.** Examples: a bug fix, a missing external-OIDC capability, a generic
  extension point (a slot for host chrome, a configurable theme stylesheet, a notification sink
  interface), a CI guard that lets forks run without upstream's secrets.
- **No → `ol/<slug>`.** Examples: loading `ol-chrome.js`, OL Auth client ids and scopes, the OL
  Notify adapter, the Oberon brand, deployment.
- **Both → split it.** First add the generic extension point upstream, then make a small `ol/`
  change that uses it. A big `ol/` patch to upstream files is the last resort, because every
  upstream sync has to carry it.

Keep the Oberon layer thin and in its own files: `oberon/` for docs, scripts and deploy, and new
modules that only register through extension points. Every line that edits an upstream file is
a future merge conflict, so record each one in the table below.

### Upstream files the Oberon layer edits

| File | Why | Can an upstream extension point remove it? |
|---|---|---|
| `AGENTS.md`, `CLAUDE.md` | The pointer to this guide, two lines at the top | No; keep it to those two lines |

## Worktrees

The primary checkout stays on `main`. Allowed there: `git fetch`, `git pull --ff-only`, and
reading. All work happens in `.claude/worktrees/<slug>/`, which upstream already ignores:

```sh
git fetch origin upstream
git worktree add -b ol/<slug> .claude/worktrees/<slug> origin/main      # Oberon change
git worktree add -b up/<slug> .claude/worktrees/<slug> upstream/main    # contribution
```

Each worktree needs its own `npm ci`. Upstream's sync ritual (`git checkout main` in the primary
checkout) does not apply. Remove a worktree with `git worktree remove` once its PR merges, and
only remove worktrees you made.

**Ports.** Dev servers default to `:3000` (API) and `:5173` (Vite), and other agents share this
machine. Give every worktree its own `PHILO_PORT` and Vite port, and never stop a server you did not
start. Most tests use `app.request()` and need no port.

## Commits

Every commit, in every branch, follows upstream's rules, so any of them can go upstream later:

- A conventional prefix: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`.
- `git commit -s`. DCO runs on every PR in both repositories, and the sign-off must match the
  author identity.
- Stage explicit paths and never use `git add -A`. Read `git status` again right before you
  commit.

## Flows

### An Oberon change (`ol/<slug>`)

1. Make a worktree from `origin/main` and write the test first.
2. Run `oberon/scripts/verify.sh`, which is upstream's test, typecheck, lint and build.
3. Push to `origin` and open a PR into `oberonlogistics/philo:main`.
4. The PR merges once the [fork merge bar](#merge-bars) is met. Squash-merging is fine.

### A contribution (`up/<slug>`)

1. Make a worktree from `upstream/main`, never from `origin/main`. It must contain no Oberon
   commit.
2. Follow upstream's rules in full: no real-world names (no Oberon, no OL service names, no
   `oberonlogistics.com`; use `example.com`), an ADR if it contests one, and an SDK change in
   the same PR as an API shape change.
3. Run `oberon/scripts/verify.sh` and `oberon/scripts/check-upstreamable.sh`. Both must pass.
   Run the check from an `ol/` checkout, or with `git show origin/main:oberon/scripts/check-upstreamable.sh | bash`,
   because an `up/` branch has no `oberon/` directory.
4. Push to `origin` and open the PR against upstream from the fork:
   `gh pr create -R philo-crm/philo --head oberonlogistics:up/<slug> --base main`.
5. Bugbot does not run on fork PRs, so upstream needs a human review. Get the PR to green CI and
   a clean independent review, then **ask the maintainer to review and merge it. Never merge an
   upstream PR yourself.**
6. Once it merges, the change reaches the fork with the next upstream sync. Delete `up/<slug>`
   from `origin`.

**When Oberon can't wait** for upstream to merge, open a fork PR titled
`chore: land up/<slug> early (philo-crm/philo#N)` that merges the `up/` branch into `main` with
a merge commit. Upstream squash-merges, so when the next sync brings in the same change it
usually merges cleanly. If the upstream review changed the code, the sync takes upstream's version.

### Upstream sync (`sync/upstream-<date>`)

Sync after each upstream release, before a deploy, and after an upstream merge we are waiting for.

```sh
git fetch origin upstream --tags
git worktree add -b sync/upstream-$(date +%F) .claude/worktrees/sync-$(date +%F) origin/main
cd .claude/worktrees/sync-$(date +%F)
git merge --no-ff --signoff upstream/main -m "chore: merge upstream philo-crm/philo $(git rev-parse --short upstream/main)"
```

Resolve each conflict in favour of upstream's intent, then put the Oberon behaviour back on top.
List every conflict in the PR body. Run `verify.sh`, open the fork PR, and merge it with
**"Create a merge commit"**. Never squash or rebase a sync. A squashed sync loses the shared
ancestry, and every later sync then conflicts on the same lines again.

Never rebase `main`, and never force-push `main` or any branch someone else may hold.

## Merge bars

| PR into | Merges when, on its tip commit | Who merges |
|---|---|---|
| `oberonlogistics/philo:main` | Fork CI green (test, typecheck, lint, build, container boot, DCO); an independent reviewer with no blocking findings, per upstream's triage rules; a sync PR also lists its resolved conflicts | The orchestrator may merge it |
| `philo-crm/philo:main` | Upstream CI green; an independent reviewer with no blocking findings; `check-upstreamable.sh` passes | **The maintainer only** |

Upstream's two-iteration review cap applies. If the second review still finds blockers, stop and
escalate. Bugbot is not configured in the fork, because it has no `CLAUDE_CODE_OAUTH_TOKEN` or
`BUGBOT_GH_TOKEN`. Until it is, a fork PR shows a failing or skipped Bugbot check; that check is
not part of the fork merge bar.

## Versions and releases

- Never change the root `package.json` `version`. Upstream's `/cut-release` owns it, and syncs
  bring it in.
- Tag a fork release on `main` as `ol-v<upstream version>-<n>`, for example `ol-v0.5.1-1`. The
  `ol-` prefix keeps upstream's `v*` tag trigger from firing.
- Production at `https://philo.oberonlogistics.com` runs the stock upstream image on its own host.
  The plan to move it is [`DEPLOY.md`](DEPLOY.md). It has open decisions, so change nothing in
  production until a human has settled them.

## Integration contracts (sibling repositories)

Under `~/src/oberonlogistics/`:

| Need | Read |
|---|---|
| Sign-in, tokens, scopes, client registration | `oberonlogistics-auth/docs/integration.md` (§2, §4–§9; §12 for a resource server) |
| Chrome embedding, design language | `oberonlogistics-common/DESIGN.md` §5–§7, `packages/chrome/README.md` |
| Notification feed, bridges, post-as | `oberonlogistics-notify/docs/SPEC.md` (§3, §4, §6, §7) |
| A finished app integrated with all three | `oberonlogistics-handbook/docs/deployment.md` |
| Philo's external IdP support | `docs/DEPLOYMENT.md` (External identity provider), `docs/adr/0005`, `0006`, `0007` |
| Philo's change feed and webhooks | `docs/adr/0010`, `0011` |

## This repository is public

- Never commit secrets, `.env` files, customer or lead data, or internal-only hostnames.
- `oberonlogistics-common` is **private**. Do not vendor its files here. Load the chrome, tokens,
  fonts and icons at runtime from OL Auth (`https://auth.oberonlogistics.com/chrome/v1/…`), as
  `DESIGN.md` §5.2 shows. Copy a brand image into this repository only when it is already public
  on the Oberon Logistics website, and say so in the PR.
- Fork issues and PRs are public. Do not put customer details in them.
- Philo is AGPL-3.0. The fork stays public, so the source of what we run is always available to
  its users.
