/*
 * The OL_NOTIFY_* variables (oberon/docs/notifications.md §12.3). None set:
 * the module is off and Philo runs as upstream. Some set, or a value invalid:
 * boot fails with one message that names every variable at fault and never
 * shows a value, because one of them is a client secret.
 */

export interface OberonNotifyConfig {
  /** Notify's origin. */
  url: string
  /** Notify's resource identifier: the audience the token is asked for. */
  resource: string
  /** The OL Auth issuer, as its tokens' `iss` states it. */
  issuer: string
  clientId: string
  clientSecret: string
  /** The client id of Philo's tile: what items are posted `as`. */
  as: string
  /** The role whose members get the items. */
  role: string
  /** Where the PWA is served: items link to a lead's page under it. */
  appUrl: string
}

/** The parts of Philo's own config this reads. */
export interface PhiloConfigPart {
  appUrl: string
  externalIdp: { issuer: string } | undefined
}

export class OberonNotifyConfigError extends Error {
  override name = 'OberonNotifyConfigError'
}

const NAMES = [
  'OL_NOTIFY_URL',
  'OL_NOTIFY_RESOURCE',
  'OL_NOTIFY_ISSUER',
  'OL_NOTIFY_CLIENT_ID',
  'OL_NOTIFY_CLIENT_SECRET',
  'OL_NOTIFY_AS',
  'OL_NOTIFY_ROLE',
] as const

/** Notify's identifier rule (SPEC §4.1 rule 6), for `as` and roles. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export function loadOberonNotifyConfig(
  env: Record<string, string | undefined>,
  philo: PhiloConfigPart,
): OberonNotifyConfig | undefined {
  const value = (name: (typeof NAMES)[number]): string | undefined => {
    const raw = env[name]
    return raw === undefined || raw === '' ? undefined : raw
  }
  if (NAMES.every((name) => value(name) === undefined)) return undefined

  const production = env['NODE_ENV'] === 'production'
  const missing: string[] = []
  const invalid: string[] = []

  const url = value('OL_NOTIFY_URL')
  const resource = value('OL_NOTIFY_RESOURCE') ?? url
  const issuer = value('OL_NOTIFY_ISSUER') ?? philo.externalIdp?.issuer
  const clientId = value('OL_NOTIFY_CLIENT_ID')
  const clientSecret = value('OL_NOTIFY_CLIENT_SECRET')
  const as = value('OL_NOTIFY_AS')
  const role = value('OL_NOTIFY_ROLE')

  const required: [string, string | undefined][] = [
    ['OL_NOTIFY_URL', url],
    ['OL_NOTIFY_ISSUER', issuer],
    ['OL_NOTIFY_CLIENT_ID', clientId],
    ['OL_NOTIFY_CLIENT_SECRET', clientSecret],
    ['OL_NOTIFY_AS', as],
    ['OL_NOTIFY_ROLE', role],
  ]
  for (const [name, present] of required) if (present === undefined) missing.push(name)

  // Notify's origin: a URL with nothing after the host but a lone `/`.
  if (url !== undefined && !isUrl(url, production, (u) => u.pathname === '/' && u.search === '' && u.hash === '')) {
    invalid.push('OL_NOTIFY_URL')
  }
  // Compared byte for byte at the other end, so no trailing slash.
  if (value('OL_NOTIFY_RESOURCE') !== undefined && !isUrl(resource!, production, () => !resource!.endsWith('/'))) {
    invalid.push('OL_NOTIFY_RESOURCE')
  }
  if (issuer !== undefined && !isUrl(issuer, production, () => !issuer.endsWith('/'))) {
    invalid.push(value('OL_NOTIFY_ISSUER') === undefined ? 'PHILO_OIDC_ISSUER (the default for OL_NOTIFY_ISSUER)' : 'OL_NOTIFY_ISSUER')
  }
  if (as !== undefined && !IDENTIFIER.test(as)) invalid.push('OL_NOTIFY_AS')
  if (role !== undefined && !IDENTIFIER.test(role)) invalid.push('OL_NOTIFY_ROLE')
  // Notify accepts an https link only (SPEC §4.1 rule 5).
  if (!isUrl(philo.appUrl, production, () => true)) invalid.push('PHILO_APP_URL (the links in feed items)')

  if (missing.length > 0 || invalid.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`)
    if (invalid.length > 0) {
      parts.push(`invalid ${invalid.join(', ')} (an absolute URL${production ? ', https in production' : ''}; Notify's URL an origin; the issuer and resource with no trailing slash; OL_NOTIFY_AS and OL_NOTIFY_ROLE identifiers)`)
    }
    throw new OberonNotifyConfigError(
      `The shared notification feed is half configured: ${parts.join('; ')}. Set all of the OL_NOTIFY_ variables, or none.`,
    )
  }

  return {
    url: new URL(url!).origin,
    resource: resource!,
    issuer: issuer!,
    clientId: clientId!,
    clientSecret: clientSecret!,
    as: as!,
    role: role!,
    appUrl: philo.appUrl,
  }
}

function isUrl(raw: string, production: boolean, also: (url: URL) => boolean): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '') return false
  if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) return false
  return also(url)
}
