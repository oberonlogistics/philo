# Philo identity through OL Auth

Status: **proposal**, for the orchestrator to turn into tasks. No code has changed yet.

**Goal.** Everyone signs in to this fork through OL Auth, and nobody uses Philo's built-in IdP. The MCP
endpoint accepts agents (Claude Code, Claude connectors, Cursor) that register themselves at OL Auth with
dynamic client registration (DCR). The account that production uses today keeps its history.

**Sources.** OL Auth `docs/integration.md` (cited as *OLA §n*); Handbook `docs/deployment.md`, "Register
Handbook in OL Auth", and `packages/pwa/src/session.ts`; Philo at `origin/main` `9e111df`. Every
`file:line` below refers to that commit.

## 1. Where Philo stands against OL Auth's contract

Philo already has an external-IdP mode (`PHILO_OIDC_ISSUER`, ADR-0006). In that mode the built-in
`/oauth` routes and discovery documents are not mounted (`packages/server/src/app.ts:189-204`). The API
verifies the provider's JWTs against its JWKS (`packages/server/src/auth/external-idp.ts:69-104`), and the
PWA signs in by discovery (`packages/sdk/src/oidc.ts:64-110`). The gaps:

| # | OL Auth requires or does | Philo today | Gap |
|---|---|---|---|
| G1 | **No email in access tokens.** An access token carries `sub`, `client_id`, `scp`/`scope`, `aud` and `ext`. Email is in the ID token and `/userinfo` only (OLA §5.2, §5.4). | The first bind and first-account provisioning read `email` and `email_verified` from the **access token** (`external-idp.ts:108-112`, `:138-139`). Without them, `findOrProvisionUser` returns `undefined` and every token is refused. `docs/DEPLOYMENT.md:134-136` states the requirement. | **Blocker.** With OL Auth, no token can bind or provision an account. |
| G2 | DCR clients have **random ids**, and an unused one is deleted and registers again (OLA §2.2). | Admits `PHILO_OIDC_CLIENT_ID` plus the static list `PHILO_OIDC_AGENT_CLIENT_IDS` only (`external-idp.ts:95-97`, `config.ts:95-98`). ADR-0006 (`docs/adr/0006-headless-server-sdk-clients.md:98-101`) records the allow-list. | **Blocker for agents.** A DCR client can never be listed ahead of time. |
| G3 | Authorize every operation on `scp` (OLA §6 step 5, §12.2). A token for an API with no scope is refused at OL Auth. | No scope check on external tokens. The built-in scopes `operator` and `mcp` "grant or withhold nothing" (ADR-0007). | Admitting any client (G2) is safe only with a scope check. Without one, a person who holds no Philo role could still get a token for Philo's audience through a first-party client that may ask for it. |
| G4 | **Audiences.** A resource can carry several identifiers. A token holds the identifier that was asked for (OLA §3, §13 item 3). Handbook registers `/api` and `/mcp`. Its API accepts either; its MCP endpoint accepts only `/mcp`. | One optional `PHILO_OIDC_AUDIENCE` (`config.ts:94`, `external-idp.ts:79`). The MCP app forwards the caller's token to the API (`apps/mcp/src/app.ts:57-58`, `:102`, `:117`), so the API must accept the MCP token too. | One audience value cannot accept both the PWA's `/api` token and an agent's `/mcp` token. |
| G5 | **MCP protected-resource metadata** at `/.well-known/oauth-protected-resource/mcp` with `resource` = the server's address, `authorization_servers` = the issuer, and the resource's scopes. A `401` carries `resource_metadata` (OLA §13 items 1-2). | The path and the 401 are already right (`apps/mcp/src/app.ts:19`, `:61-66`, `:96-107`). `authorization_servers` already comes from the API's sign-in config, so it names OL Auth in external mode (`app.ts:72-76`). `scopes_supported` is hard-coded `['mcp']` (`apps/mcp/src/app.ts:77`). | Claude Code asks for the scopes in the metadata. `mcp` is unknown at OL Auth and is dropped, which leaves nothing useful, so OL Auth refuses with `access_denied` (OLA §3). |
| G6 | `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` for a token that lacks a scope (OLA §12 step 4). | Any refusal is `401 invalid_token` (`auth/middleware.ts:105-109`). If the API answered 403, the MCP app would treat it as an unexpected error and fail with a 500 (`apps/mcp/src/app.ts:103-104`). | Once G3 exists, a client would get 401 for a missing scope, re-authorize, receive the same scopes, and loop. |
| G7 | **The sign-in request.** OL Auth issues a refresh token only when `offline_access` is asked for (OLA §4 step 3). It needs `resource=` to pick an audience whenever the scopes are not unique to one resource (OLA §3). The redirect carries `iss`, which the client must check (OLA §1, RFC 9207). | Scope is hard-coded `openid email profile` (`packages/server/src/app.ts:101-103`). No `resource` is sent (`packages/sdk/src/oidc.ts:94-110`, `:191-200`). `iss` is not checked (`oidc.ts:181-189`). | No refresh token: the session dies after 15 minutes and has to make a full redirect round trip. No `philo:use` in the token. No control over `aud`. |
| G8 | **Refresh rotation with reuse detection.** A refresh token used twice revokes the **whole grant**. "Never refresh from two places at the same time" (OLA §7). | `TokenSession` serialises refreshes within one page (`oidc.ts:314-319`). The refresh token lives in `localStorage` (`apps/web/src/auth.ts:43-59`), shared by every tab. Two tabs that wake together both present it. The built-in IdP forgives that and keeps the winner (ADR-0005, "Rotating refresh tokens"). | With OL Auth, two open tabs that refresh together sign the person out everywhere. |
| G9 | **Sign-out** is RP-initiated logout at `end_session_endpoint` with `id_token_hint`, `post_logout_redirect_uri` and `state`. It ends single sign-on. The app revokes its own refresh token too (OLA §8). | The PWA revokes the refresh token and forgets it locally (`oidc.ts:297-307`, `apps/web/src/auth.ts:135-137`). It never visits `end_session_endpoint`. The ID token is kept in memory (`oidc.ts:24-31`) but nothing uses it. | "Sign out" leaves the OL Auth session alive. The next "Sign in" is silent because the client is first-party (OLA §4), so signing out appears to do nothing. |
| G10 | **The chrome's second token**: `scope=auth:apps auth:account`, `resource={issuer}/api`, first request without `prompt=none`, in a hidden frame (OLA §9; Handbook `session.ts:84-98`, `:237-241`). | Nothing. `createAuthorizationRequest` cannot carry `resource` or `prompt` (`oidc.ts:75-110`). | The chrome spec (`oberon/docs/chrome.md`, written in parallel) owns the plumbing. This spec supplies its prerequisite: `resource` (and `prompt`) on the SDK's authorization request, in U3. |
| G11 | ID-token checks (OLA §4): RS256 signature, `iss`, `aud`, `exp`, `nonce`. | Only `nonce` is checked. The signature is skipped on purpose (`oidc.ts:9-12`, `:203-205`). OIDC Core §3.1.3.7 allows that for a token received straight from the token endpoint over TLS. The API never accepts an ID token: OL Auth's ID-token `aud` is the client id and it has no `client_id` claim, so it fails both `external-idp.ts:79` (with an audience set) and `:95-96`. | None that blocks. The `iss` check of G7 covers the mix-up case. |
| G12 | **Protected-resource metadata for the API** itself (OLA §12 step 3). | Mounted only for the built-in IdP (`app.ts:203`). The API's 401 has no `resource_metadata` (`middleware.ts:107`). | Not needed: no client discovers Philo's API. The PWA reads `/api/v1/auth/config`, and agents use `/mcp`. Leave it alone. |
| G13 | **Who acted.** The timeline names the credential: `oauth:<client_id>` (`middleware.ts:76-79`). | A DCR client's id is a UUID, and a new one is issued after every clean-up. The web shows every `oauth:` actor as "Connected app" (`apps/web/src/format.ts:78`). | Cosmetic. The UUID stays in the event for forensics. No change proposed. |
| G14 | **Built-in credentials after the switch.** | API keys are resolved first and keep working (`middleware.ts:63-64`). Built-in OAuth access tokens are still resolved in external mode (`middleware.ts:66-71`) until they expire, for up to 1 h (`oauth/tokens.ts:42`). They cannot be refreshed, because `/oauth` is not mounted. | Expected and harmless. The runbook in §4 deletes them anyway. |

