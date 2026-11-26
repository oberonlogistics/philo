import type { ChangeEvent } from '@philo/server'
import { describe, expect, it } from 'vitest'
import { BODY_MAX, cleanText, clip, mapChange, TITLE_MAX } from '../../src/oberon/notify-map.ts'
import { APP_URL } from './fakes.ts'

type Lead = NonNullable<ChangeEvent['data']['lead']>

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 42,
    name: 'Dana Rivers',
    email: 'dana@example.com',
    phone: '+1 555 0100',
    source: 'Contact us',
    formId: 1,
    funnelId: 1,
    stageId: 1,
    stageName: 'New',
    isSpam: false,
    fields: {},
    details: {},
    createdAt: '2026-11-26T10:00:00.000Z',
    updatedAt: '2026-11-26T10:00:00.000Z',
    ...overrides,
  }
}

function event(type: ChangeEvent['type'], actor: string, data: ChangeEvent['data']): ChangeEvent {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    type,
    occurredAt: '2026-11-26T10:00:00.000Z',
    actor: actor as ChangeEvent['actor'],
    funnelId: 1,
    data,
  }
}

const FROM = { id: 1, name: 'New', funnelId: 1 }
const HREF = `${APP_URL}/leads/42`

describe('the mapping (§5)', () => {
  it('row 1: a form submission posts `new` as Needs you', () => {
    expect(mapChange(event('lead.created', 'form:abc', { lead: lead() }), APP_URL)).toEqual([
      {
        op: 'post',
        key: 'philo:lead:42:new',
        item: {
          kind: 'action',
          severity: 'info',
          title: 'New lead from Contact us',
          body: 'Waiting in New. Open it to see who it is.',
          href: HREF,
        },
      },
    ])
  })

  it('row 1: a lead promoted out of spam by a person posts `new` too', () => {
    const ops = mapChange(event('lead.created', 'user:1', { lead: lead() }), APP_URL)
    expect(ops.map((op) => `${op.op} ${op.key}`)).toEqual(['post philo:lead:42:new'])
  })

  it('row 1: with no source it says a form', () => {
    for (const source of [null, '', ' \n\t ']) {
      const [op] = mapChange(event('lead.created', 'form:abc', { lead: lead({ source }) }), APP_URL)
      expect(op?.op === 'post' && op.item.title).toBe('New lead from a form')
    }
  })

  it('row 2: an agent filing a lead posts `added` as info', () => {
    for (const actor of ['api_key:3', 'oauth:client-x']) {
      expect(mapChange(event('lead.created', actor, { lead: lead({ formId: null, source: null }) }), APP_URL)).toEqual([
        {
          op: 'post',
          key: 'philo:lead:42:added',
          item: {
            kind: 'info',
            severity: 'info',
            title: 'An agent added a lead',
            body: "It's in New. Open it to see who it is.",
            href: HREF,
          },
        },
      ])
    }
  })

  it('row 2 is off for a person filing a lead in the PWA, and for no actor', () => {
    for (const actor of ['user:1', undefined]) {
      const e = event('lead.created', actor as string, { lead: lead({ formId: null, source: null }) })
      expect(mapChange(e, APP_URL), String(actor)).toEqual([])
    }
  })

  it('row 3: any stage change resolves `new`', () => {
    for (const actor of ['user:1', 'form:abc', undefined]) {
      const e = event('lead.stage_changed', actor as string, { lead: lead({ stageName: 'Called' }), from: FROM })
      expect(mapChange(e, APP_URL), String(actor)).toEqual([{ op: 'resolve', key: 'philo:lead:42:new' }])
    }
  })

  it('row 4: an agent move resolves `new`, then posts `moved`', () => {
    for (const actor of ['api_key:3', 'oauth:client-x']) {
      const e = event('lead.stage_changed', actor, { lead: lead({ stageName: 'Called' }), from: FROM })
      expect(mapChange(e, APP_URL)).toEqual([
        { op: 'resolve', key: 'philo:lead:42:new' },
        {
          op: 'post',
          key: 'philo:lead:42:moved',
          item: {
            kind: 'info',
            severity: 'info',
            title: 'An agent moved a lead to Called',
            body: 'It was in New. Open it to see what changed.',
            href: HREF,
          },
        },
      ])
    }
  })

  it('row 5: a deletion withdraws all three keys', () => {
    expect(mapChange(event('lead.deleted', 'user:1', { leadId: 42 }), APP_URL)).toEqual([
      { op: 'withdraw', key: 'philo:lead:42:new' },
      { op: 'withdraw', key: 'philo:lead:42:added' },
      { op: 'withdraw', key: 'philo:lead:42:moved' },
    ])
  })

  it('row 6: everything else posts nothing', () => {
    expect(mapChange(event('lead.updated', 'api_key:3', { lead: lead() }), APP_URL)).toEqual([])
    expect(mapChange(event('funnel.changed', 'user:1', {}), APP_URL)).toEqual([])
    expect(mapChange(event('lead.created', 'user:1', { lead: lead({ formId: null }) }), APP_URL)).toEqual([])
    expect(mapChange({ ...event('lead.created', 'form:x', {}), type: 'lead.archived' as never }, APP_URL)).toEqual([])
    // A malformed event is ignored, not thrown on.
    expect(mapChange(event('lead.created', 'form:x', {}), APP_URL)).toEqual([])
    expect(mapChange(event('lead.deleted', 'user:1', {}), APP_URL)).toEqual([])
  })

  it('builds the link under an app url with a path or a trailing slash', () => {
    const [op] = mapChange(event('lead.created', 'form:abc', { lead: lead() }), 'https://example.com/crm/')
    expect(op?.op === 'post' && op.item.href).toBe('https://example.com/crm/leads/42')
  })

  it('keeps every key under 40 characters', () => {
    const big = lead({ id: Number.MAX_SAFE_INTEGER })
    const keys = [
      ...mapChange(event('lead.created', 'api_key:1', { lead: { ...big, formId: null } }), APP_URL),
      ...mapChange(event('lead.stage_changed', 'api_key:1', { lead: big, from: FROM }), APP_URL),
    ].map((op) => op.key)
    for (const key of keys) expect(key.length).toBeLessThan(40)
  })
})

