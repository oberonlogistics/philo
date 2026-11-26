/*
 * Philo's lead events, posted to the shared Oberon Logistics feed (OL Notify)
 * as Philo's tile: oberon/docs/notifications.md §10.
 *
 * It listens to the change feed bootServer returns and only enqueues there, so
 * nothing Notify or OL Auth does can reach a request: intake, email, push and
 * webhooks run exactly as without it. One queue in memory, sent one operation
 * at a time, oldest first, so a lead's operations arrive in the order they
 * happened. Best effort: bounded retries, and a restart drops what is queued.
 * A lost item is a missed notice, never a missed lead: email is the guaranteed
 * channel (ADR-0004), and the lead is in Philo.
 *
 * Logs carry the event type, lead id, key, status and problem code only: never
 * a title, a body, a token or the client secret.
 */

import type { ChangeEvent } from '@philo/server'
import type { OberonNotifyConfig } from './notify-config.ts'
import { mapChange, type NotifyOperation } from './notify-map.ts'

export { loadOberonNotifyConfig } from './notify-config.ts'

export interface NotifyLog {
  info(line: string): void
  warn(line: string): void
  error(line: string): void
}

export interface NotifyTuning {
  fetch: typeof fetch
  log: NotifyLog
  /** Every call to OL Auth. */
  tokenTimeoutMs: number
  /** Every call to Notify: longer than Notify's own 20 s budget for a post. */
  callTimeoutMs: number
  /** The waits before each retry; the operation is dropped after the last. */
  retryDelaysMs: readonly number[]
  /** A longer `Retry-After` is honoured up to this. */
  maxRetryAfterMs: number
  /** Waiting operations; past it the oldest are dropped. */
  maxQueue: number
}

export interface NotifyStats {
  /** Operations Notify accepted. */
  sent: number
  /** Operations waiting, not counting the one being sent. */
  queued: number
  dropped: {
    /** The oldest waiting, when the queue was full. */
    queueFull: number
    /** Still failing after the last retry. */
    retriesExhausted: number
    /** Refused for good: a 4xx that is not a setup error. */
    refused: number
  }
}

export interface OberonNotify {
  stats(): NotifyStats
  /** Resolves once nothing is being sent: the queue is empty, or waiting to retry. */
  idle(): Promise<void>
  /** Stops listening and drops what is queued. */
  stop(): void
}

interface ChangeSource {
  listen(listener: (event: ChangeEvent) => void): () => void
}

const DEFAULTS: NotifyTuning = {
  fetch: (input, init) => globalThis.fetch(input, init),
  log: {
    info: (line) => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line),
  },
  tokenTimeoutMs: 10_000,
  callTimeoutMs: 30_000,
  retryDelaysMs: [10_000, 60_000, 300_000],
  maxRetryAfterMs: 300_000,
  maxQueue: 1_000,
}

/** Read at most this much of any answer. */
const MAX_ANSWER_BYTES = 64 * 1024
/** A token is kept until this long before it expires… */
const TOKEN_EARLY_MS = 60_000
/** …and never longer than this. */
const TOKEN_MAX_MS = 15 * 60_000

const PREFIX = 'oberon notify:'

interface Queued {
  operation: NotifyOperation
  type: string
  leadId: string
}

/** How one attempt ended. */
type Outcome =
  | { ok: true }
  | { ok: false; retry: boolean; setup: boolean; status: string; code: string; retryAfterMs?: number }

/**
 * Starts posting, or does nothing and returns undefined when `config` is
 * undefined (no OL_NOTIFY_ variable set).
 */
