# Shared chrome in Philo: integration spec

Status: proposal, revised 2026-11-26. UP-1 (the CSP) is in progress as `up/pwa-csp`; UP-2 to UP-4 and the Oberon
wiring are design only. The landing order of these PRs with the identity and notification work is in
[`identity.md` §2.1](identity.md#21-landing-order-for-all-three-fork-specs). Branch `ol/spec-chrome`.

**Goal.** Every signed-in Philo page shows the shared Oberon Logistics chrome at the right of its top bar:
`<ol-notifications>` (the shared bell), `<ol-app-switcher current="…">` and `<ol-account-menu>`. The chrome loads at
runtime from OL Auth (`https://auth.oberonlogistics.com/chrome/v1/ol-chrome.js`, `tokens.css`, `fonts.css`). The theme
comes from the person's OL Auth account (`GET /api/v1/me`). The chrome needs a second token
(`auth:apps auth:account`, audience `https://auth.oberonlogistics.com/api`) and a Notify token (`notify:read`), and the
PWA's CSP has to allow all of it.

**Approach.** Philo gets a small, vendor-neutral seam upstream: an operator-supplied *host script* that the PWA loads,
plus a slot in the top bar, a token hook and a CSP that the operator can extend. The Oberon layer is then one script
and one stylesheet in `oberon/web/`, plus environment values. No upstream file is edited.

**Hard rule.** `oberonlogistics-common` is private. Nothing from it is copied into this repository. The chrome, tokens,
fonts and icons always load from OL Auth at runtime (`oberon/AGENTS.md`, "This repository is public").

Sources read: common `DESIGN.md` §2.2, §5–§8 and `packages/chrome/` (element API); OL Auth `docs/integration.md` §4
("`prompt` and sessions") and §9 ("The shared chrome"); Notify `docs/SPEC.md` §2; Handbook `packages/pwa/src/chrome.ts`,
`session.ts` and `packages/server/src/pwa-document.ts`; Philo as cited below. Upstream `philo-crm/philo` had no issue or
PR about a CSP, theming, embedding, host chrome or extra tokens before this work (checked 2026-11-26). The SDK's
`resource` and `prompt` come from philo-crm/philo#61 (identity ID-U3).

---

## 1. Philo today

### 1.1 Top bar

- The bar is `<header className="topbar">` in `apps/web/src/AppShell.tsx:137-160`: the wordmark (`:138`), the tabs
  Leads / Board / Spam (`:141-151`), then `.topbar-actions` (`:152-159`) with `FunnelSwitcher`, *New lead* and
  `AccountMenu`.
- `AccountMenu` (`apps/web/src/AccountMenu.tsx:24-80`) is Philo's own popover. It shows initials, name and email
  (`:37-40`), a Light / Dark / System picker (`:42-57`), *Server settings* and *Install the app* (`:59-64`), and
  *Sign out* (`:66-75`).
- Philo has no bell. New leads reach the person through web push or the in-app live stream (`AppShell.tsx:106-117`,
  `push.ts`), both of which raise system notifications.
- Layout: `index.css:375-386` (`.topbar`, sticky, `--topbar-height` 3.25 rem) and `:423-428` (`.topbar-actions`,
  `margin-left: auto`). Below 760 px the tabs move to a row of their own and the actions keep the bar (`:1638-1680`).
  The funnel switcher is capped at 10 rem there, and *New lead* turns into an icon.

### 1.2 Theme

- `apps/web/src/theme.ts`: `light | dark | system`, stored per browser in `localStorage["philo.theme"]` (`:8`).
  `applyTheme` sets `<html data-theme>`, and *system* removes the attribute (`:29-39`). It also rewrites the two
  `<meta name="theme-color">` tags (`index.html:20-21`) to the top bar's surface colour (`theme.ts:42`).
- It is applied before the first paint (`main.tsx:9`).
- CSS: Philo's own variables (`--bg`, `--surface`, `--text`, `--accent`, …, `index.css:12-43`), redefined for dark
  under `:root[data-theme='dark']` (`:54`) and `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])`
  (`:76-77`).
- **This is the same model as OL's §2.2**: the `data-theme` attribute, *system* as no attribute, and a localStorage copy
  for first paint. Only the key and the variable names differ, which makes the integration simple.

### 1.3 CSP and security headers

- **The PWA has no CSP.** The only CSP in the codebase is the attachment download sandbox
  (`packages/server/src/leads/routes.ts:302-303`). Nothing sets `frame-ancestors`, `X-Content-Type-Options` or
  `Referrer-Policy` on the shell.
- The single-container shape (`apps/standalone/src/app.ts`, ADR-0006) serves the built PWA with `serveStatic` (`:96`)
  and hands back `index.html` for every client route (`:98-104`). Its only header middleware sets `Cache-Control`
  (`:72-88`). When the PWA runs apart, any static host serves it, and that host's headers apply (`DEPLOYMENT.md`,
  "Running the pieces apart").