describe('no lead data in an item (§6)', () => {
  it('never carries a name, email, phone, field, detail or note', () => {
    const marked = lead({
      name: 'NAME-MARKER',
      email: 'EMAIL-MARKER@example.com',
      phone: 'PHONE-MARKER',
      fields: { message: 'FIELD-MARKER', company: 'FIELD2-MARKER' },
      details: { license: 'DETAIL-MARKER', notes: 'NOTE-MARKER' },
    })
    const ops = [
      ...mapChange(event('lead.created', 'form:abc', { lead: marked }), APP_URL),
      ...mapChange(event('lead.created', 'api_key:3', { lead: { ...marked, formId: null } }), APP_URL),
      ...mapChange(event('lead.stage_changed', 'api_key:3', { lead: marked, from: FROM }), APP_URL),
      ...mapChange(event('lead.deleted', 'api_key:3', { leadId: 42 }), APP_URL),
    ]
    expect(ops.length).toBeGreaterThan(5)
    const text = JSON.stringify(ops)
    expect(text).not.toMatch(/MARKER/)
  })
})

describe('text rules', () => {
  it('cuts a long title at a whole word and ends it in …', () => {
    const stage = 'Waiting for the paperwork to come back from the county office '.repeat(3)
    const e = event('lead.stage_changed', 'api_key:3', { lead: lead({ stageName: stage }), from: FROM })
    const post = mapChange(e, APP_URL)[1]
    const title = post?.op === 'post' ? post.item.title : ''
    expect([...title].length).toBeLessThanOrEqual(TITLE_MAX)
    expect(title.endsWith('…')).toBe(true)
    expect(title).toMatch(/^An agent moved a lead to Waiting for the paperwork/)
    // Cut where a word ended: what precedes … is a whole word of the source.
    const words = title.slice(0, -1).trimEnd().split(' ')
    expect(stage).toContain(` ${words.at(-1)!} `)
  })

  it('cuts a long body too', () => {
    const stage = 'x'.repeat(400)
    const e = event('lead.stage_changed', 'api_key:3', { lead: lead({ stageName: 'Called' }), from: { ...FROM, name: stage } })
    const post = mapChange(e, APP_URL)[1]
    expect(post?.op === 'post' && [...post.item.body].length).toBeLessThanOrEqual(BODY_MAX)
  })

  it('counts code points, not UTF-16 units', () => {
    const emoji = '🚚'.repeat(TITLE_MAX + 5)
    const cut = clip(emoji, TITLE_MAX)
    expect([...cut].length).toBe(TITLE_MAX)
    expect(cut.endsWith('…')).toBe(true)
    expect(clip('🚚'.repeat(TITLE_MAX), TITLE_MAX + 1)).toBe('🚚'.repeat(TITLE_MAX))
  })

  it('keeps control and bidi characters and line breaks out of the item', () => {
    const nasty = 'Call\nback\r\n\tsoon\u0000\u0007\u0085\u2028\u2029\u202Eevil\u2066\u2069\u061C\u200B\uFEFF'
    const e = event('lead.stage_changed', 'api_key:3', { lead: lead({ stageName: nasty }), from: { ...FROM, name: nasty } })
    for (const op of [...mapChange(e, APP_URL), ...mapChange(event('lead.created', 'form:x', { lead: lead({ source: nasty }) }), APP_URL)]) {
      if (op.op !== 'post') continue
      expect(`${op.item.title} ${op.item.body}`).toContain('Call back soon evil')
      for (const text of [op.item.title, op.item.body]) {
        // eslint-disable-next-line no-control-regex
        expect(text).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u061C\u202A-\u202E\u2066-\u2069\u200B\uFEFF]/)
      }
    }
  })

  it('collapses white space and drops a lone surrogate', () => {
    expect(cleanText('  a \n\n b  c  ')).toBe('a b c')
    expect(cleanText('ok\uD800 then')).toBe('ok then')
    expect(cleanText('🚚 truck')).toBe('🚚 truck')
  })

  it('names a stage that cleans to nothing', () => {
    const e = event('lead.created', 'form:x', { lead: lead({ stageName: '\u200B\n' }) })
    const [op] = mapChange(e, APP_URL)
    expect(op?.op === 'post' && op.item.body).toBe('Waiting in an unnamed stage. Open it to see who it is.')
  })
})
