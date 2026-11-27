import { defineConfig } from 'vitest/config'

// The Oberon host script's tests. oberon/web is not an npm workspace, so the
// root `npm test` does not reach it: oberon/scripts/verify.sh and the fork's
// own CI workflow (.github/workflows/ol-ci.yml) run it with
// `npx vitest run --root oberon/web`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
    restoreMocks: true,
  },
})