- **ADR-0006 already counts on a CSP.** It keeps the refresh token in `localStorage` and says "the CSP and the absence of
  third-party script are what bound it" (`docs/adr/0006-headless-server-sdk-clients.md:108-111`). That CSP does not
  exist. Both halves of that sentence matter to this spec (§2.1, §2.3).
- The app has no `style={…}` attributes in its DOM (the one `style=` match, `IntakeDetails.tsx:13`, is text in an
  embed snippet), so `style-src 'self'` is reachable. The exception is the email-template preview
  (`EmailTemplates.tsx:248`), an `<iframe srcDoc>` that would inherit the shell's CSP and lose a template's inline
  styles and images. UP-1 handles it.

### 1.4 Tokens

- `apps/web/src/auth.ts:73-79`: `GET /api/v1/auth/config` → OIDC discovery → `TokenSession` (`@philo/sdk`). The access
  token stays in memory and the refresh token goes in `localStorage["philo.refresh-token"]`.
- `packages/sdk/src/oidc.ts:94-110` `createAuthorizationRequest` takes only `scope`. It has **no `resource`
  (RFC 8707) and no `prompt`**, and OL Auth needs `resource` to set a token's audience. philo-crm/philo#61 adds both.
- The sign-in config comes from `packages/server/src/app.ts:101-106`. With an external IdP the scope is fixed at
  `openid email profile` (the identity spec, `ol/spec-auth`, changes that).
- There is one callback path, `/auth/callback` (`auth.ts:25`, `packages/server/src/oauth/first-party.ts:13`), and
  `App.tsx:47-55` treats any load of it as the end of a full-page sign-in. A hidden frame landing there today would
  fail with `no_pending_authorization`.
- Nothing in the PWA can get a token for a second audience.

### 1.5 Service worker and caching

- `apps/web/src/sw.js:43` ignores every cross-origin request, so `ol-chrome.js`, `tokens.css` and the fonts would go
  through the HTTP cache only (OL Auth: 1 h, `ETag`). The SW never caches them.
- Navigations are network-first with the cached shell as the fallback (`:47-50`), and only `/assets/*` is cached
  (`:54-56`). Offline, the shell paints but the API, and with it the whole signed-in app, does not work.

---

## 2. Generic upstream seams (`up/` PRs)