Single account: when no account is bound to the subject, the code refuses every person after the first
(`external-idp.ts:141-148`, the "second person" in the doc comment at `:127-128`). Other parts assume one
account too, for example the VAPID contact, which is the first user's email (`push/service.ts:107`).

## 2. Generic upstream changes (`up/` PRs)

Each change is written in vendor-neutral terms and needs no Oberon name. They are small and independent,
and every one is off by default, so existing deployments do not change. **Landing order** follows the
dependencies. Two items are needed only in some cases: U8 is a migration aid for an instance whose emails
differ, and U9 waits on the human's answer to the multi-user question (§4.5).

| Order | Branch | Unblocks | ADR |
|---|---|---|---|
| 1 | `up/oidc-audiences` | G4 | No |
| 2 | `up/oidc-userinfo-email` | G1 | No (ADR-0006 wording updated) |
| 3 | `up/oidc-sign-in-request` | G7, G10 prerequisite | No |
| 4 | `up/oidc-required-scope` | G3, G5, G6 | **ADR-0012** (amends ADR-0006) |
| 5 | `up/oidc-any-agent-client` | G2 | **ADR-0012** (same ADR, lands in 4) |
| 6 | `up/pwa-refresh-lock` | G8 | No |
| 7 | `up/pwa-rp-logout` | G9 | No |
| (8) | `up/oidc-bind-subject` | §4 fallback | No. Only if upstream wants it (§4.2). |
| (9) | `up/oidc-multi-user` | §4.5 option C | **ADR** (single operator). Only if the human picks C. |

