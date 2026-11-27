/*
 * A fake OL Auth issuer and a fake Notify, in process. Neither opens a socket:
 * `route` hands the module a `fetch` that sends each request to the fake that
 * owns its origin. Both record what they were sent and answer what a test
 * scripts, so a test can make Notify slow, down, refusing or hung.
 */

import type { OberonNotifyConfig } from '../../src/oberon/notify-config.ts'
import type { NotifyLog } from '../../src/oberon/notify.ts'

export const ISSUER = 'https://auth.example.com'
export const NOTIFY_URL = 'https://notify.example.com'
export const APP_URL = 'https://philo.example.com'
/** Marker values: a test fails if any of them reaches a log line. */
export const CLIENT_SECRET = 'client-secret-MARKER-7f3a'
export const TOKEN_PREFIX = 'access-token-MARKER-'

export const CONFIG: OberonNotifyConfig = {
  url: NOTIFY_URL,
  resource: NOTIFY_URL,
  issuer: ISSUER,
  clientId: 'philo-notify',
  clientSecret: CLIENT_SECRET,
  as: 'philo',
  role: 'philo-users',
  appUrl: APP_URL,
  production: false,
}

type Handler = (request: Request) => Response | Promise<Response>

export function route(handlers: Record<string, Handler>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const handler = handlers[new URL(request.url).origin]
    if (handler === undefined) throw new TypeError('fetch failed')
    return await handler(request)
  }
}

export interface TokenRequest {
  authorization: string | null
  form: Record<string, string>
}

export interface FakeIssuer {
  handler: Handler
  tokenRequests: TokenRequest[]
  discoveryRequests: number
  /** What the next token answers carry. */
  expiresIn: number
  /** Overrides the token endpoint's answer. */
  tokenScript: ((n: number) => Response | Promise<Response>) | undefined
  /** Overrides the token endpoint discovery advertises. */
  tokenEndpoint: string | undefined
}

export function fakeIssuer(issuer = ISSUER): FakeIssuer {
  const fake: FakeIssuer = {
    tokenRequests: [],
    discoveryRequests: 0,
    expiresIn: 899,
    tokenScript: undefined,
    tokenEndpoint: undefined,
    handler: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && path === '/.well-known/openid-configuration') {
        fake.discoveryRequests++
        return Response.json({ issuer, token_endpoint: fake.tokenEndpoint ?? `${issuer}/oauth2/token` })
      }
      if (request.method === 'POST' && path === '/oauth2/token') {
        const form = Object.fromEntries(new URLSearchParams(await request.text()))
        fake.tokenRequests.push({ authorization: request.headers.get('authorization'), form })
        const n = fake.tokenRequests.length
        if (fake.tokenScript !== undefined) return fake.tokenScript(n)
        return Response.json({ access_token: `${TOKEN_PREFIX}${n}`, expires_in: fake.expiresIn, token_type: 'bearer' })
      }
      return new Response('not found', { status: 404 })
    },
  }
  return fake
}

export interface NotifyCall {
  path: string
  authorization: string | null
  body: Record<string, unknown>
}

export interface FakeNotify {
  handler: Handler
  /** Every request, in the order it arrived. */
  calls: NotifyCall[]
  /** Requests answered, in the order they were answered. */
  answered: NotifyCall[]
  inFlight: number
  maxInFlight: number
  /** Overrides the answer; `n` counts from 1 over every call. */
  script: ((call: NotifyCall, n: number) => Response | Promise<Response>) | undefined
}

export function fakeNotify(): FakeNotify {
  const fake: FakeNotify = {
    calls: [],
    answered: [],
    inFlight: 0,
    maxInFlight: 0,
    script: undefined,
    handler: async (request) => {
      const call: NotifyCall = {
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        body: (await request.json()) as Record<string, unknown>,
      }
      fake.calls.push(call)
      fake.inFlight++
      fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight)
      try {
        if (fake.script !== undefined) return await fake.script(call, fake.calls.length)
        return defaultAnswer(call)
      } finally {
        fake.inFlight--
        fake.answered.push(call)
      }
    },
  }
  return fake
}

function defaultAnswer(call: NotifyCall): Response {
  if (call.path === '/v1/notifications') return Response.json({ accepted: 1, skipped: 0 }, { status: 202 })
  if (call.path === '/v1/notifications/resolve') return Response.json({ resolved: 1 })
  if (call.path === '/v1/notifications/withdraw') return Response.json({ withdrawn: 1 })
  return problem(404, 'not_found')
}

export function problem(status: number, code: string, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: 'Problem', status, code, detail: 'A fixed sentence.', request_id: 'r1' }),
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  )
}

/** Every line the module logs, at any level. */
export function captureLog(): { log: NotifyLog; lines: string[] } {
  const lines: string[] = []
  const push = (line: string) => {
    lines.push(line)
  }
  return { log: { info: push, warn: push, error: push }, lines }
}

/** A promise that never settles: Notify accepted the connection and went quiet. */
export function hang(): Promise<never> {
  return new Promise<never>(() => {})
}

/** A short summary of what Notify was sent: `post new`, `resolve new`, … */
export function summary(calls: NotifyCall[]): string[] {
  return calls.map((call) => {
    const op = call.path === '/v1/notifications' ? 'post' : call.path.slice('/v1/notifications/'.length)
    const key = String(call.body['dedupe_key'])
    return `${op} ${key.slice(key.lastIndexOf(':') + 1)}`
  })
}