There are four PRs, in this order (and in the combined order of
[`identity.md` §2.1](identity.md#21-landing-order-for-all-three-fork-specs)). Each is described as upstream would read it: no Oberon, no OL service names,
`example.com` only. "Env" and "DB" follow `DEPLOYMENT.md` "Configuration": anything a process needs before it can serve,
or anything that is security policy, is env. Here that is all of it: a script URL is code execution, and CSP origins are
security policy. **Nothing here goes in the settings DB.**

### UP-1 `feat(standalone): a Content-Security-Policy for the PWA shell` (`up/pwa-csp`, in progress)

This implements the CSP that ADR-0006 already relies on, so it needs **no new ADR**. It is useful by itself, and the
other PRs extend it.

- Where: `apps/standalone` adds a header middleware next to the `Cache-Control` one. It applies to every PWA response
  (shell, client routes, `/sw.js`, `/manifest.webmanifest`, `/assets/*`), never to server or MCP paths, and never over a
  header a handler already set (the same rule as `app.ts:74-77`).
- Default policy:

  ```
  default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
  connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self'; object-src 'none';
  base-uri 'self'; form-action 'self'; frame-ancestors 'none'
  ```

  With `PHILO_OIDC_ISSUER` set, the issuer's origin is added to `connect-src` (discovery and the token endpoint).
  `PHILO_WEB_CONNECT_ORIGINS` (comma-separated `https:` origins) adds more to `connect-src`; this PR owns it. It also
  adds `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
- **The email-template preview** moves to a page the server serves, `/api/email-preview`, with a policy of its own, and
  the PWA frames it (`frame-src 'self'`). A template's inline styles and images keep rendering, which a `srcdoc` frame
  under the shell's policy would lose.
- `DEPLOYMENT.md`: a "Content-Security-Policy" section with the policy to copy when the PWA is served by another host.
- Tests (`apps/standalone/test`): the shell, a client route and `/sw.js` carry the policy, while `/api/*`, `/oauth/*`,
  `/mcp`, the attachment download and the email preview keep their own headers. With an external issuer, its origin is
  in `connect-src`. A styled template still previews styled. A build test checks that `dist/index.html` has no inline
  `<script>` or `style` attribute, so the policy cannot silently break the app.

### UP-2 `feat(sdk,web): ask the IdP for an extra token in a hidden frame`

This is silent authorization for a second audience. **It depends on philo-crm/philo#61** (identity ID-U3), which owns
the SDK half: `resource?: readonly string[]` and `prompt?: string` on `createAuthorizationRequest`, `resource` on
`exchangeCode`, and the RFC 9207 `iss` check. UP-2 adds no SDK option of its own. It also needs UP-1 (the CSP it
extends).

- Web (`apps/web/src/extra-token.ts`, new): `getExtraToken({ resource, scope, prompt? }): Promise<string | null>`.
  - It builds an authorization request with the PWA's own client id and its one redirect URI (`/auth/callback`), so the
    operator registers nothing new. It opens it in a hidden `<iframe>` and keeps the PKCE verifier and state in memory.
  - In the frame, `/auth/callback` sees `window.parent !== window` and a state it does not own, so it posts
    `{ type: "philo:silent-callback", url }` to `window.parent` with the target origin set to its own origin, and stops
    before React mounts. That check goes in `main.tsx` ahead of `createRoot`, so `App.tsx`'s full-page callback logic
    never runs in the frame.
  - The parent checks the message origin, that `event.source` is the frame's `contentWindow`, and the state. It
    exchanges the code through the SDK's `exchangeCode`, so the `iss` check applies (and the nonce check, when an ID
    token comes back). It removes the frame and caches the access token in memory for each `(resource, scope)` until 30 s before `exp`. A refresh token the IdP returns is
    **discarded**: it would widen what `localStorage` holds.
  - It returns `null`, never throws, on an OAuth error, a 10 s timeout (the IdP wanted to show a page), the built-in IdP
    (which has only Philo's own resource), or no external IdP. A refusal is not retried until the next sign-in. Only one
    request per key runs at a time.
  - It omits `prompt` by default, and the caller may pass one. Some IdPs answer a hidden first request only *without*
    `prompt=none`, and others only *with* it, so the caller picks.
- UP-1's `frame-src 'self'` gains the issuer's origin in external-IdP mode. `/auth/callback` alone gets
  `frame-ancestors 'self'`, and every other path keeps `'none'`.
- `DEPLOYMENT.md`: a hidden frame needs the IdP's session cookie, so it works only when the IdP and the PWA are
  **same-site**, or the browser allows third-party cookies. The PWA keeps working without it, and the extra token is
  just `null`.
- Tests: web tests with jsdom and a fake frame: the happy path, a state mismatch, a wrong-origin message, a message
  from another window, an `iss` mismatch, the timeout giving `null`, the cache reused until near `exp`, concurrent callers
  sharing one request, no retry after a refusal, and the refresh token not stored. A `main.tsx` test checks that a framed
  callback posts and does not render. A standalone test checks `frame-ancestors` per path.
- ADR: none by itself, because no token goes to anyone else yet. It is useless without UP-3, but it is small and easy to
  review on its own, so it stays separate.

### UP-3 `feat(web): an operator host script with a top-bar slot`

**This contests ADR-0006** ("the absence of third-party script"), so the PR carries **ADR-0013 "Operator host script in
the PWA"** (ADR-0012 is several users with roles, philo-crm/philo#66). The ADR argues:

- It is opt-in. With the variable unset, nothing loads and the default CSP stays `'self'`.
- The operator who sets it trusts that script as much as Philo's own code. It runs in the page and could read
  `localStorage`, and the ADR says so plainly rather than pretending to sandbox it.
- The recommended shape is a **same-origin** script that the operator ships beside the PWA. When that script loads
  something cross-origin, the operator lists that origin explicitly (UP-4).
- Alternatives rejected: an `<iframe>` chrome (popovers can't leave the frame, theming can't cross it, and it costs a
  second app load), and forking the top bar (a merge conflict on every upstream sync).

Config, all env and read by the server:

| Variable | Default | Meaning |
|---|---|---|
| `PHILO_WEB_HOST_SCRIPT_URL` | unset | A script the PWA loads after sign-in. Absolute, or a path on the PWA's origin. |
| `PHILO_WEB_HOST_CONFIG` | `{}` | JSON handed to the script verbatim (`ctx.config`). It is public: anyone can read it, so no secrets. |

Delivery: a public `GET /api/v1/web/config` → `{ hostScriptUrl: string | null, hostConfig: object }`, with
`Cache-Control: no-cache`. The SDK gets `philo.web.config()` and its type in the same PR (ADR-0006: a shape change is an
SDK change). A new endpoint keeps `auth/config` about sign-in only, and it works when the PWA is hosted apart.

The contract (`apps/web/src/host.ts`, documented in `docs/DESIGN.md` under a new "Host chrome" heading):

```ts
/** The host script sets this global when it runs. The PWA loads the script once per page, after sign-in. */
interface PhiloHost {
  mount(ctx: PhiloHostContext): PhiloHostMount | void | Promise<PhiloHostMount | void>
}
interface PhiloHostMount {
  /** Philo controls the host now draws instead. Today only the account menu. */
  replaces?: ReadonlyArray<'account-menu'>
}
interface PhiloHostContext {
  version: 1
  /** An empty element at the right end of `.topbar-actions`, after New lead. Owned by the host until `signal` aborts. */
  slot: HTMLElement
  /** The IdP the PWA signs in with: the same values as GET /api/v1/auth/config. */
  issuer: string
  clientId: string
  user: { email: string; name: string | null }
  /** PHILO_WEB_HOST_CONFIG. */
  config: unknown
  /** UP-2. null when there is no external IdP, or when it refused. */
  getToken(request: { resource: string; scope: string; prompt?: string }): Promise<string | null>
  /** Client-side navigation inside Philo (the router's navigate). */
  navigate(path: string): void
  /** Philo's own sign-out (App.tsx handleSignOut). */
  signOut(): void
  /** Philo's own theme store (theme.ts setTheme): writes philo.theme, data-theme and theme-color. */
  setTheme(theme: 'light' | 'dark' | 'system'): void
  /** Philo's own account-menu entries for this person's role (Server settings only for an admin, ADR-0012). */
  accountItems: ReadonlyArray<{ label: string; path: string }>
  /** Aborted when the signed-in shell unmounts (sign-out, session expired). */
  signal: AbortSignal
}
```

Behaviour:

- The PWA injects `<script src=hostScriptUrl>` (classic, `async`) once, when `AppShell` first mounts. When it loads, it
  calls `window.PhiloHost.mount(ctx)`. It never loads the script on signed-out screens.
- **Philo's own controls stay up until the host takes over.** `AccountMenu` renders as today and is hidden only after
  `mount` resolves with `replaces: ['account-menu']`. If the script fails to load, sets no `PhiloHost`, throws, or
  takes longer than 5 s, Philo logs once to the console and keeps its own menu. A host can never leave the person
  without a way to sign out, and offline the shell looks exactly as it does today.
- *Server settings* and *Install the app* move into `accountItems` when the host replaces the menu, so nothing Philo
  offers is lost. Philo's theme picker goes away with its menu, because the host owns the theme from then on (it calls
  `setTheme`).
- The slot is part of `.topbar-actions`, so it inherits its gap and its narrow-screen layout. CSS: `.host-slot
  { display: flex; align-items: center; gap: inherit }`.
- Tests (`apps/web/test/host.test.tsx`, jsdom, a fake host script served by the test): no variable means no script tag
  and Philo's menu as today; mount receives the documented `ctx` with the slot in the DOM; `replaces` hides Philo's
  menu; a failed load, a throw or a timeout keeps it; `navigate`, `signOut` and `setTheme` reach the real store and
  router; `signal` aborts on sign-out; the script is not loaded again on re-render or route change; and it never loads
  on the signed-out or callback screens. Server: `GET /api/v1/web/config` is public, and a bad
  `PHILO_WEB_HOST_CONFIG` JSON or URL is a startup `ConfigError`, not a silent default.

### UP-4 `feat(standalone): extra CSP sources for a host script`

This could fold into UP-3. It is kept apart because it is pure security config and a reviewer should see it alone.
`PHILO_WEB_CONNECT_ORIGINS` is already in UP-1, so only one variable is left.

| Variable | Default | Added to |
|---|---|---|
| `PHILO_WEB_ASSET_ORIGINS` | empty | `script-src`, `style-src`, `font-src` as given; `img-src` as the entry's origin |

- Comma-separated. Each entry is an `https:` origin **plus an optional path prefix** ending in `/` (or
  `http://localhost` and `http://127.0.0.1` for development), with no query, wildcard or keyword (`'unsafe-inline'`,
  `*`, `data:`). Anything else is a startup `ConfigError`. A path prefix keeps `script-src` off the rest of that origin,
  for example an IdP's upload storage on the same host; ADR-0006 counts on this CSP to keep the `localStorage` refresh
  token out of reach. The origin of an absolute `PHILO_WEB_HOST_SCRIPT_URL` is added to `script-src` automatically.
- Tests: the values reach the right directives, a path prefix stays a path in `script-src` and becomes the origin in
  `img-src`, a keyword or wildcard is refused at startup, and an unset variable leaves UP-1's policy unchanged.

**Not proposed.** An operator brand name or logo seam: the wordmark stays *Philo*, which is the app's tile name too.
A theme stylesheet URL: the host script can add a `<link>` itself, and one fewer variable is better. Both can come
later if another operator asks for them.

---

## 3. Oberon wiring (`ol/`)

All of it lives in new files under `oberon/` and in environment values. **No upstream file changes**, so the table
in `oberon/AGENTS.md` doesn't grow. The fork builds its own image from a new `oberon/Dockerfile` (proposed here, shared
with the notifications module), which runs upstream's build and adds the Oberon files. Upstream's `Dockerfile` stays
unedited.