export function startOberonNotify(
  changes: ChangeSource,
  config: OberonNotifyConfig | undefined,
  tuning: Partial<NotifyTuning> = {},
): OberonNotify | undefined {
  if (config === undefined) return undefined
  const t: NotifyTuning = { ...DEFAULTS, ...tuning }
  const { log } = t
  const tokens = new TokenSource(config, t)

  const waiting: Queued[] = []
  const stats: NotifyStats = { sent: 0, queued: 0, dropped: { queueFull: 0, retriesExhausted: 0, refused: 0 } }
  let running = false
  let busy = false
  let stopped = false
  let idleWaiters: (() => void)[] = []
  let current: AbortController | undefined
  let wake: (() => void) | undefined
  let wakeTimer: ReturnType<typeof setTimeout> | undefined

  const setBusy = (value: boolean) => {
    busy = value
    if (!busy) {
      const waiters = idleWaiters
      idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  const enqueue = (entry: Queued) => {
    waiting.push(entry)
    while (waiting.length > t.maxQueue) {
      const dropped = waiting.shift()!
      stats.dropped.queueFull++
      log.warn(`${PREFIX} queue full, dropped the oldest ${describe(dropped)}`)
    }
    stats.queued = waiting.length
    if (!running) {
      running = true
      setBusy(true)
      queueMicrotask(() => void pump())
    }
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve
      wakeTimer = setTimeout(resolve, ms)
      wakeTimer.unref?.()
    })

  const pump = async () => {
    try {
      // `stopped` and `waiting` change while each delivery is awaited.
      for (;;) {
        const entry = waiting.shift()
        if (entry === undefined || stopped) break
        stats.queued = waiting.length
        await deliver(entry)
      }
    } catch (error: unknown) {
      // Not expected: send() turns every failure into an outcome.
      log.error(`${PREFIX} queue stopped unexpectedly (${errorName(error)})`)
    } finally {
      running = false
      setBusy(false)
    }
  }

  const deliver = async (entry: Queued) => {
    for (let attempt = 0; ; attempt++) {
      const outcome = await send(entry.operation)
      if (stopped) return
      if (outcome.ok) {
        stats.sent++
        log.info(`${PREFIX} accepted ${describe(entry)}`)
        return
      }
      const detail = `${describe(entry)} status=${outcome.status} code=${outcome.code}`
      if (!outcome.retry) {
        stats.dropped.refused++
        log.error(`${PREFIX} refused, dropped ${detail}`)
        return
      }
      const delay = t.retryDelaysMs[attempt]
      if (delay === undefined) {
        stats.dropped.retriesExhausted++
        log.error(`${PREFIX} ${outcome.setup ? 'setup error, ' : ''}dropped after ${attempt} retries ${detail}`)
        return
      }
      const wait = Math.max(delay, Math.min(outcome.retryAfterMs ?? 0, t.maxRetryAfterMs))
      log.warn(
        `${PREFIX} ${outcome.setup ? 'setup error (finish setting up OL Auth and Notify), ' : ''}retrying in ${Math.round(wait / 1000)} s ${detail}`,
      )
      setBusy(false)
      await sleep(wait)
      if (stopped) return
      setBusy(true)
    }
  }

  /** One attempt, including a single fresh-token retry on a 401. */
  const send = async (operation: NotifyOperation): Promise<Outcome> => {
    let outcome = await sendOnce(operation)
    if (!outcome.ok && outcome.status === '401' && !stopped) {
      tokens.drop()
      outcome = await sendOnce(operation)
    }
    return outcome
  }

  const sendOnce = async (operation: NotifyOperation): Promise<Outcome> => {
    const token = await tokens.get()
    if (!token.ok) return token.outcome
    const path = operation.op === 'post' ? '/v1/notifications' : `/v1/notifications/${operation.op}`
    const body =
      operation.op === 'post'
        ? { as: config.as, to: { roles: [config.role] }, ...operation.item, dedupe_key: operation.key }
        : { as: config.as, dedupe_key: operation.key }
    current = new AbortController()
    const answer = await call(t.fetch, `${config.url}${path}`, t.callTimeoutMs, current, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.value}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    current = undefined
    if (!answer.ok) return { ok: false, retry: true, setup: false, status: answer.status, code: answer.code }
    const { response, text } = answer
    if (response.status >= 200 && response.status < 300) return { ok: true }
    const code = problemCode(text)
    const status = response.status
    const retryAfterMs = retryAfter(response.headers.get('retry-after'))
    const base = { ok: false as const, status: String(status), code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
    if (status === 401 || status === 403 || (status === 422 && (code === 'unknown_app' || code === 'unknown_role'))) {
      if (status === 401) tokens.drop()
      return { ...base, retry: true, setup: true }
    }
    if (status === 408 || status === 429 || status >= 500) return { ...base, retry: true, setup: false }
    return { ...base, retry: false, setup: false }
  }

  const unlisten = changes.listen((event) => {
    if (stopped) return
    try {
      for (const operation of mapChange(event, config.appUrl)) {
        enqueue({ operation, type: String(event.type), leadId: leadIdOf(operation) })
      }
    } catch (error: unknown) {
      log.error(`${PREFIX} could not map a change event (${errorName(error)})`)
    }
  })

  log.info(`${PREFIX} posting lead events as ${config.as} to ${config.url}, for role ${config.role}, linking to ${new URL(config.appUrl).origin}`)

  return {
    stats: () => ({ ...stats, dropped: { ...stats.dropped } }),
    idle: () => (busy ? new Promise<void>((resolve) => idleWaiters.push(resolve)) : Promise.resolve()),
    stop: () => {
      if (stopped) return
      stopped = true
      unlisten()
      waiting.length = 0
      stats.queued = 0
      current?.abort()
      if (wakeTimer !== undefined) clearTimeout(wakeTimer)
      wake?.()
      setBusy(false)
    },
  }
}

function leadIdOf(operation: NotifyOperation): string {
  // philo:lead:<id>:<what>
  return operation.key.split(':')[2] ?? '?'
}

function describe(entry: Queued): string {
  return `${entry.operation.op} type=${entry.type} lead=${entry.leadId} key=${entry.operation.key}`
}

/**
 * The client-credentials token for Notify (OL Auth integration §10), from the
 * issuer's discovery document. Kept until a minute before it expires, at most
 * 15 minutes.
 */
class TokenSource {
  readonly config: OberonNotifyConfig
  readonly tuning: NotifyTuning
  #endpoint: string | undefined
  #token: { value: string; until: number } | undefined

  constructor(config: OberonNotifyConfig, tuning: NotifyTuning) {
    this.config = config
    this.tuning = tuning
  }

  drop(): void {
    this.#token = undefined
  }

  async get(): Promise<{ ok: true; value: string } | { ok: false; outcome: Outcome }> {
    if (this.#token !== undefined && Date.now() < this.#token.until) return { ok: true, value: this.#token.value }
    this.#token = undefined
    const endpoint = await this.#discover()
    if (typeof endpoint !== 'string') return { ok: false, outcome: endpoint }

    const { clientId, clientSecret, resource } = this.config
    const answer = await call(this.tuning.fetch, endpoint, this.tuning.tokenTimeoutMs, new AbortController(), {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'notify:post', audience: resource }).toString(),
    })
    if (!answer.ok) return { ok: false, outcome: tokenFailure(answer.status, answer.code) }
    const { response, text } = answer
    const json = parseJson(text)
    if (response.status !== 200) {
      const code = typeof json?.['error'] === 'string' ? safeCode(json['error']) : 'none'
      // The service account itself is refused: setup the operator has to finish.
      const setup = response.status === 400 || response.status === 401 || response.status === 403
      return { ok: false, outcome: { ...tokenFailure(String(response.status), code), setup } }
    }
    const value = json?.['access_token']
    const expiresIn = json?.['expires_in']
    if (typeof value !== 'string' || value === '') return { ok: false, outcome: tokenFailure('200', 'no_access_token') }
    const lifetimeMs = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn * 1000 : TOKEN_MAX_MS
    this.#token = { value, until: Date.now() + Math.min(lifetimeMs - TOKEN_EARLY_MS, TOKEN_MAX_MS) }
    return { ok: true, value }
  }

  async #discover(): Promise<string | Outcome> {
    if (this.#endpoint !== undefined) return this.#endpoint
    const { issuer } = this.config
    const answer = await call(this.tuning.fetch, `${issuer}/.well-known/openid-configuration`, this.tuning.tokenTimeoutMs, new AbortController(), {
      headers: { accept: 'application/json' },
    })
    if (!answer.ok) return tokenFailure(answer.status, answer.code)
    if (answer.response.status !== 200) return tokenFailure(String(answer.response.status), 'discovery_failed')
    const json = parseJson(answer.text)
    const endpoint = json?.['token_endpoint']
    // The client secret goes here, so only to the issuer's own origin.
    if (json?.['issuer'] !== issuer || typeof endpoint !== 'string' || !trustedTokenEndpoint(endpoint, issuer, this.config.production)) {
      return { ...tokenFailure('200', 'discovery_mismatch'), setup: true }
    }
    this.#endpoint = endpoint
    return endpoint
  }
}

/**
 * A token endpoint on the issuer's origin, over https; plain http only on a
 * loopback host and never in production.
 */
function trustedTokenEndpoint(raw: string, issuer: string, production: boolean): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.origin !== new URL(issuer).origin || url.username !== '' || url.password !== '') return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && !production && LOOPBACK.has(url.hostname)
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function tokenFailure(status: string, code: string): Outcome & { ok: false } {
  return { ok: false, retry: true, setup: false, status: `token:${status}`, code }
}

