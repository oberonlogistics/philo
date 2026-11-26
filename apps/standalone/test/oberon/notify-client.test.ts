import type { ChangeEvent } from '@philo/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startOberonNotify, type NotifyTuning, type OberonNotify } from '../../src/oberon/notify.ts'
import {
  captureLog,
  CLIENT_SECRET,
  CONFIG,
  fakeIssuer,
  fakeNotify,
  hang,
  ISSUER,
  NOTIFY_URL,
  problem,
  route,
  summary,
  TOKEN_PREFIX,
} from './fakes.ts'

type Listener = (event: ChangeEvent) => void

/** A change feed the test publishes into, as Philo's routes would. */
function feed() {
  const listeners = new Set<Listener>()
  return {
    listen(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(event: ChangeEvent) {
      for (const listener of listeners) listener(event)
    },
    get size() {
      return listeners.size
    },
  }
}

const FORM_MARKER = 'FORMNAME-MARKER'
const STAGE_MARKER = 'STAGENAME-MARKER'

function lead(id: number, stageName = STAGE_MARKER) {
  return {
    id,
    name: 'NAME-MARKER',
    email: 'EMAIL-MARKER@example.com',
    phone: 'PHONE-MARKER',
    source: FORM_MARKER,
    formId: 1,
    funnelId: 1,
    stageId: 1,
    stageName,
    isSpam: false,
    fields: {},
    details: {},
    createdAt: '2026-11-26T10:00:00.000Z',
    updatedAt: '2026-11-26T10:00:00.000Z',
  }
}

let n = 0
function created(id: number): ChangeEvent {
  return { id: `e${++n}`, type: 'lead.created', occurredAt: '', actor: 'form:abc', funnelId: 1, data: { lead: lead(id) } }
}
function moved(id: number, actor = 'api_key:3'): ChangeEvent {
  return {
    id: `e${++n}`,
    type: 'lead.stage_changed',
    occurredAt: '',
    actor: actor as ChangeEvent['actor'],
    funnelId: 1,
    data: { lead: lead(id, `${STAGE_MARKER}-2`), from: { id: 1, name: STAGE_MARKER, funnelId: 1 } },
  }
}
function deleted(id: number): ChangeEvent {
  return { id: `e${++n}`, type: 'lead.deleted', occurredAt: '', actor: 'user:1', funnelId: 1, data: { leadId: id } }
}

interface Rig {
  changes: ReturnType<typeof feed>
  issuer: ReturnType<typeof fakeIssuer>
  notify: ReturnType<typeof fakeNotify>
  lines: string[]
  module: OberonNotify
}

const rigs: Rig[] = []

function rig(tuning: Partial<NotifyTuning> = {}): Rig {
  const changes = feed()
  const issuer = fakeIssuer()
  const notify = fakeNotify()
  const { log, lines } = captureLog()
  const module = startOberonNotify(changes, CONFIG, {
    fetch: route({ [ISSUER]: issuer.handler, [NOTIFY_URL]: notify.handler }),
    log,
    ...tuning,
  })
  if (module === undefined) throw new Error('module did not start')
  const r = { changes, issuer, notify, lines, module }
  rigs.push(r)
  return r
}

/** Lets queued work run, under fake timers, without moving the clock. */
async function settle(r: Rig): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await r.module.idle()
}

const TITLE_MARKERS = [FORM_MARKER, STAGE_MARKER, 'NAME-MARKER', 'EMAIL-MARKER', 'PHONE-MARKER']

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  // Logs, over every test: no title, body, token or client secret (§10).
  for (const r of rigs.splice(0)) {
    r.module.stop()
    const text = r.lines.join('\n')
    for (const marker of [...TITLE_MARKERS, TOKEN_PREFIX, CLIENT_SECRET, 'Waiting in', 'New lead from', 'An agent']) {
      expect(text, marker).not.toContain(marker)
    }
  }
  vi.useRealTimers()
})