### 3.1 Files

| File | What it is |
|---|---|
| `oberon/web/philo-host.js` | The host script (§3.2). Framework-free, a classic script with no build step, about 310 lines. |
| `oberon/web/philo-ol.css` | Maps Philo's CSS variables onto `--ol-*` tokens (§4). |
| `oberon/web/test/*.test.ts` | Tests against a stub chrome (§6). Run by `oberon/scripts/verify.sh`. |
| `oberon/Dockerfile` | Copies `oberon/web/*.js` and `*.css` into `apps/web/dist/oberon/` so they're served same-origin at `/oberon/…`. `oberon/DEPLOY.md`, not yet written, carries the env. |

### 3.2 `philo-host.js`

```js
window.PhiloHost = { async mount(ctx) { … } }
```

It does the following, in order:

1. Adds `<link rel=stylesheet>` for `${ctx.issuer}/chrome/v1/tokens.css`, `${ctx.issuer}/chrome/v1/fonts.css` and
   `/oberon/philo-ol.css` (in that order, so the mapping sees the tokens). Then it loads
   `${ctx.issuer}/chrome/v1/ol-chrome.js` with `data-issuer` and `data-defer-config`, the same way as Handbook's
   `loadChromeScript`.
2. Fills `ctx.slot` with:
   - `<ol-notifications>`, and only when `ctx.config.notifyUrl` is set.
   - `<ol-app-switcher current="${ctx.clientId}">`. The tile's client id is Philo's OL Auth public client, the same value
     as `PHILO_OIDC_CLIENT_ID`: `philo` (`identity.md` §5).
   - `<ol-account-menu>` with one `<a slot="item">` for each of `ctx.accountItems`. A click calls `preventDefault()` and
     then `ctx.navigate(path)`. It gets `compact` below 760 px through a `matchMedia` listener.
