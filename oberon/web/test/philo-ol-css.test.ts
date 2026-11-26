// philo-ol.css must be harmless when tokens.css fails to load: every shared
// token it reads falls back to Philo's own value for the same scheme, so the
// page then looks exactly as it does without the file.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (...parts: string[]) => readFileSync(join(import.meta.dirname, ...parts), 'utf8')
const MAPPING = read('..', 'philo-ol.css')
const PHILO = read('..', '..', '..', 'apps', 'web', 'src', 'index.css')

const SELECTORS = {
  light: ':root {',
  dark: ":root[data-theme='dark'] {",
  system: ":root:not([data-theme='light']) {",
} as const

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The custom properties declared in the first block opened by `selector`. */
function block(css: string, selector: string): Map<string, string> {
  const source = stripComments(css)
  const start = source.indexOf(selector)
  if (start < 0) throw new Error(`no ${selector} block`)
  let depth = 0
  let end = start + selector.length - 1
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++
    else if (source[end] === '}' && --depth === 0) break
  }
  const body = source.slice(start + selector.length, end)
  const props = new Map<string, string>()
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) props.set(m[1], m[2].trim().replace(/\s+/g, ' '))
  return props
}

/** `var(--ol-x, fallback)` → fallback, or null when the value is not exactly one such var(). */
function fallbackOf(value: string): string | null {
  const m = /^var\((--ol-[a-z0-9-]+)\s*,\s*([\s\S]+)\)$/.exec(value)
  return m ? m[2].trim() : null
}

describe('philo-ol.css', () => {
  for (const [scheme, selector] of Object.entries(SELECTORS)) {
    it(`falls back to Philo's own ${scheme} values`, () => {
      const mapping = block(MAPPING, selector)
      const philo = block(PHILO, selector)
      expect(mapping.size).toBeGreaterThan(0)
      for (const [name, value] of mapping) {
        expect(philo.has(name), `${name} is not one of Philo's ${scheme} variables`).toBe(true)
        expect(fallbackOf(value), `${name}: ${value}`).toBe(philo.get(name))
      }
    })
  }

  it("maps every one of Philo's dark variables that has a shared token in both dark blocks", () => {
    expect([...block(MAPPING, SELECTORS.dark).keys()]).toEqual([...block(MAPPING, SELECTORS.system).keys()])
  })

  it('reads every --ol-* token with a fallback, everywhere in the file', () => {
    const source = stripComments(MAPPING)
    const uses = [...source.matchAll(/var\(\s*(--ol-[a-z0-9-]+)\s*([,)])/g)]
    expect(uses.length).toBeGreaterThan(0)
    for (const use of uses) expect(use[2], `${use[1]} has no fallback`).toBe(',')
  })
})