describe('the token', () => {
  it('is fetched by client credentials, once, and reused', async () => {
    const r = rig()
    r.changes.publish(created(1))
    r.changes.publish(created(2))
    await settle(r)

    expect(r.issuer.discoveryRequests).toBe(1)
    expect(r.issuer.tokenRequests).toHaveLength(1)
    const [request] = r.issuer.tokenRequests
    expect(request?.form).toEqual({ grant_type: 'client_credentials', scope: 'notify:post', audience: NOTIFY_URL })
    expect(request?.authorization).toBe(`Basic ${Buffer.from(`philo-notify:${CLIENT_SECRET}`).toString('base64')}`)
    expect(r.notify.calls.map((call) => call.authorization)).toEqual([`Bearer ${TOKEN_PREFIX}1`, `Bearer ${TOKEN_PREFIX}1`])
  })

  it('is refreshed 60 s before it expires', async () => {
    const r = rig()
    r.issuer.expiresIn = 120
    r.changes.publish(created(1))
    await settle(r)
    await vi.advanceTimersByTimeAsync(59_000)
    r.changes.publish(created(2))
    await settle(r)
    expect(r.issuer.tokenRequests).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2_000)
    r.changes.publish(created(3))
    await settle(r)
    expect(r.issuer.tokenRequests).toHaveLength(2)
    expect(r.notify.calls.at(-1)?.authorization).toBe(`Bearer ${TOKEN_PREFIX}2`)
  })

  it('is never kept longer than 15 minutes', async () => {
    const r = rig()
    r.issuer.expiresIn = 86_400
    r.changes.publish(created(1))
    await settle(r)
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1)
    r.changes.publish(created(2))
    await settle(r)
    expect(r.issuer.tokenRequests).toHaveLength(2)
  })

  it('is dropped on a 401 and fetched again, once', async () => {
    const r = rig()
    r.notify.script = (call, count) => (count === 1 ? problem(401, 'invalid_token') : Response.json({ accepted: 1, skipped: 0 }, { status: 202 }))
    r.changes.publish(created(1))
    await settle(r)

    expect(r.issuer.tokenRequests).toHaveLength(2)
    expect(r.notify.calls.map((call) => call.authorization)).toEqual([`Bearer ${TOKEN_PREFIX}1`, `Bearer ${TOKEN_PREFIX}2`])
    expect(r.module.stats().sent).toBe(1)
  })

  it('is retried on the schedule when the issuer is down, and nothing is posted meanwhile', async () => {
    const r = rig()
    r.issuer.tokenScript = (count) => (count === 1 ? new Response('down', { status: 503 }) : Response.json({ access_token: `${TOKEN_PREFIX}x`, expires_in: 899 }))
    r.changes.publish(created(1))
    await settle(r)
    expect(r.notify.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await settle(r)
    expect(summary(r.notify.calls)).toEqual(['post new'])
  })

  it('logs an issuer that refuses the client as a setup error', async () => {
    const r = rig()
    r.issuer.tokenScript = () => Response.json({ error: 'invalid_client' }, { status: 401 })
    r.changes.publish(created(1))
    await settle(r)
    expect(r.lines.join('\n')).toMatch(/setup error/)
    expect(r.lines.join('\n')).toMatch(/invalid_client/)
  })
})

describe('posting', () => {
  it('sends what §4.1 asks for, as Philo, to the Philo users role', async () => {
    const r = rig()
    r.changes.publish(created(7))
    await settle(r)
    expect(r.notify.calls).toEqual([
      {
        path: '/v1/notifications',
        authorization: `Bearer ${TOKEN_PREFIX}1`,
        body: {
          as: 'philo',
          to: { roles: ['philo-users'] },
          kind: 'action',
          severity: 'info',
          title: `New lead from ${FORM_MARKER}`,
          body: `Waiting in ${STAGE_MARKER}. Open it to see who it is.`,
          href: 'https://philo.example.com/leads/7',
          dedupe_key: 'philo:lead:7:new',
        },
      },
    ])
  })

  it('sends resolve and withdraw with no recipients', async () => {
    const r = rig()
    r.changes.publish(moved(7, 'user:1'))
    r.changes.publish(deleted(7))
    await settle(r)
    expect(r.notify.calls.map((call) => [call.path, call.body])).toEqual([
      ['/v1/notifications/resolve', { as: 'philo', dedupe_key: 'philo:lead:7:new' }],
      ['/v1/notifications/withdraw', { as: 'philo', dedupe_key: 'philo:lead:7:new' }],
      ['/v1/notifications/withdraw', { as: 'philo', dedupe_key: 'philo:lead:7:added' }],
      ['/v1/notifications/withdraw', { as: 'philo', dedupe_key: 'philo:lead:7:moved' }],
    ])
  })

  it('sends one lead\'s operations in order, each after the previous was answered', async () => {
    const r = rig()
    // A slow Notify: every answer takes a second.
    r.notify.script = async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      return call.path === '/v1/notifications' ? Response.json({ accepted: 1, skipped: 0 }, { status: 202 }) : Response.json({ resolved: 1 })
    }
    r.changes.publish(created(9))
    r.changes.publish(moved(9))
    r.changes.publish(deleted(9))
    await vi.advanceTimersByTimeAsync(10_000)
    await r.module.idle()

    expect(summary(r.notify.answered)).toEqual(['post new', 'resolve new', 'post moved', 'withdraw new', 'withdraw added', 'withdraw moved'])
    expect(summary(r.notify.calls)).toEqual(summary(r.notify.answered))
    expect(r.notify.maxInFlight).toBe(1)
  })

  it('does not send a slow answer twice when it comes within 30 s', async () => {
    const r = rig()
    r.notify.script = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25_000))
      return Response.json({ accepted: 1, skipped: 0 }, { status: 202 })
    }
    r.changes.publish(created(1))
    await vi.advanceTimersByTimeAsync(26_000)
    await r.module.idle()
    expect(r.notify.calls).toHaveLength(1)
    expect(r.module.stats()).toMatchObject({ sent: 1, dropped: { retriesExhausted: 0, refused: 0, queueFull: 0 } })
  })

  it('gives up on a hung call after 30 s and retries it', async () => {
    const r = rig()
    r.notify.script = (call, count) => (count === 1 ? hang() : Response.json({ accepted: 1, skipped: 0 }, { status: 202 }))
    r.changes.publish(created(1))
    await vi.advanceTimersByTimeAsync(29_000)
    expect(r.notify.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000 + 10_000)
    await r.module.idle()
    expect(r.notify.calls).toHaveLength(2)
    expect(r.module.stats().sent).toBe(1)
    expect(r.lines.join('\n')).toMatch(/timeout/)
  })
})

