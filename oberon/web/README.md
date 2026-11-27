# `oberon/web/`

Static files the Oberon layer serves from Philo's own origin at `/oberon/<file>`: the chrome host script
`philo-host.js` and the token mapping `philo-ol.css` (see [`../docs/chrome.md`](../docs/chrome.md) §3.1).

`oberon/Dockerfile` copies every top-level `*.js` and `*.css` here into `apps/web/dist/oberon/` of the image.
Nothing else is copied, so `test/`, `vitest.config.ts` and this README stay out. Keep shipped file names flat
and give no other top-level file a `.js` or `.css` extension.

Tests: `npx vitest run --root oberon/web` (jsdom, with a stub chrome written in the test; nothing is copied from
the chrome's private source). `oberon/scripts/verify.sh` and `.github/workflows/ol-ci.yml` run them.
