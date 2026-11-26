import { describe, expect, it } from 'vitest'
import { loadOberonNotifyConfig, OberonNotifyConfigError } from '../../src/oberon/notify-config.ts'
import { CLIENT_SECRET } from './fakes.ts'

const PHILO = { appUrl: 'https://philo.example.com', externalIdp: undefined }
const PHILO_WITH_IDP = {
  appUrl: 'https://philo.example.com',
  externalIdp: { issuer: 'https://auth.example.com', clientId: 'philo', audience: undefined },
}

const FULL = {
  OL_NOTIFY_URL: 'https://notify.example.com',
  OL_NOTIFY_ISSUER: 'https://auth.example.com',
  OL_NOTIFY_CLIENT_ID: 'philo-notify',
  OL_NOTIFY_CLIENT_SECRET: CLIENT_SECRET,
  OL_NOTIFY_AS: 'philo',
  OL_NOTIFY_ROLE: 'philo-users',
}

function refusal(env: Record<string, string>, philo: Parameters<typeof loadOberonNotifyConfig>[1] = PHILO): string {
  try {
    loadOberonNotifyConfig(env, philo)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(OberonNotifyConfigError)
    return (error as Error).message
  }
  throw new Error('expected the configuration to be refused')
}

describe('configuration (§12.3)', () => {
  it('is off when no OL_NOTIFY_ variable is set', () => {
    expect(loadOberonNotifyConfig({ PHILO_PORT: '3000', NODE_ENV: 'production' }, PHILO)).toBeUndefined()
    // Set but empty counts as unset, as in Philo's own config.
    expect(loadOberonNotifyConfig({ OL_NOTIFY_URL: '' }, PHILO)).toBeUndefined()
  })

  it('reads a full set, with the resource defaulting to the url', () => {
    expect(loadOberonNotifyConfig(FULL, PHILO)).toEqual({
      url: 'https://notify.example.com',
      resource: 'https://notify.example.com',
      issuer: 'https://auth.example.com',
      clientId: 'philo-notify',
      clientSecret: CLIENT_SECRET,
      as: 'philo',
      role: 'philo-users',
      appUrl: 'https://philo.example.com',
    })
  })

  it('takes an explicit resource, and the issuer from the external IdP', () => {
    const { OL_NOTIFY_ISSUER: _, ...rest } = FULL
    const config = loadOberonNotifyConfig({ ...rest, OL_NOTIFY_RESOURCE: 'https://notify.example.com/api' }, PHILO_WITH_IDP)
    expect(config?.resource).toBe('https://notify.example.com/api')
    expect(config?.issuer).toBe('https://auth.example.com')
  })

  it('refuses a partial set, naming every missing variable and showing no value', () => {
    const message = refusal({ OL_NOTIFY_CLIENT_SECRET: CLIENT_SECRET, OL_NOTIFY_AS: 'philo' })
    for (const name of ['OL_NOTIFY_URL', 'OL_NOTIFY_ISSUER', 'OL_NOTIFY_CLIENT_ID', 'OL_NOTIFY_ROLE']) {
      expect(message).toContain(name)
    }
    expect(message).not.toContain('OL_NOTIFY_AS')
    expect(message).not.toContain(CLIENT_SECRET)
  })

  it('refuses invalid values, naming the variable and showing no value', () => {
    const bad = {
      ...FULL,
      OL_NOTIFY_URL: 'notify.example.com',
      OL_NOTIFY_ISSUER: 'https://auth.example.com/',
      OL_NOTIFY_RESOURCE: 'https://notify.example.com/',
      OL_NOTIFY_AS: 'has space',
      OL_NOTIFY_ROLE: '-leading-dash',
    }
    const message = refusal(bad)
    for (const name of ['OL_NOTIFY_URL', 'OL_NOTIFY_ISSUER', 'OL_NOTIFY_RESOURCE', 'OL_NOTIFY_AS', 'OL_NOTIFY_ROLE']) {
      expect(message).toContain(name)
    }
    for (const value of ['notify.example.com', 'has space', '-leading-dash', CLIENT_SECRET]) {
      expect(message).not.toContain(value)
    }
  })

  it('wants the url to be an origin', () => {
    expect(refusal({ ...FULL, OL_NOTIFY_URL: 'https://notify.example.com/v1' })).toContain('OL_NOTIFY_URL')
  })

  it('refuses http in production, for Notify, the issuer and the links', () => {
    const plain = { ...FULL, OL_NOTIFY_URL: 'http://notify.example.com', OL_NOTIFY_ISSUER: 'http://auth.example.com' }
    const message = refusal({ ...plain, NODE_ENV: 'production' }, { ...PHILO, appUrl: 'http://philo.example.com' })
    for (const name of ['OL_NOTIFY_URL', 'OL_NOTIFY_ISSUER', 'PHILO_APP_URL']) expect(message).toContain(name)
    // Outside production a development stack is plain http.
    expect(loadOberonNotifyConfig(plain, { ...PHILO, appUrl: 'http://localhost:3000' })?.url).toBe('http://notify.example.com')
  })
})