3. Calls `OLChrome.configure({ notifyUrl, getToken, onSignOut })`:
   - `getToken({audience})`: `"auth"` → `ctx.getToken({ resource: \`${ctx.issuer}/api\`, scope: "auth:apps auth:account" })`.
     `"notify"` → `ctx.getToken({ resource: ctx.config.notifyResource, scope: "notify:read" })`. Anything else → `null`.
     No `prompt`: OL Auth answers the first request for a new audience only without it (integration.md §4). Handbook
     does the same (`session.ts` `secondTokenArgs`). `prompt=none` is wrong for the first request.
   - `onSignOut`: `ctx.signOut()`. Philo's sign-out also ends the OL Auth session (`identity.md` ID-U7), so the
     chrome's menu and Philo's do the same thing.
4. **Theme sync** (§4): it watches `document.documentElement`'s `data-theme` with a `MutationObserver` and calls
   `ctx.setTheme(…)` when the value differs from the last one it saw. That guard matters: `setTheme` writes the same
   attribute, and without it the two would loop.
5. Returns `{ replaces: ['account-menu'] }`. On `ctx.signal` abort, it disconnects the observer and empties the slot.

### 3.3 Environment (production)

```sh
PHILO_WEB_HOST_SCRIPT_URL=/oberon/philo-host.js
PHILO_WEB_HOST_CONFIG='{"notifyUrl":"https://notify.oberonlogistics.com","notifyResource":"https://notify.oberonlogistics.com"}'
PHILO_WEB_ASSET_ORIGINS=https://auth.oberonlogistics.com/chrome/v1/
PHILO_WEB_CONNECT_ORIGINS=https://notify.oberonlogistics.com
```