/** RFC 6749 §2.3.1: client credentials are form-encoded before Basic. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+')
}

type Answer = { ok: true; response: Response; text: string } | { ok: false; status: string; code: string }

/**
 * One HTTP call with a deadline that covers reading the answer, reading at
 * most 64 KiB of it. Never throws.
 */
async function call(
  fetcher: typeof fetch,
  url: string,
  timeoutMs: number,
  controller: AbortController,
  init: RequestInit,
): Promise<Answer> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<Answer>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, status: 'timeout', code: 'none' })
      controller.abort()
    }, timeoutMs)
    // stop(): give up at once, even on a fetch that ignores its signal.
    controller.signal.addEventListener('abort', () => resolve({ ok: false, status: 'aborted', code: 'none' }), { once: true })
  })
  const attempt = (async (): Promise<Answer> => {
    try {
      const response = await fetcher(url, { ...init, signal: controller.signal, redirect: 'error' })
      const text = await readCapped(response)
      return { ok: true, response, text }
    } catch (error: unknown) {
      if (controller.signal.aborted) return { ok: false, status: 'aborted', code: 'none' }
      return { ok: false, status: 'network', code: errorName(error) }
    }
  })()
  try {
    return await Promise.race([attempt, deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(response: Response): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (size >= MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_ANSWER_BYTES))
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Notify's problem `code` (SPEC §4.3), or `none`. */
function problemCode(text: string): string {
  const code = parseJson(text)?.['code']
  return typeof code === 'string' ? safeCode(code) : 'none'
}

/** A code is logged, so only ever a short identifier. */
function safeCode(code: string): string {
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unrecognised'
}

/** Seconds or an HTTP date, in milliseconds. */
function retryAfter(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim()) * 1000
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/** The kind of failure, never its message: a message may carry a URL or worse. */
function errorName(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code
  if (typeof cause === 'string' && /^[A-Z0-9_]{1,40}$/.test(cause)) return cause
  const name = (error as { name?: unknown } | undefined)?.name
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error'
}