Items 1, 2, 3, 6 and 7 do not depend on each other and can be built in parallel. Item 5 needs 4.

### U1 `up/oidc-audiences`: accept a list of audiences

- **Env:** `PHILO_OIDC_AUDIENCE` becomes a comma-separated list. One value works as it does today.
- **Behaviour:** a token is accepted when its `aud` names **at least one** listed value. This is what
  `jose`'s `jwtVerify({ audience: string[] })` does. Empty items are dropped, and each item must be an
  absolute URL or a non-empty string.
- **Why it is generic:** an IdP that gives the API and the MCP endpoint separate identifiers (RFC 8707 and
  the MCP authorization spec) mints a token for whichever one was asked for. The MCP app forwards its
  token to the API (ADR-0006), so the API must accept both.
- **Not done, and why:** Handbook's MCP endpoint refuses a token for `/api` alone. Philo's MCP app does not
  see the claims, because the API decides. Accepting either identifier at both ends matches OL Auth's own
  rule: one resource with two addresses, where the MCP server forwards to its own API (OLA §13, "Do not
  pass the token on"). Both identifiers lead to the same user, with the same authority, on the same
  server.
- **Tests** (`external-idp.test.ts`, `config.test.ts`): parsing a list; a token for the first value,
  another for the second, both accepted; a token for neither refused; one value behaves as before.
- **Docs:** the `PHILO_OIDC_AUDIENCE` row in `DEPLOYMENT.md`.

### U2 `up/oidc-userinfo-email`: bind and provision from userinfo

- **Env:** none. It switches on by itself when a token lacks a verified email and discovery names a
  `userinfo_endpoint`.
- **Behaviour:** in `findOrProvisionUser`, and only on the **unbound** path (the subject is not yet bound
  to an account), when the access token has no `email_verified: true` email:
  1. Call `GET {userinfo_endpoint}` with the access token. The endpoint comes from the discovery document
     that is already fetched for the JWKS (`external-idp.ts:27-33`); cache it with the key set.
  2. Require a 200 response whose `sub` equals the token's `sub` (OIDC Core §5.3.2). Any other answer is
     a refusal.
  3. Use that response's `email`, `email_verified` and `name` in place of the token's.

  A bound subject never triggers the call, so it costs one request per account, once. If userinfo cannot
  be reached, the error propagates as JWKS failures already do (`external-idp.ts:66-67`, `:82-83`), not as
  a 401. The token's own email still wins when it is present and verified, so providers that put the
  email in the access token behave as before.
- **Why it is generic:** RFC 9068 access tokens usually carry no profile claims. Several common providers
  keep the email in the ID token and userinfo only.
- **Scope:** the PWA's sign-in scope must include `email`. That is the default today, and U3 keeps it.
- **Tests:** a token without email plus userinfo with a verified email binds the old account, or
  provisions on an empty instance. An unverified email from userinfo is refused. A userinfo `sub` that
  differs from the token's is refused. A 401 from userinfo is refused. A network error propagates (as a
  5xx, not a 401). A bound subject makes no userinfo call (assert on a fetch spy). A token that carries its
  own verified email makes no call.