- `PHILO_OIDC_ISSUER=https://auth.oberonlogistics.com` comes from the identity spec. UP-1 and UP-2 derive the issuer's
  `connect-src` and `frame-src` entries from it, so the issuer is not repeated in `PHILO_WEB_CONNECT_ORIGINS`.
- `script-src`, `style-src` and `font-src` allow only `https://auth.oberonlogistics.com/chrome/v1/` (the chrome, the
  tokens and the fonts). `img-src` gets the bare origin, for tile icons served from the issuer.
- Notify's production address is `https://notify.oberonlogistics.com`, but Notify's own `SPEC.md` §2 marks it
  "**TODO**: confirm". Its resource identifier is the same string there.
- The resulting policy meets DESIGN §5.2's "CSP" line: the issuer (path-scoped) in `script-src`, the issuer in
  `connect-src` and `img-src`, plus Notify in `connect-src`. It also adds `style-src` and `font-src` for `tokens.css` and `fonts.css`, which §5.2 leaves
  out because it assumes `'self'`-hosted tokens.

### 3.4 What the chrome needs from the auth work (`ol/spec-auth`)

1. External-IdP sign-in through OL Auth, with `resource` on the request (philo-crm/philo#61, which UP-2 builds on).
2. The OL Auth public client is **first-party**, and it holds `auth:apps`, `auth:account` and `notify:read`, with the
   audiences `https://auth.oberonlogistics.com/api` and Notify's identifier. Those audiences are for the extra tokens,
   **never the sign-in token** (Handbook `deployment.md`, "Scopes"/"Audiences"/"First-party").
3. The tile: `launch_url` must be on Philo's origin (`https://philo.oberonlogistics.com/`). OL Auth serves the chrome
   assets cross-origin only to the launch origins of enabled first-party clients (integration.md §9). It also needs a
   tint and glyph that no other app in the switcher uses (DESIGN §6). **The orchestrator picks them, because this repo
   can't see the catalog's current assignments.**
4. The client id, which becomes `current=`.
5. OL Auth and Philo are same-site (`*.oberonlogistics.com`), so the hidden frame gets OL Auth's session cookie
   (UP-2's same-site note).

---

## 4. Theme

- **The OL Auth account's value wins.** The chrome reads `theme` from `GET /api/v1/me` and applies it, and the account
  menu saves changes with `PATCH /api/v1/me`. Philo's own picker is hidden once the host replaces the account menu, so
  the person has only one control for it.
- Both systems write `<html data-theme>` with the same meaning, so they agree without translation. What Philo adds is
  the `theme-color` meta and its `philo.theme` copy. Because the chrome applies the account's theme without an event
  (`ol-theme-change` fires only on a click in the menu), the host script watches the attribute rather than the event
  (§3.2, step 4) and passes every change to `ctx.setTheme`.
- First paint: `main.tsx:9` applies `philo.theme` before React. After the first visit, the host script has kept
  `philo.theme` equal to the account's value, so the first paint is right. On a new device the first paint follows the
  system until `/me` answers, exactly as in every other OL app.
- **CSS mapping** (`oberon/web/philo-ol.css`): Philo keeps its own stylesheet, and this file redefines Philo's variables
  as `--ol-*` tokens under the same light and dark selectors as `index.css:54,76-77`. Because the variable values come
  from `tokens.css`, OL Auth's dark values apply automatically. Proposed mapping:

  | Philo | OL token |
  |---|---|
  | `--bg` | `--ol-color-bg` |
  | `--surface`, `--surface-sunken`, `--surface-hover` | `--ol-color-surface`, `--ol-color-surface-2`, `--ol-color-surface-2` |
  | `--border`, `--border-strong` | `--ol-color-border`, `--ol-color-border-strong` |
  | `--text`, `--muted` | `--ol-color-text`, `--ol-color-muted` |
  | `--accent`, `--accent-soft`, `--accent-contrast` | `--ol-color-action`, `--ol-color-primary-soft`, `--ol-color-on-primary` |
  | `--brand`, `--brand-contrast` | `--ol-color-primary`, `--ol-color-on-primary` |
  | `--error`, `--error-bg` | `--ol-color-danger`, `--ol-color-danger-soft` |
  | `--warn`, `--warn-bg` | `--ol-color-warn`, `--ol-color-warn-soft` |
  | `--shadow-card`, `--shadow-pop` | `--ol-shadow-sm`, `--ol-shadow-pop` |
  | `--radius`, `--radius-lg` | `--ol-radius`, `--ol-radius-lg` |
  | `--font-ui`, `--font-mono` | `--ol-font-sans`, `--ol-font-mono` |
  | `--topbar-height` | `--ol-topbar-height` |

  Philo's `--warn-border` and `.topnav`'s accent underline have no exact token. They keep Philo's values, and the
  underline uses `--ol-color-accent` (the green rule, which is never placed behind text). `--accent` maps to `action`
  rather than `link`, because Philo uses it for both fills and links. The pairs `--accent` on `--accent-contrast`
  and `--text` on `--bg` inherit OL's AA checks, but Philo-only combinations (for example `--accent` text on
  `--accent-soft`) need a contrast pass in review. `theme.ts:42`'s hard-coded `TOPBAR_COLORS` stay Philo's, so the
  status bar can be off by a shade under OL colours. That's acceptable, and the alternative would be an upstream
  edit for one colour.
- **Phasing:** the chrome works with or without `philo-ol.css`. If the visual review of the mapping drags on, ship the
  chrome first and the CSS after.

---

## 5. Signed-out pages, install and offline

- **Signed out.** DESIGN §8 says sign-in pages belong to OL Auth and never show the chrome. Philo's signed-out screens
  (`App.tsx:57-98` and `:139-163`: *Loading…*, *Sign in*, *Sign-in failed*, *Connection problem*) render before `AppShell`, so the
  host script never loads there (UP-3 tests this). With OL Auth, the *Sign in* card is a one-click hop to OL Auth's
  page. Making that card look like §8 is out of scope; `ol/spec-auth` may choose to auto-redirect instead.
- **The hidden frame** loads Philo's `/auth/callback` inside Philo itself. The SW serves that navigation network-first
  like any other (`sw.js:47-50`), and `main.tsx` stops before React (UP-2).
- **Install.** The manifest, icons and the *Philo* name are unchanged. The install banner (`AppShell.tsx:162-170`) is
  unaffected, and *Install the app* stays reachable as a host account-menu item.
- **Offline / cross-origin caching.** The SW does **not** cache `ol-chrome.js` or the tokens, and it shouldn't. It
  ignores cross-origin requests (`sw.js:43`). A cached copy would also go stale against OL Auth's compatible `v1` fixes,
  which are the point of loading the chrome from one place, and the chrome is useless offline anyway, because it needs
  OL Auth's API. The HTTP cache (1 h, `ETag`) covers repeat loads. Offline, or with OL Auth down, the host script fails
  to load the chrome. Philo then keeps its own account menu, because `mount` never resolves with `replaces`. The person
  can still sign out, and the app works as far as Philo's own server is reachable.
- `/oberon/philo-host.js` and `philo-ol.css` are same-origin but outside `/assets`, so the SW doesn't cache them either.
  The standalone server gives them no `Cache-Control`, and the HTTP cache revalidates them by `ETag`/`Last-Modified`.
  That's fine for two small files.

---

## 6. Test plan for the Oberon wiring

None of this needs OL Auth or Notify running.

1. **Unit (vitest, jsdom), `oberon/web/test/philo-host.test.ts`.** Load `philo-host.js` into jsdom, with a **stub
   `ol-chrome.js`** written in the test: a few lines that define a `window.OLChrome` recording `configure` calls, plus
   empty `ol-*` custom elements. The stub is ours and copies nothing from the private repo. Call `PhiloHost.mount` with a
   fake `ctx`, then assert:
   - It adds the stylesheets and the script tag with the right URLs and `data-issuer`/`data-defer-config`.
   - The slot holds the three elements in DESIGN §5 order (bell, switcher, account), with `current` equal to
     `ctx.clientId`. With no `notifyUrl` there is no bell.
   - `getToken({audience:"auth"})` and `{audience:"notify"}` call `ctx.getToken` with the right `resource` and `scope`
     and no `prompt`, and any other audience gives `null`.
   - Account items call `ctx.navigate` and don't follow the link.
   - Setting `data-theme` calls `ctx.setTheme` once, with no loop when `setTheme` writes the same value back.
   - `onSignOut` calls `ctx.signOut`, and `signal` abort empties the slot and disconnects the observer.
   - When the chrome script fails to load, `mount` rejects, so Philo keeps its own menu.
2. **CSP.** A standalone-app test, booted with §3.3's env and an external issuer of `https://auth.example.test`,
   asserts the exact policy string. It also checks that a policy without `PHILO_WEB_*` is UP-1's default.
3. **Local end-to-end** (manual, or Playwright later). Run Philo on the task's port
   (`PHILO_PORT=24920`) against the existing dev OIDC stub, or with the built-in IdP, where `getToken` gives
   `null`. Serve the stub chrome at `http://localhost:<port>/chrome/v1/ol-chrome.js` from a small static server, with
   that origin as the "issuer" in `PHILO_WEB_ASSET_ORIGINS`. Check that the slot shows, there's no CSP violation in
   the console, there's only one account menu, *Server settings* routes inside the app, the theme changes, and
   blocking the stub URL brings back Philo's own menu. **Check the top bar at 360 px**: the wordmark, the funnel
   switcher (up to 10 rem), *New lead*, bell, waffle and a compact avatar may not fit (see §7).
4. **Against real OL Auth** (staging only, never production) once the auth work lands: both hidden-frame tokens come
   back with no visible page, the switcher lists tiles with Philo's marked current, and the theme round-trips through
   another OL app.

Run all of it from `oberon/scripts/verify.sh`. Add a step: `npx vitest run --root oberon/web --environment jsdom`
(vitest and jsdom are already in the workspace).

---

## 7. Open questions

1. **Phone width.** Is the 360 px top bar too crowded? The options are hiding the wordmark below 400 px (an upstream CSS
   change, generic enough to justify) or dropping the bell on phones. Decide after the §6.3 check.
2. **Toasts for new leads.** If `ol/spec-notify` puts new leads in the shared feed, `toast-new` would duplicate Philo's
   own push or in-app notification. Recommendation: leave `toast-new` off in Philo.
3. ~~**Sign-out scope.**~~ Closed: Philo's sign-out ends the OL Auth session too (`identity.md` ID-U7), and the host
   script calls it.
4. **Tile tint and glyph** for Philo (§3.4 item 3): the orchestrator picks them.
5. **Notify's production URL**: confirm it in `oberonlogistics-notify` before setting `PHILO_WEB_HOST_CONFIG`.
6. **Upstream appetite for UP-3.** The maintainer may not want a script hook at all. If they refuse, the fallback is an
   `ol/` edit of `AppShell.tsx` (one slot `<div>` and a hidden `AccountMenu`) plus `standalone` (the CSP), and both
   get recorded in the `oberon/AGENTS.md` table. UP-1, UP-2 and UP-4 still stand alone.
