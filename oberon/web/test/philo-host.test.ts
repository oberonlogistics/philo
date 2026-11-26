// Tests for oberon/web/philo-host.js against a stub chrome written here. The
// stub only records what the host asks of it and defines empty custom
// elements; nothing in it comes from the shared chrome's own source.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const HOST_SOURCE = readFileSync(join(import.meta.dirname, '..', 'philo-host.js'), 'utf8')
const ISSUER = 'https://auth.example.test'
const CHROME_URL = `${ISSUER}/chrome/v1/ol-chrome.js`
const NOTIFY = 'https://notify.example.test'

type Theme = 'light' | 'dark' | 'system'
type TokenRequest = { resource: string; scope: string; prompt?: string }
type ChromeOptions = {
  issuer: string
  notifyUrl?: string
  getToken: (request: { audience: string }) => Promise<string | null>
  onSignOut: () => void
}
type Stub = { configure: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> }
type Mount = { replaces?: readonly string[] } | void

declare global {
  interface Window {
    PhiloHost?: { mount(ctx: unknown): Promise<Mount> }
    OLChrome?: Stub
  }
}

const TAGS = ['ol-notifications', 'ol-app-switcher', 'ol-account-menu', 'ol-search-button']

/**
 * What the stub elements do when they connect. The registry outlives a test, so the elements are defined once and
 * each test sets this hook. The default attaches an open shadow root, as every chrome element does.
 */
let onConnect: (el: HTMLElement) => void
/** The order of connects and chrome calls, for tests that care about it. */
let calls: string[]

/** What the real ol-chrome.js would do when it runs: define the elements and window.OLChrome. */
function runStubChrome(): Stub {
  for (const tag of TAGS) {
    if (!customElements.get(tag)) {
      customElements.define(
        tag,
        class extends HTMLElement {
          connectedCallback() {
            calls.push(`connect ${this.localName}`)
            onConnect(this)
          }
        },
      )
    }
  }
  const stub = {
    configure: vi.fn(() => void calls.push('configure')),
    refresh: vi.fn(() => void calls.push('refresh')),
  }
  window.OLChrome = stub
  return stub
}

function chromeScript(): HTMLScriptElement | null {
  return document.head.querySelector<HTMLScriptElement>(`script[src="${CHROME_URL}"]`)
}

/** Let promise callbacks and MutationObserver records run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A controllable matchMedia: one query list per query string. */
function stubMatchMedia(initial: boolean) {
  const lists = new Map<string, { matches: boolean; listeners: Set<(e: { matches: boolean }) => void> }>()
  window.matchMedia = vi.fn((query: string) => {
    let list = lists.get(query)
    if (!list) {
      list = { matches: initial, listeners: new Set() }
      lists.set(query, list)
    }
    const l = list
    return {
      get matches() {
        return l.matches
      },
      media: query,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => l.listeners.add(fn),
      removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => l.listeners.delete(fn),
    } as unknown as MediaQueryList
  }) as unknown as typeof window.matchMedia
  return {
    lists,
    set(query: string, matches: boolean) {
      const list = lists.get(query)
      if (!list) throw new Error(`nobody asked for ${query}`)
      list.matches = matches
      // A copy, so a listener that removes itself does not skip the next.
      for (const fn of Array.from(list.listeners)) fn({ matches })
    },
  }
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const controller = new AbortController()
  const slot = document.createElement('div')
  slot.className = 'host-slot'
  document.body.append(slot)
  const setTheme = vi.fn((theme: Theme) => {
    // Philo's own store writes the same attribute back, as theme.ts does.
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  })
  const ctx = {
    version: 1,
    slot,
    issuer: ISSUER,
    clientId: 'philo',
    user: { email: 'pat@example.com', name: 'Pat Example' },
    role: 'admin',
    config: { notifyUrl: NOTIFY, notifyResource: NOTIFY },
    getToken: vi.fn(async (_: TokenRequest): Promise<string | null> => 'token'),
    navigate: vi.fn(),
    signOut: vi.fn(),
    fallback: vi.fn(),
    setTheme,
    accountItems: [
      { label: 'Server settings', path: '/settings' },
      { label: 'Install the app', path: '/install' },
    ],
    signal: controller.signal,
    ...overrides,
  }
  return { ctx, controller }
}