- **ADR:** none is contested. ADR-0006 says "the first valid operator token with `email_verified: true`
  creates it". Reword it to "a verified email, from the token or the provider's userinfo". Make the same
  change in `DEPLOYMENT.md`, step 2 of "External identity provider", which today demands the email in the
  access token.

### U3 `up/oidc-sign-in-request`: scope, resource and `iss` on the PWA's request

- **Env:**
  - `PHILO_OIDC_SCOPE`: the PWA's requested scope. Default `openid email profile`, today's value. Must
    contain `openid`, or it is a startup error.
  - `PHILO_OIDC_RESOURCE`: zero or more comma-separated resource indicators (RFC 8707). Default empty.
- **API shape:** `GET /api/v1/auth/config` gains an optional `resource: string[]`
  (`packages/server/src/app.ts:101-106`, `packages/sdk/src/types.ts:215-221`). The SDK change ships in the
  same PR, as the repo rule requires.
- **SDK:**
  - `createAuthorizationRequest` takes optional `resource?: string[]` and `prompt?: string`, and sends one
    `resource` parameter per value. `prompt` is not used by the PWA's own sign-in; it exists for the
    chrome's second token (G10).
  - `PendingAuthorization` keeps `resource` and `issuer`.
  - `exchangeCode` sends the same `resource` values to the token endpoint. When the redirect carries
    `iss`, it must equal `metadata.issuer` (RFC 9207), or the exchange fails with `issuer_mismatch`.
- **PWA:** `beginSignIn` passes `auth.config.resource` (`apps/web/src/auth.ts:90-96`).
- **Tests:** SDK unit tests for the URL (repeated `resource`, `prompt`), for the token request body, and
  for `iss` (match, mismatch, absent). A server test that config carries the env values. A `config.ts`
  test that a scope without `openid` is refused.

### U4 `up/oidc-required-scope`: an admission scope for external tokens

- **Env:**
  - `PHILO_OIDC_REQUIRED_SCOPE`: one scope every external access token must hold, read from `scp` (an
    array) or `scope` (a space-separated string). Default unset, which means no check, as today.
  - `PHILO_OIDC_AGENT_SCOPE`: what the MCP metadata advertises and agents ask for. Default: the required
    scope plus `offline_access` when a required scope is set. Otherwise unset, which keeps `mcp` for the
    built-in IdP.
- **Behaviour:**
  - A token that verifies but lacks the required scope is refused with **403** `insufficient_scope` and
    `WWW-Authenticate: Bearer realm="philo", error="insufficient_scope", scope="<required>"`, not 401.
    Implementation: `verifyExternalToken` returns a tagged refusal, the principal stays undefined, and
    `requireAuth` answers 403 when the tag is present.
  - The check runs before any bind or provision, so a token without the scope can never claim the
    account.
  - The MCP app (`apps/mcp/src/app.ts:95-109`) passes a 403 from `auth.principal()` through as a 403 with
    the same `WWW-Authenticate` parameters plus `resource_metadata`, instead of a 500.
  - `GET /api/v1/auth/config` gains `agentScope` (a string). The MCP metadata reads `scopes_supported`
    from it (`apps/mcp/src/app.ts:77`). With the built-in IdP it stays `mcp`.
- **Why it is generic:** every multi-application IdP can mint a token for this API's audience to any
  client that is allowed that audience. A scope that the IdP's policy grants only to the right people is
  what says "this person may use this CRM". ADR-0006 itself names this future: "Revisit if … an
  external-IdP deployment needs group-based authorization" (`0006:119-121`).
- **It is not a second authority level.** Every admitted token still acts with its user's full authority
  (ADR-0007). The scope is a yes/no gate at the door.
- **Tests:** `scp` array and `scope` string both pass. Missing scope gives 403 with the header, and no bind
  happens (an unbound account stays unbound). Unset env behaves as before. MCP: a 403 is passed through
  with its header, and the metadata `scopes_supported` follows config.
- **ADR-0012, "External-IdP admission by audience and scope"**, lands in this PR. It amends ADR-0006's
  External IdP bullet (`0006:90-101`): admission becomes the issuer plus the audience, plus an optional
  required scope, plus a client rule, which U5 relaxes.

### U5 `up/oidc-any-agent-client`: admit self-registered agent clients

