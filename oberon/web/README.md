# `oberon/web/`

Static files the Oberon layer serves from Philo's own origin at `/oberon/<file>`: the chrome host script
`philo-host.js` and the token mapping `philo-ol.css` (see [`../docs/chrome.md`](../docs/chrome.md) §3.1).

`oberon/Dockerfile` copies every top-level `*.js` and `*.css` here into `apps/web/dist/oberon/` of the image.
Nothing else is copied, so tests under `test/` and this README stay out. The directory holds no assets yet.
