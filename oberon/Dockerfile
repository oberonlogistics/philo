# oberon/Dockerfile: the Oberon layer on top of the stock Philo image built
# from the same commit by the upstream ./Dockerfile. Build that one first:
#
#   docker build -t philo-upstream:local .
#   docker build -f oberon/Dockerfile --build-arg PHILO_BASE=philo-upstream:local .
#
# It adds the Oberon static files (oberon/web/*.js and *.css) under the PWA's
# dist, which apps/standalone serves, so they're same-origin at /oberon/<file>
# (oberon/docs/chrome.md §3.1). Everything else (USER node, HEALTHCHECK,
# VOLUME /data, CMD) is inherited unchanged.
# No default: a missing --build-arg fails instead of layering onto a stale image.
ARG PHILO_BASE

# Pick the files in a throwaway stage: a COPY glob fails the build when it
# matches nothing, and oberon/web may hold only its README (or tests later).
FROM busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec AS oberon-web
COPY oberon/web/ /in/
RUN mkdir /out && find /in -maxdepth 1 -type f \( -name '*.js' -o -name '*.css' \) -exec cp {} /out/ \;

FROM ${PHILO_BASE}
# No --chown: the served files stay root-owned, read-only to the node user.
COPY --from=oberon-web /out/ /app/apps/web/dist/oberon/