- **Env:** `PHILO_OIDC_AGENT_CLIENT_IDS=*`.
- **Behaviour:** any `client_id`/`azp` is admitted as an agent (actor `oauth:<client_id>`). The PWA's
  client id is still the person (`user:<id>`).
- **Startup guard:** `*` is allowed only when `PHILO_OIDC_AUDIENCE` **and** `PHILO_OIDC_REQUIRED_SCOPE`
  are both set; otherwise it is a startup error. The audience proves the IdP minted the token for this
  CRM. The scope proves the IdP's policy let this person in. Together they replace the allow-list's job
  from ADR-0006: "a valid signature alone grants nothing". A token that names no client is still refused.
- **Why it is generic:** any IdP with RFC 7591 registration, which is how every MCP client connects,
  issues unpredictable client ids. Dynamic registration is how Claude connectors, Claude Code and Cursor
  connect.
- **Tests:** `*` with both settings admits an unknown client as `oauth:<id>`. `*` without the audience,
  or without the scope, fails at startup. `*` mixed with ids is a startup error, which keeps one meaning.
  The listed-ids behaviour is unchanged.
- **ADR:** ADR-0012, written in U4. This PR changes its status line to say the wildcard now exists.

### U6 `up/pwa-refresh-lock`: one refresh across tabs

- **Env:** none.
- **Behaviour:** `TokenSession` takes an optional `lock(name, fn)`. The PWA supplies one built on the Web
  Locks API (`navigator.locks.request`) and falls back to no lock where the API is missing. Inside the
  lock, the session reloads the refresh token from the store first. If another tab already rotated it, the
  session uses the new token, or skips the refresh when it already holds a fresh access token.
- **Why it is generic:** OAuth 2.1 recommends revoking the whole token family on reuse, and providers that
  do so sign every tab out when two tabs refresh at the same moment.
- **Tests:** two `TokenSession`s sharing one store and a fake lock make exactly one token-endpoint call.
  The second session picks up the rotated token. Without `lock`, behaviour is unchanged.

### U7 `up/pwa-rp-logout`: end the provider's session on sign-out

- **Env:** none. The change applies only when discovery names an `end_session_endpoint`, so the built-in
  IdP, which names none, behaves as before.
- **Behaviour:** `signOut` revokes the refresh token as it does today, then sends the browser to
  `end_session_endpoint`. The request carries `id_token_hint` (the last ID token, which a refresh renews),
  `post_logout_redirect_uri={origin}/` and a `state` that the landing page checks and drops. With no ID
  token in hand, it sends `client_id` and no hint; the provider then asks the person to confirm.
- **SDK:** `TokenSession` exposes the current `idToken`. A new `endSessionUrl({ metadata, idToken,
  postLogoutRedirectUri, state, clientId })` builds the URL.
- **Tests:** the URL is right with and without a hint. There is no navigation when the endpoint is absent.
  Revocation still happens first.
- **Docs:** `DEPLOYMENT.md`, step 1 of "External identity provider": register `<PHILO_APP_URL>/` as the
  post-logout address.

### (U8) `up/oidc-bind-subject`: an explicit bind for the migration

Optional, and not needed by the fork (§4.2 uses a reviewed SQL statement). Propose it upstream only if an
upstream reviewer prefers an env to SQL:

- `PHILO_OIDC_BIND_SUBJECT=<sub>`. At boot, if exactly one account exists and it is unbound, it is bound to
  `iss`+`sub` and the binding is logged. If that account is already bound to this subject, nothing
  happens. If it is bound to another subject, or more than one account exists, it is a startup error. It
  is safe to leave set.

## 3. Oberon-only wiring (`ol/`)

None of this is code. The external-IdP mode is configured entirely by env, so the fork's identity layer
is configuration plus this runbook.

```sh
PHILO_PUBLIC_BASE_URL=https://philo.oberonlogistics.com
PHILO_TRUSTED_PROXY=true
PHILO_OIDC_ISSUER=https://auth.oberonlogistics.com
PHILO_OIDC_CLIENT_ID=philo
PHILO_OIDC_AUDIENCE=https://philo.oberonlogistics.com/api,https://philo.oberonlogistics.com/mcp   # U1
PHILO_OIDC_SCOPE="openid email profile offline_access philo:use"                                 # U3
PHILO_OIDC_RESOURCE=https://philo.oberonlogistics.com/api                                         # U3
PHILO_OIDC_REQUIRED_SCOPE=philo:use                                                               # U4
PHILO_OIDC_AGENT_SCOPE="philo:use offline_access"     # U4; this is also the default
PHILO_OIDC_AGENT_CLIENT_IDS=*                                                                     # U5
```

