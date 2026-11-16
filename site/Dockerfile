# The notiveloapp.com marketing site: generate the static pages, then serve them with nginx.
# Build from the repo root:  docker build -f site/Dockerfile site
# /download/ is NOT in the image: the homelab bind-mounts its hourly installer mirror at /srv/downloads.
FROM python:3.12-alpine AS build
WORKDIR /site
COPY src ./src
RUN SITE_OUT=/out python3 src/build.py

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /out /usr/share/nginx/html
RUN mkdir -p /srv/downloads && nginx -t
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=5s CMD wget -qO- http://127.0.0.1/healthz || exit 1
