/*
 * Which of Philo's change events become items in the shared Oberon Logistics
 * feed, and what those items say: the mapping table of
 * oberon/docs/notifications.md §5, its text rules, and §6's rule that no item
 * carries lead data. Pure: no I/O, so every row is tested directly.
 */

import type { ChangeEvent } from '@philo/server'

/** Notify's limits, in code points (Notify SPEC §4.1). */
export const TITLE_MAX = 120
export const BODY_MAX = 280

export interface FeedItem {
  kind: 'info' | 'action'
  severity: 'info'
  title: string
  body: string
  href: string
}

export type NotifyOperation =
  | { op: 'post'; key: string; item: FeedItem }
  | { op: 'resolve'; key: string }
  | { op: 'withdraw'; key: string }

type What = 'new' | 'added' | 'moved'

function keyOf(leadId: number, what: What): string {
  return `philo:lead:${leadId}:${what}`
}

/**
 * An agent: an API key or an OAuth client, working with nobody watching
 * (ADR-0007). A person in the PWA is `user:`, and intake is `form:`.
 */
function isAgent(actor: unknown): boolean {
  return typeof actor === 'string' && (actor.startsWith('api_key:') || actor.startsWith('oauth:'))
}

function isLeadId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * The operations one change event asks for, in the order they must be sent.
 * Anything not in the table, or not shaped as expected, gives none.
 */
export function mapChange(event: ChangeEvent, appUrl: string): NotifyOperation[] {
  const { lead, leadId, from } = event.data
  switch (event.type) {
    case 'lead.created': {
      if (lead === undefined || lead === null || !isLeadId(lead.id)) return []
      const stage = name(lead.stageName, 'an unnamed stage')
      if (lead.formId !== null) {
        const source = cleanText(lead.source ?? '')
        return [
          post(lead.id, 'new', appUrl, 'action', `New lead from ${source === '' ? 'a form' : source}`, `Waiting in ${stage}. Open it to see who it is.`),
        ]
      }
      if (isAgent(event.actor)) {
        return [post(lead.id, 'added', appUrl, 'info', 'An agent added a lead', `It's in ${stage}. Open it to see who it is.`)]
      }
      return []
    }
    case 'lead.stage_changed': {
      if (lead === undefined || lead === null || !isLeadId(lead.id)) return []
      const resolve: NotifyOperation = { op: 'resolve', key: keyOf(lead.id, 'new') }
      if (!isAgent(event.actor)) return [resolve]
      const stage = name(lead.stageName, 'an unnamed stage')
      const was = name(from?.name, 'another stage')
      return [
        resolve,
        post(lead.id, 'moved', appUrl, 'info', `An agent moved a lead to ${stage}`, `It was in ${was}. Open it to see what changed.`),
      ]
    }
    case 'lead.deleted': {
      if (!isLeadId(leadId)) return []
      return (['new', 'added', 'moved'] as const).map((what) => ({ op: 'withdraw', key: keyOf(leadId, what) }))
    }
    default:
      return []
  }
}

function post(leadId: number, what: What, appUrl: string, kind: FeedItem['kind'], title: string, body: string): NotifyOperation {
  return {
    op: 'post',
    key: keyOf(leadId, what),
    item: { kind, severity: 'info', title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX), href: leadHref(appUrl, leadId) },
  }
}

/** The lead's page in the PWA: the link push and email use too. */
export function leadHref(appUrl: string, leadId: number): string {
  return `${appUrl.replace(/\/+$/, '')}/leads/${leadId}`
}

function name(raw: unknown, fallback: string): string {
  const cleaned = typeof raw === 'string' ? cleanText(raw) : ''
  return cleaned === '' ? fallback : cleaned
}

/**
 * An operator's name for a form or stage, made safe for Notify's text rules:
 * white space (line breaks included) collapsed to single spaces; control,
 * format (bidi controls, zero-width characters) and lone surrogate characters
 * removed.
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/[\s\p{Zs}\u0085\u2028\u2029]+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * At most `max` code points. Longer text is cut after the last whole word that
 * fits and ends in `…`; a single word longer than that is cut where it must be.
 */
export function clip(text: string, max: number): string {
  const points = [...text]
  if (points.length <= max) return text
  const room = points.slice(0, max - 1).join('')
  const space = room.lastIndexOf(' ')
  const cut = space > 0 && points[max - 1] !== ' ' ? room.slice(0, space) : room
  return `${cut.trimEnd()}…`
}