- `PHILO_APP_URL` and `PHILO_MCP_URL` stay unset. They default to the base URL and `<base>/mcp`, which
  are the production addresses.
- The PWA's redirect URI is built in the browser as `window.location.origin + /auth/callback`
  (`apps/web/src/auth.ts:25`, `:81-83`), not from `PHILO_APP_URL`. In external mode, `PHILO_APP_URL` only
  places links in email and notifications. The registered redirect is therefore
  `https://philo.oberonlogistics.com/auth/callback`, which matches `FIRST_PARTY_CALLBACK_PATH`
  (`oauth/first-party.ts:13`).
- The chrome's second token (`auth:apps auth:account`, `resource=https://auth.oberonlogistics.com/api`)
  and the bell's Notify token are wired by the chrome and notifications specs. This spec only registers
  their scopes and audiences on the client (§5).
- `oberon/DEPLOY.md` (not yet written) carries the env above and the runbook from §4.

## 4. Moving production's identity

Today production runs the stock image with the built-in IdP. All data belongs to user `id=1` (the
account created at first-boot setup). API keys, push subscriptions and timeline actors `user:1` point at
that id. Nothing else references the built-in IdP. The move keeps the same row, adds
`users.external_subject = "https://auth.oberonlogistics.com <sub>"`, and loses nothing.

### 4.1 Primary path: bind by verified email (needs U2)

With U2, the PWA's first OL Auth sign-in finds no bound subject and gets the person's verified email from
OL Auth's userinfo. It binds `id=1` when that email equals `users.email` after normalisation
(`credentials.ts`). The bind happens once and is keyed by `sub` afterwards (`external-idp.ts:141-148`).
This works only when:

- the OL Auth account's email is **verified** (`email_verified: true`), not merely typed in by an
  administrator (OLA §5.1); and
- it equals the address of Philo's account. Check before the cutover: Philo **Settings → Account** against
  the OL Auth portal's profile.

If either condition fails, the token is refused. Philo stays empty-handed but safe: nothing is created,
because an existing account blocks provisioning. Use 4.2.

### 4.2 Fallback when the emails differ: an explicit bind

Pick one of these, before the first sign-in:

- **Change one email to match.** Either change Philo's account email in Settings while still on the
  built-in IdP, or verify the matching address at OL Auth. This needs no tooling. **Recommended.**
- **Bind by SQL**, with the container stopped and a backup taken. `<sub>` is the person's OL Auth id (the
  console's user page, or `sub` from any of their tokens):

  ```sql
  UPDATE users SET external_subject = 'https://auth.oberonlogistics.com <sub>'
   WHERE id = 1 AND external_subject IS NULL;
  -- expect: 1 row changed
  ```

  The value is the issuer and the subject separated by one space, exactly as `external-idp.ts:102`
  builds it.
- `PHILO_OIDC_BIND_SUBJECT` (U8) does the same as the SQL, if upstream takes it.

### 4.3 Rehearsal on a copy

1. The human makes an online backup of production, following `DEPLOYMENT.md` § Backup, and hands over
   the copy. **Agents never read production or its data.**
2. Restore it into a scratch data dir, run the fork image with the §3 env and `PHILO_PORT=24910`, and
   reach it at `http://localhost:24910`. Register a **separate rehearsal client** at OL Auth (`philo-dev`,
   public, redirect `http://localhost:24910/auth/callback`, the same scopes and audiences) so that
   production's client never lists a loopback address. Set `PHILO_OIDC_CLIENT_ID=philo-dev` and point
   `PHILO_OIDC_AUDIENCE` at the same production resource identifiers, which works because the audience is
   only a name.
3. Check each of these:
   - The first sign-in binds `id=1`; the lead count and timeline match the original.
   - An existing API key still works against `/api/v1` and `/mcp`.
   - A second person, who holds `philo:use` but is not the operator, is refused.
   - `claude mcp add --transport http philo-rehearsal http://localhost:24910/mcp` registers at OL Auth
     and lists tools. A loopback MCP URL would need its own identifier, so the rehearsal checks agents
     against a staging host, or skips this step and runs it right after cutover.
   - Sign-out lands on `/` and the next sign-in shows OL Auth's page.
   - Two tabs left open past the 15-minute access-token lifetime stay signed in (U6).
