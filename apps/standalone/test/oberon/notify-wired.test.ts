/*
 * The module listening to a real Philo's change feed (`createApp`), with the
 * fake issuer and the fake Notify behind it. What Philo does on a request must
 * not depend on anything Notify does.
 */

import { desc } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { leads } from '../../../../packages/server/src/db/schema.ts'
import { ChangeFeed } from '../../../../packages/server/src/events/feed.ts'
import { HONEYPOT_FIELD } from '../../../../packages/server/src/intake/payload.ts'
import type { CreatedLead } from '../../../../packages/server/src/notify.ts'
import {
  agentAuth,
  cleanupTestApps,
  createTestApp,
  defaultFormKey,
  jsonPost,
  setupAdmin,
  type TestApp,
} from '../../../../packages/server/test/support/app.ts'
import { startOberonNotify, type OberonNotify } from '../../src/oberon/notify.ts'
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

const started: OberonNotify[] = []
const logs: string[][] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  for (const module of started.splice(0)) module.stop()
  for (const lines of logs.splice(0)) {
    const text = lines.join('\n')
    for (const marker of ['MARKER', TOKEN_PREFIX, CLIENT_SECRET, 'New lead from', 'Waiting in', 'An agent']) {
      expect(text, marker).not.toContain(marker)
    }
  }
  cleanupTestApps()
  vi.restoreAllMocks()
})

interface Philo {
  testApp: TestApp
  notify: ReturnType<typeof fakeNotify>
  module: OberonNotify
  hooked: CreatedLead[]
  authorization: string
  userId: number
  api: (path: string, init?: RequestInit, authorization?: string) => Promise<Response>
}