/** Mount, let the stub chrome "load", and return the mount result. */
async function mountWithChrome(ctx: ReturnType<typeof makeCtx>['ctx']) {
  const result = window.PhiloHost!.mount(ctx)
  await flush()
  const script = chromeScript()
  if (!script) throw new Error('no chrome script was injected')
  const stub = runStubChrome()
  script.dispatchEvent(new Event('load'))
  return { result: await result, stub }
}

function lastOptions(stub: Stub): ChromeOptions {
  return stub.configure.mock.calls.at(-1)![0] as ChromeOptions
}

beforeEach(() => {
  delete window.OLChrome
  delete window.PhiloHost
  document.head.replaceChildren()
  document.body.replaceChildren()
  delete document.documentElement.dataset.theme
  stubMatchMedia(false)
  calls = []
  onConnect = (el) => {
    if (!el.shadowRoot) el.attachShadow({ mode: 'open' })
  }
  ;(0, eval)(HOST_SOURCE)
})

describe('philo-host.js', () => {
  it('defines window.PhiloHost with a mount function', () => {
    expect(typeof window.PhiloHost?.mount).toBe('function')
  })

  it('adds the tokens, fonts and mapping stylesheets in order, then the chrome script', async () => {
    const { ctx } = makeCtx({ issuer: `${ISSUER}/` })
    window.PhiloHost!.mount(ctx).catch(() => undefined)
    await flush()
    const links = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      `${ISSUER}/chrome/v1/tokens.css`,
      `${ISSUER}/chrome/v1/fonts.css`,
      '/oberon/philo-ol.css',
    ])
    const script = chromeScript()!
    expect(script).not.toBeNull()
    expect(script.async).toBe(true)
    // CORS mode, so the chrome's own errors reach the host unmuted (OL Auth sends ACAO to launch origins).
    expect(script.crossOrigin).toBe('anonymous')
    expect(script.dataset.issuer).toBe(ISSUER)
    expect('deferConfig' in script.dataset).toBe(true)
    // The scripts come after the stylesheets, so the mapping sees the tokens.
    expect(document.head.lastElementChild).toBe(script)
  })

  it('fills the slot with the bell, the switcher and the account menu, in that order', async () => {
    const { ctx } = makeCtx()
    const { result } = await mountWithChrome(ctx)
    expect(result).toEqual({ replaces: ['account-menu'] })
    const tags = [...ctx.slot.children].map((el) => el.localName)
    expect(tags).toEqual(['ol-notifications', 'ol-app-switcher', 'ol-account-menu'])
    expect(ctx.slot.querySelector('ol-app-switcher')!.getAttribute('current')).toBe('philo')
    // New leads already reach the person by push and email: no toasts on the bell.
    expect(ctx.slot.querySelector('ol-notifications')!.hasAttribute('toast-new')).toBe(false)
  })

  it('uses ctx.clientId for the current tile', async () => {
    const { ctx } = makeCtx({ clientId: 'philo-staging' })
    await mountWithChrome(ctx)
    expect(ctx.slot.querySelector('ol-app-switcher')!.getAttribute('current')).toBe('philo-staging')
  })

  it('shows no bell and passes no notifyUrl when ctx.config has none', async () => {
    const { ctx } = makeCtx({ config: {} })
    const { stub } = await mountWithChrome(ctx)
    expect(ctx.slot.querySelector('ol-notifications')).toBeNull()
    expect([...ctx.slot.children].map((el) => el.localName)).toEqual(['ol-app-switcher', 'ol-account-menu'])
    expect(lastOptions(stub).notifyUrl).toBeUndefined()
  })

  it('configures the chrome once with the issuer, notifyUrl, getToken and onSignOut', async () => {
    const { ctx } = makeCtx()
    const { stub } = await mountWithChrome(ctx)
    expect(stub.configure).toHaveBeenCalledTimes(1)
    const options = lastOptions(stub)
    expect(options.issuer).toBe(ISSUER)
    expect(options.notifyUrl).toBe(NOTIFY)
    expect(typeof options.getToken).toBe('function')
    expect(typeof options.onSignOut).toBe('function')
  })

  describe('getToken', () => {
    it('asks for the OL Auth API and the notify resource with their scopes and no prompt', async () => {
      const { ctx } = makeCtx()
      const { stub } = await mountWithChrome(ctx)
      const { getToken } = lastOptions(stub)

      await expect(getToken({ audience: 'auth' })).resolves.toBe('token')
      await expect(getToken({ audience: 'notify' })).resolves.toBe('token')
      expect(ctx.getToken.mock.calls).toEqual([
        [{ resource: `${ISSUER}/api`, scope: 'auth:apps auth:account' }],
        [{ resource: NOTIFY, scope: 'notify:read' }],
      ])
      for (const [request] of ctx.getToken.mock.calls) expect('prompt' in request).toBe(false)
    })

    it('answers null for any other audience without asking Philo', async () => {
      const { ctx } = makeCtx()
      const { stub } = await mountWithChrome(ctx)
      const { getToken } = lastOptions(stub)
      for (const audience of ['philo', 'api', '', 'AUTH', 'https://philo.example.test']) {
        await expect(getToken({ audience })).resolves.toBeNull()
      }
      await expect(getToken({} as { audience: string })).resolves.toBeNull()
      expect(ctx.getToken).not.toHaveBeenCalled()
    })

    it('answers null for notify when ctx.config names no notify resource', async () => {
      const { ctx } = makeCtx({ config: { notifyUrl: NOTIFY } })
      const { stub } = await mountWithChrome(ctx)
      await expect(lastOptions(stub).getToken({ audience: 'notify' })).resolves.toBeNull()
      expect(ctx.getToken).not.toHaveBeenCalled()
    })

    it("passes Philo's null through and turns a throw into null", async () => {
      const { ctx } = makeCtx()
      ctx.getToken.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('boom'))
      const { stub } = await mountWithChrome(ctx)
      const { getToken } = lastOptions(stub)
      await expect(getToken({ audience: 'auth' })).resolves.toBeNull()
      await expect(getToken({ audience: 'auth' })).resolves.toBeNull()
    })

    it('answers null without asking once the signal has aborted', async () => {
      const { ctx, controller } = makeCtx()
      const { stub } = await mountWithChrome(ctx)
      controller.abort()
      await expect(lastOptions(stub).getToken({ audience: 'auth' })).resolves.toBeNull()
      expect(ctx.getToken).not.toHaveBeenCalled()
    })
  })

  it("puts Philo's account items in the menu and routes them in the app", async () => {
    const { ctx } = makeCtx()
    await mountWithChrome(ctx)
    const items = [...ctx.slot.querySelectorAll<HTMLAnchorElement>('ol-account-menu > a[slot="item"]')]
    expect(items.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Server settings', '/settings'],
      ['Install the app', '/install'],
    ])

    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    items[0].dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(ctx.navigate).toHaveBeenCalledWith('/settings')

    // A modified click is the browser's (a new tab), not the router's.
    const ctrl = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
    items[1].dispatchEvent(ctrl)
    expect(ctrl.defaultPrevented).toBe(false)
    expect(ctx.navigate).toHaveBeenCalledTimes(1)
  })

  it('makes the account menu compact below 760 px, following the media query', async () => {
    const media = stubMatchMedia(true)
    const { ctx } = makeCtx()
    await mountWithChrome(ctx)
    const menu = ctx.slot.querySelector('ol-account-menu')!
    expect([...media.lists.keys()]).toEqual(['(max-width: 760px)'])
    expect(menu.hasAttribute('compact')).toBe(true)
    media.set('(max-width: 760px)', false)
    expect(menu.hasAttribute('compact')).toBe(false)
    media.set('(max-width: 760px)', true)
    expect(menu.hasAttribute('compact')).toBe(true)
  })

  it('works without matchMedia', async () => {
    ;(window as { matchMedia?: unknown }).matchMedia = undefined
    const { ctx } = makeCtx()
    const { result } = await mountWithChrome(ctx)
    expect(result).toEqual({ replaces: ['account-menu'] })
    expect(ctx.slot.querySelector('ol-account-menu')!.hasAttribute('compact')).toBe(false)
  })

  it('calls ctx.signOut when the chrome signs out', async () => {
    const { ctx } = makeCtx()
    const { stub } = await mountWithChrome(ctx)
    lastOptions(stub).onSignOut()
    expect(ctx.signOut).toHaveBeenCalledTimes(1)
  })

  describe('theme sync', () => {
    it('reports each data-theme change to ctx.setTheme once, without looping', async () => {
      const { ctx } = makeCtx()
      await mountWithChrome(ctx)

      document.documentElement.dataset.theme = 'dark'
      await flush()
      await flush()
      expect(ctx.setTheme.mock.calls).toEqual([['dark']])

      delete document.documentElement.dataset.theme
      await flush()
      await flush()
      expect(ctx.setTheme.mock.calls).toEqual([['dark'], ['system']])

      document.documentElement.dataset.theme = 'light'
      await flush()
      await flush()
      expect(ctx.setTheme.mock.calls).toEqual([['dark'], ['system'], ['light']])
    })

    it('ignores values that are not a theme', async () => {
      const { ctx } = makeCtx()
      await mountWithChrome(ctx)
      document.documentElement.dataset.theme = 'sepia'
      await flush()
      expect(ctx.setTheme).not.toHaveBeenCalled()
    })

    it('reports a theme the chrome applied while it loaded', async () => {
      const { ctx } = makeCtx()
      const pending = window.PhiloHost!.mount(ctx)
      await flush()
      const stub = runStubChrome()
      document.documentElement.dataset.theme = 'dark' // the chrome's stored copy, applied as it runs
      chromeScript()!.dispatchEvent(new Event('load'))
      await pending
      await flush()
      expect(stub.configure).toHaveBeenCalled()
      expect(ctx.setTheme.mock.calls).toEqual([['dark']])
    })
  })

  describe('cleanup on signal abort', () => {
    it('empties the slot, stops watching the theme and the width, and removes its stylesheets', async () => {
      const media = stubMatchMedia(false)
      const { ctx, controller } = makeCtx()
      await mountWithChrome(ctx)
      const menu = ctx.slot.querySelector('ol-account-menu')!

      controller.abort()
      expect(ctx.slot.childElementCount).toBe(0)
      expect(document.head.querySelectorAll('link').length).toBe(0)

      document.documentElement.dataset.theme = 'dark'
      await flush()
      expect(ctx.setTheme).not.toHaveBeenCalled()

      expect(media.lists.get('(max-width: 760px)')!.listeners.size).toBe(0)
      media.set('(max-width: 760px)', true)
      expect(menu.hasAttribute('compact')).toBe(false)
      // Emptying the slot on abort is not a failure to report.
      await flush()
      expect(ctx.fallback).not.toHaveBeenCalled()
    })

    it('rejects and cleans up when the signal aborts while the chrome loads', async () => {
      const { ctx, controller } = makeCtx()
      const pending = window.PhiloHost!.mount(ctx)
      await flush()
      controller.abort()
      await expect(pending).rejects.toThrow()
      expect(document.head.querySelectorAll('link').length).toBe(0)
      expect(ctx.slot.childElementCount).toBe(0)
    })

    it('rejects at once, loading nothing, when the signal has already aborted', async () => {
      const { ctx, controller } = makeCtx()
      controller.abort()
      await expect(window.PhiloHost!.mount(ctx)).rejects.toThrow()
      expect(chromeScript()).toBeNull()
      expect(document.head.querySelectorAll('link').length).toBe(0)
    })
  })

  describe('when the chrome cannot load, mount rejects so Philo keeps its own menu', () => {
    it('rejects when the chrome script fails to load', async () => {
      const { ctx } = makeCtx()
      const pending = window.PhiloHost!.mount(ctx)
      await flush()
      chromeScript()!.dispatchEvent(new Event('error'))
      await expect(pending).rejects.toThrow(/ol-chrome\.js/)
      expect(ctx.slot.childElementCount).toBe(0)
      expect(document.head.querySelectorAll('link').length).toBe(0)
      expect(ctx.fallback).not.toHaveBeenCalled()
    })

    it('rejects when the script loads but defines no OLChrome', async () => {
      const { ctx } = makeCtx()
      const pending = window.PhiloHost!.mount(ctx)
      await flush()
      chromeScript()!.dispatchEvent(new Event('load'))
      await expect(pending).rejects.toThrow(/OLChrome/)
      expect(ctx.slot.childElementCount).toBe(0)
    })

    it('rejects a context version it does not know', async () => {
      const { ctx } = makeCtx({ version: 2 })
      await expect(window.PhiloHost!.mount(ctx)).rejects.toThrow(/version/)
      expect(chromeScript()).toBeNull()
    })

    it('configures the chrome before the elements connect on a first load', async () => {
      const { ctx } = makeCtx()
      await mountWithChrome(ctx)
      expect(calls.indexOf('configure')).toBeGreaterThanOrEqual(0)
      expect(calls.indexOf('configure')).toBeLessThan(calls.indexOf('connect ol-account-menu'))
      expect(calls).not.toContain('refresh')
    })

    it('rejects when the account menu does not upgrade (no shadow root after connecting)', async () => {
      onConnect = () => undefined
      const { ctx } = makeCtx()
      await expect(mountWithChrome(ctx)).rejects.toThrow(/ol-account-menu/)
      expect(ctx.slot.childElementCount).toBe(0)
      expect(document.head.querySelectorAll('link').length).toBe(0)
      expect(ctx.fallback).not.toHaveBeenCalled()
      // Its getToken is dead after the failed mount.
      await expect(lastOptions(window.OLChrome!).getToken({ audience: 'auth' })).resolves.toBeNull()
    })

    it('rejects when the account menu throws while it renders', async () => {
      onConnect = (el) => {
        if (!el.shadowRoot) el.attachShadow({ mode: 'open' })
        if (el.localName !== 'ol-account-menu') return
        // What a browser reports for a throw in a CORS-mode script's connectedCallback.
        window.dispatchEvent(new ErrorEvent('error', { filename: CHROME_URL, message: 'TypeError: render' }))
      }
      const { ctx } = makeCtx()
      await expect(mountWithChrome(ctx)).rejects.toThrow(/threw/)
      expect(ctx.slot.childElementCount).toBe(0)
      expect(ctx.fallback).not.toHaveBeenCalled()
    })

    it('rejects when the account menu reports an error while it connects', async () => {
      onConnect = (el) => {
        if (!el.shadowRoot) el.attachShadow({ mode: 'open' })
        if (el.localName === 'ol-account-menu') {
          el.dispatchEvent(new CustomEvent('ol-chrome-error', { bubbles: true, composed: true, detail: {} }))
        }
      }
      const { ctx } = makeCtx()
      await expect(mountWithChrome(ctx)).rejects.toThrow(/error/)
      expect(ctx.slot.childElementCount).toBe(0)
    })

    it('waits for an account menu defined late, and rejects if it never is', async () => {
      const { ctx } = makeCtx()
      const pending = window.PhiloHost!.mount(ctx)
      await flush()
      const stub = runStubChrome()
      let define!: () => void
      vi.spyOn(customElements, 'get').mockReturnValue(undefined)
      vi.spyOn(customElements, 'whenDefined').mockReturnValue(
        new Promise((resolve) => {
          define = () => resolve(HTMLElement as CustomElementConstructor)
        }),
      )
      onConnect = () => undefined // not upgraded yet
      chromeScript()!.dispatchEvent(new Event('load'))
      await flush()
      const menu = ctx.slot.querySelector('ol-account-menu') as HTMLElement
      menu.attachShadow({ mode: 'open' }) // the late definition upgrades it
      define()
      await expect(pending).resolves.toEqual({ replaces: ['account-menu'] })
      expect(stub.configure).toHaveBeenCalledTimes(1)

      // A later mount whose chrome never defines the menu: the readiness timeout rejects.
      const again = makeCtx()
      vi.useFakeTimers()
      try {
        vi.spyOn(customElements, 'whenDefined').mockReturnValue(new Promise(() => undefined))
        const settled = window.PhiloHost!.mount(again.ctx).then(
          () => 'resolved',
          (error: Error) => error.message,
        )
        await vi.advanceTimersByTimeAsync(10_000)
        await expect(settled).resolves.toMatch(/ol-account-menu/)
        expect(again.ctx.slot.childElementCount).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('can try again on a later mount after a failed load', async () => {
      const first = makeCtx()
      const pending = window.PhiloHost!.mount(first.ctx)
      await flush()
      chromeScript()!.dispatchEvent(new Event('error'))
      await expect(pending).rejects.toThrow()
      first.controller.abort()

      const second = makeCtx()
      const { result } = await mountWithChrome(second.ctx)
      expect(result).toEqual({ replaces: ['account-menu'] })
    })
  })

  it('reuses a loaded chrome on a later sign-in: no second script, configured again and refreshed', async () => {
    const first = makeCtx()
    const { stub } = await mountWithChrome(first.ctx)
    first.controller.abort()

    const second = makeCtx()
    const result = await window.PhiloHost!.mount(second.ctx)
    expect(result).toEqual({ replaces: ['account-menu'] })
    expect(document.head.querySelectorAll(`script[src="${CHROME_URL}"]`).length).toBe(1)
    expect(stub.configure).toHaveBeenCalledTimes(2)
    expect(stub.refresh).toHaveBeenCalledTimes(1)
    expect(second.ctx.slot.querySelector('ol-account-menu')).not.toBeNull()
    // Configured and refreshed before the new menu connects, so it never reads the last session's cached /me.
    const tail = calls.slice(calls.lastIndexOf('configure'))
    expect(tail.slice(0, 2)).toEqual(['configure', 'refresh'])
    expect(tail).toContain('connect ol-account-menu')
    // The first mount's getToken stays dead; the new one works.
    await expect((stub.configure.mock.calls[0][0] as ChromeOptions).getToken({ audience: 'auth' })).resolves.toBeNull()
    await expect(lastOptions(stub).getToken({ audience: 'auth' })).resolves.toBe('token')
  })

  describe('ctx.fallback after mount', () => {
    it('falls back when the account menu reports an error before it has drawn', async () => {
      const { ctx } = makeCtx()
      await mountWithChrome(ctx)
      const menu = ctx.slot.querySelector('ol-account-menu')!
      menu.dispatchEvent(new CustomEvent('ol-chrome-error', { bubbles: true, composed: true, detail: { error: new Error('me') } }))
      expect(ctx.fallback).toHaveBeenCalledTimes(1)
      expect(ctx.slot.querySelector('ol-account-menu')).toBeNull()
      // The bell and the switcher do not hold sign-out, so they stay.
      expect(ctx.slot.querySelector('ol-app-switcher')).not.toBeNull()
      await flush()
      expect(ctx.fallback).toHaveBeenCalledTimes(1)
      // Philo's picker owns the theme again.
      document.documentElement.dataset.theme = 'dark'
      await flush()
      expect(ctx.setTheme).not.toHaveBeenCalled()
    })

    it('does not fall back for an error after the menu has drawn (a failed theme save)', async () => {
      const { ctx } = makeCtx()
      await mountWithChrome(ctx)
      const menu = ctx.slot.querySelector('ol-account-menu')!
      // The theme control exists only in a drawn menu, so a theme change proves it drew.
      menu.dispatchEvent(new CustomEvent('ol-theme-change', { bubbles: true, composed: true, detail: { theme: 'dark' } }))
      menu.dispatchEvent(new CustomEvent('ol-chrome-error', { bubbles: true, composed: true, detail: { error: new Error('patch') } }))
      expect(ctx.fallback).not.toHaveBeenCalled()
    })

    it('does not fall back for an error from the switcher or the bell', async () => {
      const { ctx } = makeCtx()
      await mountWithChrome(ctx)
      for (const tag of ['ol-app-switcher', 'ol-notifications']) {
        ctx.slot.querySelector(tag)!.dispatchEvent(new CustomEvent('ol-chrome-error', { bubbles: true, composed: true, detail: {} }))
      }
      expect(ctx.fallback).not.toHaveBeenCalled()
    })

    it('falls back when the account menu leaves the slot while the signal is live', async () => {
      const { ctx } = makeCtx()
      await mountWithChrome(ctx)
      ctx.slot.querySelector('ol-account-menu')!.remove()
      await flush()
      expect(ctx.fallback).toHaveBeenCalledTimes(1)
    })

    it('falls back when the chrome script throws at run time', async () => {
      const { ctx } = makeCtx()
      await mountWithChrome(ctx)
      // A CORS-mode script's error carries its URL, as a browser reports it.
      window.dispatchEvent(new ErrorEvent('error', { filename: CHROME_URL, message: 'TypeError: x is undefined' }))
      expect(ctx.fallback).toHaveBeenCalledTimes(1)
      window.dispatchEvent(new ErrorEvent('error', { filename: 'https://philo.example.test/assets/app.js', message: 'x' }))
      expect(ctx.fallback).toHaveBeenCalledTimes(1)
    })

    it('does not fall back for a muted cross-origin error, which names no script', async () => {
      const { ctx } = makeCtx()
      await mountWithChrome(ctx)
      window.dispatchEvent(new ErrorEvent('error', { filename: '', message: 'Script error.', lineno: 0 }))
      expect(ctx.fallback).not.toHaveBeenCalled()
    })

    it('ignores errors from other scripts', async () => {
      const { ctx } = makeCtx()
      await mountWithChrome(ctx)
      window.dispatchEvent(new ErrorEvent('error', { filename: 'https://philo.example.test/assets/app.js', message: 'x' }))
      expect(ctx.fallback).not.toHaveBeenCalled()
    })

    it('works with a context that has no fallback', async () => {
      const { ctx } = makeCtx({ fallback: undefined })
      await mountWithChrome(ctx)
      ctx.slot.querySelector('ol-account-menu')!.dispatchEvent(new CustomEvent('ol-chrome-error', { bubbles: true, detail: {} }))
      expect(ctx.slot.querySelector('ol-account-menu')).toBeNull()
    })
  })
})