4. Throw the copy away afterwards. It holds customer data.

### 4.4 What happens to the built-in IdP's credentials

| Credential | After cutover | Action |
|---|---|---|
| API keys (`philo_…`) | Keep working; they belong to `id=1` (ADR-0007), which keeps its id | None. Review the list in Settings and revoke the ones nobody uses. |
| Push subscriptions | Keep working; they are keyed by `user_id`, which is unchanged | None |
| The PWA's built-in refresh token in a browser | The next refresh goes to OL Auth's token endpoint and gets `invalid_grant`; the session clears (`oidc.ts:336-341`) and the person signs in | None |
| Built-in OAuth access tokens (connectors) | Still resolve for at most 1 h (G14), then 401 | Optional: in the same stopped window, `DELETE FROM access_tokens; DELETE FROM refresh_tokens; DELETE FROM authorization_codes;` |
| Built-in OAuth clients (claude.ai connector, Claude Code) | Their next 401 carries metadata naming OL Auth; the client re-discovers, registers at OL Auth and asks the person to sign in | Tell users to expect one re-authentication per agent. Optionally `DELETE FROM oauth_clients WHERE client_id <> 'philo-web';` |
| Built-in password | Unused; `/oauth` is not mounted | None. The hash stays. If external mode is ever turned off, it works again. |

**Rollback:** unset `PHILO_OIDC_*` and restart. The built-in IdP returns with the same account and
password. `external_subject` stays and does no harm.

### 4.5 Open question for the human: more than one OL person

Philo binds **one** person. Anyone else who signs in, even with `philo:use`, is refused. If several OL
people need Philo:

