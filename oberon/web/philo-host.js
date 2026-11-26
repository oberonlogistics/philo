/*
 * philo-host.js: Philo's host script for the shared Oberon Logistics chrome.
 *
 * Philo loads it after sign-in when PHILO_WEB_HOST_SCRIPT_URL=/oberon/philo-host.js and calls
 * window.PhiloHost.mount(ctx) (the contract is ADR-0013, "Operator host script in the PWA"). It loads the chrome
 * from OL Auth at ${ctx.issuer}/chrome/v1/, fills the top-bar slot with the bell, the app switcher and the account
 * menu, and replaces Philo's own account menu. Spec: oberon/docs/chrome.md §3.2 and §4.
 *
 * Failure rules. Before mount resolves, any failure rejects, so Philo keeps its own menu. After it resolves, a
 * failure the host can see (the account menu reports an error before it has drawn, the menu leaves the slot, or the
 * chrome throws) calls ctx.fallback(), and Philo shows its own menu again. Either way the person can sign out.
 *
 * A classic script with no build step and no dependencies. Nothing here is copied from the chrome's source.
 */
(() => {
  'use strict'

  const CHROME_PATH = '/chrome/v1/'
  const MAPPING_CSS = '/oberon/philo-ol.css'
  // The same breakpoint as Philo's own narrow layout (apps/web/src/index.css, `@media (max-width: 760px)`).
  const COMPACT_QUERY = '(max-width: 760px)'
  const THEMES = ['light', 'dark', 'system']
  const AUTH_SCOPE = 'auth:apps auth:account'
  const NOTIFY_SCOPE = 'notify:read'

  /** One load of ol-chrome.js per page, shared by every mount; cleared on failure so a later mount can try again. */
  let pendingChrome = null

  function trimSlash(url) {
    return String(url).replace(/\/+$/, '')
  }

  /** An absolute http(s) URL from ctx.config, or undefined. */
  function configUrl(value) {
    if (typeof value !== 'string' || value === '') return undefined
    try {
      const url = new URL(value)
      return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined
    } catch {
      return undefined
    }
  }

  function abortError(signal) {
    return signal.reason instanceof Error ? signal.reason : new Error('PhiloHost: the mount was aborted')
  }

  function loadChrome(src, issuer) {
    if (window.OLChrome) return Promise.resolve(false)
    if (pendingChrome) return pendingChrome
    pendingChrome = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.addEventListener('load', () => {
        if (window.OLChrome) resolve(true)
        else {
          pendingChrome = null
          script.remove()
          reject(new Error('PhiloHost: ol-chrome.js loaded but defined no OLChrome'))
        }
      }, { once: true })
      script.addEventListener('error', () => {
        pendingChrome = null
        script.remove()
        reject(new Error(`PhiloHost: ol-chrome.js failed to load from ${src}`))
      }, { once: true })
      script.src = src
      script.async = true
      script.dataset.issuer = issuer
      script.dataset.deferConfig = ''
      document.head.append(script)
    })
    return pendingChrome
  }

  /** Resolves with the chrome load, rejects with it or when the signal aborts first. */
  function untilLoadedOrAborted(load, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      load.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag)
    for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value)
    if (children) node.append(...children)
    return node
  }

  function readTheme() {
    const value = document.documentElement.getAttribute('data-theme')
    return value === null ? 'system' : value
  }

  async function mount(ctx) {
    if (!ctx || ctx.version !== 1) throw new Error(`PhiloHost: unsupported context version ${ctx && ctx.version}`)
    const signal = ctx.signal
    if (signal.aborted) throw abortError(signal)

    const issuer = trimSlash(ctx.issuer)
    const base = `${issuer}${CHROME_PATH}`
    const config = ctx.config && typeof ctx.config === 'object' ? ctx.config : {}
    const notifyUrl = configUrl(config.notifyUrl) && trimSlash(config.notifyUrl)
    const notifyResource = configUrl(config.notifyResource)

    // Everything to undo when the signal aborts or the mount fails.
    const undo = []
    const cleanup = () => {
      while (undo.length) {
        try {
          undo.pop()()
        } catch {
          // Keep undoing the rest.
        }
      }
    }
    signal.addEventListener('abort', cleanup, { once: true })

    // 1. Stylesheets, in this order so the mapping sees the tokens; then the chrome.
    for (const href of [`${base}tokens.css`, `${base}fonts.css`, MAPPING_CSS]) {
      const link = el('link', { rel: 'stylesheet', href })
      document.head.append(link)
      undo.push(() => link.remove())
    }
    const themeAtMount = readTheme()

    let freshLoad
    try {
      freshLoad = await untilLoadedOrAborted(loadChrome(`${base}ol-chrome.js`, issuer), signal)
    } catch (error) {
      signal.removeEventListener('abort', cleanup)
      cleanup()
      throw error
    }
    const chrome = window.OLChrome

    // 2. The slot: bell (only with the shared feed), switcher, account menu. No toast-new: Philo's new leads already
    //    reach the person by push and email.
    const slot = ctx.slot
    const items = (ctx.accountItems || []).map((item) => {
      const a = el('a', { slot: 'item', href: item.path }, [item.label])
      a.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        ctx.navigate(item.path)
      })
      return a
    })
    const menu = el('ol-account-menu', {}, items)
    const parts = []
    if (notifyUrl) parts.push(el('ol-notifications'))
    parts.push(el('ol-app-switcher', { current: ctx.clientId }), menu)
    slot.replaceChildren(...parts)
    undo.push(() => slot.replaceChildren())

    // Compact account menu on narrow screens.
    if (typeof window.matchMedia === 'function') {
      const media = window.matchMedia(COMPACT_QUERY)
      const apply = () => menu.toggleAttribute('compact', media.matches)
      apply()
      media.addEventListener('change', apply)
      undo.push(() => media.removeEventListener('change', apply))
    }

    // 3. Configure the chrome. Tokens only for OL Auth's API and Notify's resource, which are the operator's
    //    allow-list (PHILO_WEB_HOST_TOKEN_RESOURCES); Philo refuses anything else anyway. No prompt: OL Auth answers
    //    a first silent request for a new audience only without one.
    let live = true
    undo.push(() => {
      live = false
    })
    const ask = async (request) => {
      if (!live) return null
      try {
        return (await ctx.getToken(request)) || null
      } catch {
        return null
      }
    }
    const getToken = async ({ audience } = {}) => {
      if (audience === 'auth') return ask({ resource: `${issuer}/api`, scope: AUTH_SCOPE })
      if (audience === 'notify' && notifyResource) return ask({ resource: notifyResource, scope: NOTIFY_SCOPE })
      return null
    }
    const options = { issuer, getToken, onSignOut: () => ctx.signOut() }
    if (notifyUrl) options.notifyUrl = notifyUrl
    chrome.configure(options)
    // A chrome already on the page (an earlier sign-in) holds the last person's account and apps.
    if (!freshLoad && typeof chrome.refresh === 'function') chrome.refresh()

    // 4. Theme: the chrome applies the account's theme to data-theme; pass every change to Philo's store. The last
    //    value seen is the loop guard, because setTheme writes the same attribute back.
    let lastTheme = themeAtMount
    const syncTheme = () => {
      const theme = readTheme()
      if (theme === lastTheme || !THEMES.includes(theme)) return
      lastTheme = theme
      ctx.setTheme(theme)
    }
    const themeObserver = new MutationObserver(syncTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    undo.push(() => themeObserver.disconnect())
    syncTheme() // a theme the chrome applied while it loaded

    // After mount: give Philo its own menu back on a failure we can see.
    let drawn = false
    let fellBack = false
    const fallBack = () => {
      if (fellBack || !live) return
      fellBack = true
      themeObserver.disconnect() // Philo's own picker owns the theme again
      slotObserver.disconnect()
      menu.remove()
      if (typeof ctx.fallback === 'function') ctx.fallback()
    }
    // The theme control exists only in a drawn menu, so a theme change from it proves the menu drew (and with it,
    // Sign out). An error before that (OL Auth's /me failed) leaves a menu with nothing in it.
    const onThemeChange = () => {
      drawn = true
    }
    const onMenuError = () => {
      if (!drawn) fallBack()
    }
    menu.addEventListener('ol-theme-change', onThemeChange)
    menu.addEventListener('ol-chrome-error', onMenuError)
    undo.push(() => {
      menu.removeEventListener('ol-theme-change', onThemeChange)
      menu.removeEventListener('ol-chrome-error', onMenuError)
    })
    const slotObserver = new MutationObserver(() => {
      if (!slot.contains(menu)) fallBack()
    })
    slotObserver.observe(slot, { childList: true })
    // Disconnect before the slot is emptied on abort, so cleanup is not reported as a failure.
    undo.push(() => slotObserver.disconnect())
    const chromeSrc = `${base}ol-chrome.js`
    const onWindowError = (event) => {
      if (event && event.filename === chromeSrc) fallBack()
    }
    window.addEventListener('error', onWindowError)
    undo.push(() => window.removeEventListener('error', onWindowError))

    // 5. Philo hides its own menu.
    return { replaces: ['account-menu'] }
  }

  window.PhiloHost = { mount }
})()