async function philo(options: { fetch?: typeof fetch; url?: string } = {}): Promise<Philo> {
  const changeFeed = new ChangeFeed()
  const hooked: CreatedLead[] = []
  // Stands in for the email and push hooks: what bootServer wires to onLeadCreated.
  const testApp = createTestApp({ changeFeed, onLeadCreated: (lead) => hooked.push(lead) })
  const notify = fakeNotify()
  const { log, lines } = captureLog()
  logs.push(lines)
  const module = startOberonNotify(
    changeFeed,
    { ...CONFIG, url: options.url ?? CONFIG.url },
    { fetch: options.fetch ?? route({ [ISSUER]: fakeIssuer().handler, [NOTIFY_URL]: notify.handler }), log },
  )
  if (module === undefined) throw new Error('module did not start')
  started.push(module)
  const authorization = await setupAdmin(testApp)
  const api = async (path: string, init: RequestInit = {}, as = authorization) =>
    await testApp.app.request(`/api/v1${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: as },
    })
  return { testApp, notify, module, hooked, authorization, userId: 1, api }
}

async function submit(p: Philo, body: Record<string, unknown>): Promise<{ id: number; res: Response; ms: number }> {
  const t0 = performance.now()
  const res = await p.testApp.app.request(`/api/intake/${defaultFormKey(p.testApp)}`, jsonPost(body))
  const ms = performance.now() - t0
  const [row] = p.testApp.db.select({ id: leads.id }).from(leads).orderBy(desc(leads.id)).limit(1).all()
  return { id: row!.id, res, ms }
}

async function secondStage(p: Philo): Promise<number> {
  const res = await p.api('/stages')
  const { stages } = (await res.json()) as { stages: { id: number }[] }
  return stages[1]!.id
}

let submissions = 0
/** Lead data as marker strings, different each time so intake's dedupe window lets it through. */
function marked() {
  submissions++
  return {
    name: `NAME-MARKER-${submissions}`,
    email: `email-MARKER-${submissions}@example.com`,
    phone: '555-MARKER',
    message: 'FIELD-MARKER',
  }
}

describe('wired into Philo', () => {
  it('posts one item for a form submission, with no lead data in it', async () => {
    const p = await philo()
    const { id, res } = await submit(p, marked())
    expect(res.status).toBe(201)
    await p.module.idle()

    expect(summary(p.notify.calls)).toEqual(['post new'])
    expect(p.notify.calls[0]?.body).toMatchObject({
      as: 'philo',
      to: { roles: ['philo-users'] },
      kind: 'action',
      href: `https://philo.example.com/leads/${id}`,
      dedupe_key: `philo:lead:${id}:new`,
    })
    expect(JSON.stringify(p.notify.calls.map((call) => call.body))).not.toContain('MARKER')
  })

  it('posts nothing for spam, and once when it is promoted', async () => {
    const p = await philo()
    const { id } = await submit(p, { email: 'bot@example.com', [HONEYPOT_FIELD]: 'x' })
    await p.module.idle()
    expect(p.notify.calls).toHaveLength(0)

    expect((await p.api(`/leads/${id}/not-spam`, { method: 'POST' })).status).toBe(200)
    await p.module.idle()
    expect(summary(p.notify.calls)).toEqual(['post new'])
  })

  it('an agent move resolves and posts `moved`; a person\'s move only resolves; a deletion withdraws', async () => {
    const p = await philo()
    const { id } = await submit(p, marked())
    const stageId = await secondStage(p)

    const keyRes = await p.api('/api-keys', jsonPost({ name: 'Agent' }))
    const { secret } = (await keyRes.json()) as { secret: string }
    expect((await p.api(`/leads/${id}/stage`, jsonPost({ stageId }), `Bearer ${secret}`)).status).toBe(200)
    await p.module.idle()
    expect(summary(p.notify.calls)).toEqual(['post new', 'resolve new', 'post moved'])

    const { id: second } = await submit(p, marked())
    expect((await p.api(`/leads/${second}/stage`, jsonPost({ stageId }))).status).toBe(200)
    expect((await p.api(`/leads/${id}`, { method: 'DELETE' })).status).toBe(204)
    await p.module.idle()
    expect(summary(p.notify.calls.slice(3))).toEqual(['post new', 'resolve new', 'withdraw new', 'withdraw added', 'withdraw moved'])
    expect(String(p.notify.calls.at(-1)?.body['dedupe_key'])).toBe(`philo:lead:${id}:moved`)
  })

  it('an agent filing a lead posts `added`; a person filing one posts nothing', async () => {
    const p = await philo()
    const { authorization: agent } = await agentAuth(p.testApp, p.userId)
    expect((await p.api('/leads', jsonPost({ name: 'NAME-MARKER', email: 'MARKER@example.com' }), agent)).status).toBe(201)
    expect((await p.api('/leads', jsonPost({ name: 'NAME-MARKER', email: 'MARKER@example.com' }))).status).toBe(201)
    await p.module.idle()
    expect(summary(p.notify.calls)).toEqual(['post added'])
  })

  const failures: [string, (n: ReturnType<typeof fakeNotify>) => void][] = [
    ['answering 500', (n) => {
      n.script = () => problem(500, 'internal_error')
    }],
    ['hanging', (n) => {
      n.script = () => hang()
    }],
  ]
  for (const [what, breakNotify] of failures) {
    it(`with Notify ${what}, intake still answers 201 at once and the email and push hooks still run`, async () => {
      const p = await philo()
      breakNotify(p.notify)
      for (let i = 0; i < 3; i++) {
        const { res, ms } = await submit(p, marked())
        expect(res.status).toBe(201)
        expect(ms).toBeLessThan(1_000)
      }
      expect(p.hooked).toHaveLength(3)
      // A person's move answers just as fast while the queue is stuck.
      const stageId = await secondStage(p)
      const t0 = performance.now()
      expect((await p.api('/leads/1/stage', jsonPost({ stageId }))).status).toBe(200)
      expect(performance.now() - t0).toBeLessThan(1_000)
    })
  }

  it('with Notify unreachable over a real socket, intake still answers 201 and the hooks run', async () => {
    // Port 1 on loopback: nothing listens there, so the connection is refused.
    const p = await philo({ fetch: route({ [ISSUER]: fakeIssuer().handler, 'http://127.0.0.1:1': (r) => fetch(r) }), url: 'http://127.0.0.1:1' })
    const { res, ms } = await submit(p, marked())
    expect(res.status).toBe(201)
    expect(ms).toBeLessThan(1_000)
    expect(p.hooked).toHaveLength(1)
    await p.module.idle()
    expect(p.module.stats().sent).toBe(0)
    expect(logs.at(-1)?.join('\n')).toMatch(/retrying/)
  })
})