- **A. Keep one operator** (today's model). Only one person gets `philo:use`; others ask that person, or
  use their own agents through that person's account. No change.
- **B. A shared account.** Every holder of `philo:use` acts as the one account, whatever their `sub`.
  It needs an upstream flag that ignores `sub` after the scope check. The cost: the timeline records
  `user:1` for everyone, so it no longer tells people apart. Sign-out, API keys and push all become
  shared. Disabling one person is possible only at OL Auth. It contests ADR-0006's `iss`+`sub` binding.
- **C. Several equal users** (`up/oidc-multi-user`, an ADR). With a required scope set, provision **one
  account per subject** that holds the scope. Every account has full authority, which ADR-0007 already
  anticipates (`0007:55-56`). Leads stay unowned, as DESIGN.md says (`DESIGN.md:417`). Each person gets
  their own keys, push subscriptions and `user:<id>` on the timeline. Places that assume one account have
  to change: the VAPID contact (`push/service.ts:107`), "first user" lookups, notification email
  recipients (to be audited), and the Account screen. It contests the single-operator assumption in
  ADR-0005 (`0005:79-81`) and ADR-0006, so it needs its own ADR and an upstream discussion first.

**Recommendation: A for the cutover, and C if a second person really needs access.** B is cheaper to
build but gives up the accountability the timeline exists for (ADR-0007, "the timeline still names the
credential"), and no upstream maintainer would take it. C is a real but bounded change. Open an upstream
issue to discuss it before building it.

## 5. Register Philo in OL Auth

An OL Auth administrator does this once, in the console or through the API, before the cutover. Register
the resource, the scope, the role, the public client and the tile. For Notify (a service account for the
bridge), see the notifications spec.

### Resource

Register a resource named Philo with both of these identifiers, and **`dynamic_clients: true`**, so that
agents (Claude Code, a Claude connector, Cursor) can connect to the MCP server. Those clients register
themselves with OL Auth and can reach only resources and scopes marked `dynamic_clients`. Without the
flag, they are refused when they ask for a token with `resource=https://philo.oberonlogistics.com/mcp`.
Setting it needs a fresh passkey sign-in, so do it in the console (**Administration**, **Resources**,
Philo) or, through the API, `PATCH /api/v1/resources/{id}` with `{"dynamic_clients": true}`.

- `https://philo.oberonlogistics.com/api`: what the PWA's token is asked for.
- `https://philo.oberonlogistics.com/mcp`: what agents ask for. It must equal `PHILO_MCP_URL`, which the
  MCP metadata names as `resource`.

Philo accepts a token whose `aud` names either identifier, at both the API and `/mcp` (U1, and §2 for
why this differs from Handbook).

### Scopes

Register this scope on that resource:

| Scope | What a person sees |
|---|---|
| `philo:use` | Use Philo, the CRM: read and change leads, funnels and settings |

Mark it **`dynamic_clients: true`** as well (console: the scope's settings; API:
`PATCH /api/v1/scopes/{id}` with `{"dynamic_clients": true}`, also with a fresh passkey sign-in). One
scope is enough, because Philo has one level of access (ADR-0007). Do not mark it *granted to all users*.

### Roles

- The Philo operator role (suggested slug `philo-operator`) holds `philo:use`. Give it to the one
  operator only (§4.5).

### Public client

Register the public client with client id `philo`. It is a public client: authorization code with PKCE,
and first-party.

| Setting | Value |
|---|---|
| Redirect | `https://philo.oberonlogistics.com/auth/callback` |
| Post-logout | `https://philo.oberonlogistics.com/` |
| Scopes | `openid`, `profile`, `email`, `offline_access`, `philo:use`, `notify:read`, `auth:apps`, `auth:account` |
| Audiences | `https://philo.oberonlogistics.com/api`, `https://philo.oberonlogistics.com/mcp`, Notify's resource identifier, and `https://auth.oberonlogistics.com/api` (the issuer's `/api`, OL Auth's API) |
| First-party | Yes. The shared chrome's token is asked for in a hidden frame; OL Auth answers without a page only for a first-party client. A first-party client also skips the consent screen at sign-in. |

`email` is what lets the first sign-in bind the existing account (§4.1, U2). `offline_access` gives the
PWA a refresh token (OLA §4 step 3). Without it, the PWA has to redirect every 15 minutes.

`auth:apps` and `auth:account`, with the audience `https://auth.oberonlogistics.com/api`, are for the
shared chrome. Philo asks for them in a token of their own, never in the sign-in token, and the first time
without `prompt=none` (OLA §9; see the chrome spec). `notify:read`, with Notify's audience, is for the
bell (see the notifications spec). If any of these is missing, Philo still works, but the chrome degrades
as Handbook's does.

The `/mcp` audience is listed so that an operator can test `/mcp` with the PWA's client. Agents do not
use this client; they register their own.

For the rehearsal (§4.3), register a second public client `philo-dev` with redirect
`http://localhost:24910/auth/callback`, post-logout `http://localhost:24910/`, and the same scopes and
audiences, not first-party. Delete it afterwards.

### Tile

Show a tile in the selector for this client. Set the tile's required scope `philo:use`. Its launch URL is
`https://philo.oberonlogistics.com/`. The chrome's assets are served cross-origin only to the launch
origin (OLA §9), so it must be the origin the PWA runs on. A tile without an icon is allowed.

### Notify service account

See the notifications spec.

### What Philo then needs

The env block in §3. `PHILO_OIDC_CLIENT_ID=philo`. There is no client secret, because the client is
public.

## Open questions

1. **More than one OL person** (§4.5): A, B or C? Recommendation: A now, C through an upstream ADR if
   needed.
2. **The operator's emails**: do Philo's account email and the operator's verified OL Auth email match?
   If not, which fallback in §4.2: change an email (recommended) or SQL?
3. **Upstream appetite for ADR-0012** (U4 and U5). If upstream declines the wildcard, the fork would carry
   U5 as an `ol/` patch to `external-idp.ts` and `config.ts`, and record it in `oberon/AGENTS.md`'s table
   of edited files. Open an upstream issue first.
4. **Agents at cutover**: OL Auth's guide says a real Claude Code, Claude connector and Cursor have not
   been run against it (OLA, "What was not run"). The first real agent connection should be checked right
   after cutover.

## Verified, not assumed

- OL Auth access tokens carry no email (OLA §5.2, table, "There are no roles, no profile and no email").
- Philo requires `email` and `email_verified` from the access token to bind (`external-idp.ts:108-112`,
  `:138-139`).
- Admission is limited to the PWA's client plus a static list (`external-idp.ts:95-97`).
- No scope check exists in external mode (`external-idp.ts:69-104`).
- The account is single: a second person is refused (`external-idp.ts:141-148`).
- The PWA's callback path is `/auth/callback` at the browser's origin (`apps/web/src/auth.ts:25`, `:81-83`).
- No upstream issue or PR overlaps. `gh issue list` and `gh pr list -R philo-crm/philo --state all` show
  nothing about external OIDC; the nearest is the merged #36 (the headless server and SDK clients).