describe('retries (§10)', () => {
  it('retries a 503 after 10 s, 60 s and 5 min, then drops and counts it', async () => {
    const r = rig()
    r.notify.script = () => problem(503, 'dependency_unavailable')
    r.changes.publish(created(1))
    await settle(r)
    expect(r.notify.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(9_999)
    expect(r.notify.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.notify.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.notify.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(r.notify.calls).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(r.notify.calls).toHaveLength(4)

    expect(r.module.stats()).toMatchObject({ sent: 0, queued: 0, dropped: { retriesExhausted: 1 } })
    const last = r.lines.at(-1) ?? ''
    expect(last).toMatch(/dropped/)
    expect(last).toContain('type=lead.created')
    expect(last).toContain('lead=1')
    expect(last).toContain('key=philo:lead:1:new')
    expect(last).toContain('status=503')
    expect(last).toContain('code=dependency_unavailable')
  })

  it('honours a longer Retry-After, up to 5 min', async () => {
    const r = rig()
    r.notify.script = (call, count) =>
      count === 1
        ? problem(503, 'dependency_unavailable', { 'retry-after': '120' })
        : count === 2
          ? problem(429, 'rate_limited', { 'retry-after': '3600' })
          : Response.json({ accepted: 1, skipped: 0 }, { status: 202 })
    r.changes.publish(created(1))
    await settle(r)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(r.notify.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.notify.calls).toHaveLength(2)
    // Capped at 5 min, not the hour asked for.
    await vi.advanceTimersByTimeAsync(299_999)
    expect(r.notify.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await r.module.idle()
    expect(r.notify.calls).toHaveLength(3)
    expect(r.module.stats().sent).toBe(1)
  })

  it('retries network errors, 408 and 500', async () => {
    const r = rig()
    let count = 0
    r.notify.script = () => {
      count++
      if (count === 1) throw new TypeError('fetch failed')
      if (count === 2) return problem(408, 'request_timeout')
      if (count === 3) return problem(500, 'internal_error')
      return Response.json({ accepted: 1, skipped: 0 }, { status: 202 })
    }
    r.changes.publish(created(1))
    await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 300_000)
    await r.module.idle()
    expect(r.notify.calls).toHaveLength(4)
    expect(r.module.stats().sent).toBe(1)
  })

  it('drops 422 validation_failed at once, logging the problem code', async () => {
    const r = rig()
    r.notify.script = (call, count) => (count === 1 ? problem(422, 'validation_failed') : Response.json({ resolved: 1 }))
    r.changes.publish(created(1))
    r.changes.publish(moved(1, 'user:1'))
    await settle(r)
    expect(summary(r.notify.calls)).toEqual(['post new', 'resolve new'])
    expect(r.module.stats().dropped.refused).toBe(1)
    const line = r.lines.find((l) => l.includes('status=422')) ?? ''
    expect(line).toContain('code=validation_failed')
    expect(line).not.toMatch(/setup error/)
  })

  it('drops other 4xx at once too', async () => {
    const r = rig()
    r.notify.script = () => problem(422, 'href_not_allowed')
    r.changes.publish(created(1))
    await settle(r)
    expect(r.notify.calls).toHaveLength(1)
    expect(r.module.stats().dropped.refused).toBe(1)
  })

  for (const [status, code] of [
    [401, 'invalid_token'],
    [403, 'post_as_forbidden'],
    [403, 'insufficient_scope'],
    [422, 'unknown_app'],
    [422, 'unknown_role'],
  ] as const) {
    it(`retries ${status} ${code} on the schedule and logs it as a setup error`, async () => {
      const r = rig()
      r.notify.script = () => problem(status, code)
      r.changes.publish(created(1))
      await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 300_000)
      await r.module.idle()
      // A 401 is also retried once at once, with a fresh token.
      expect(r.notify.calls).toHaveLength(status === 401 ? 8 : 4)
      expect(r.module.stats()).toMatchObject({ sent: 0, dropped: { retriesExhausted: 1, refused: 0 } })
      const setup = r.lines.filter((line) => line.includes('setup error'))
      expect(setup.length).toBeGreaterThanOrEqual(4)
      expect(setup[0]).toContain(`code=${code}`)
    })
  }

  it('holds the queue while it retries, so a lead\'s later operations wait their turn', async () => {
    const r = rig()
    r.notify.script = (call, count) => (count === 1 ? problem(503, 'dependency_unavailable') : Response.json({ accepted: 1, skipped: 0 }, { status: 202 }))
    r.changes.publish(created(1))
    r.changes.publish(moved(1))
    await settle(r)
    expect(summary(r.notify.calls)).toEqual(['post new'])
    await vi.advanceTimersByTimeAsync(10_000)
    await r.module.idle()
    expect(summary(r.notify.calls)).toEqual(['post new', 'post new', 'resolve new', 'post moved'])
  })
})

describe('the queue', () => {
  it('past 1,000 waiting operations, drops the oldest and counts them', async () => {
    const r = rig()
    r.notify.script = (call, count) => (count === 1 ? hang() : Response.json({ accepted: 1, skipped: 0 }, { status: 202 }))
    r.changes.publish(created(1))
    await vi.advanceTimersByTimeAsync(0)
    // The first is in flight (hung); 1,005 more wait behind it.
    for (let id = 2; id <= 1_006; id++) r.changes.publish(created(id))
    expect(r.module.stats()).toMatchObject({ queued: 1_000, dropped: { queueFull: 5 } })
    expect(r.lines.filter((line) => line.includes('queue full'))).toHaveLength(5)

    await vi.advanceTimersByTimeAsync(30_000 + 10_000)
    await r.module.idle()
    const keys = r.notify.calls.map((call) => String(call.body['dedupe_key']))
    // Leads 2–6 were the oldest waiting: they are the ones dropped.
    expect(keys.slice(0, 3)).toEqual(['philo:lead:1:new', 'philo:lead:1:new', 'philo:lead:7:new'])
    expect(keys).toHaveLength(1_002)
  })

  it('is dropped on stop, and the feed is let go', async () => {
    const r = rig()
    r.notify.script = () => hang()
    r.changes.publish(created(1))
    r.changes.publish(created(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(r.changes.size).toBe(1)
    r.module.stop()
    expect(r.changes.size).toBe(0)
    expect(r.module.stats().queued).toBe(0)
    r.changes.publish(created(3))
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(r.notify.calls).toHaveLength(1)
  })
})

describe('the listener', () => {
  it('only enqueues: publishing returns before anything is sent', () => {
    const r = rig()
    r.changes.publish(created(1))
    expect(r.notify.calls).toHaveLength(0)
    expect(r.issuer.tokenRequests).toHaveLength(0)
    expect(r.module.stats().queued).toBe(1)
  })

  it('never throws into the feed, whatever the event looks like', () => {
    const r = rig()
    const broken = [
      { id: 'x', type: 'lead.created', occurredAt: '', actor: 'form:x', funnelId: 1, data: { lead: null } },
      { id: 'y', type: 'lead.stage_changed', occurredAt: '', actor: 'api_key:1', funnelId: 1, data: { lead: { id: 'NaN' } } },
      null,
    ] as unknown as ChangeEvent[]
    for (const event of broken) expect(() => r.changes.publish(event)).not.toThrow()
  })
})

describe('when unconfigured', () => {
  it('does not start and does not listen', () => {
    const changes = feed()
    expect(startOberonNotify(changes, undefined)).toBeUndefined()
    expect(changes.size).toBe(0)
  })
})
