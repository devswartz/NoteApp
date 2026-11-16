# notiveloapp.com marketing site

The public site at https://notiveloapp.com (www redirects to it). Separate from the app at app.notiveloapp.com.

- `src/build.py`: the generator. **All page copy lives here** as Python constants. Python 3 standard library only.
- `src/assets/`: `site.css` (hand-written, the only stylesheet), `site.js` (progressive enhancement only), icons and the og-image.
- `nginx.conf`: how it's served: clean URLs, real 404s, the CSP, caching, http→https and www→apex redirects, `/healthz`, and `/download/`.
- `Dockerfile`: builds the pages and bakes them and `nginx.conf` into an `nginx:1.27-alpine` image.

## Build and preview

```bash
python3 site/src/build.py          # writes site/dist
docker build -f site/Dockerfile -t notivelo-site site && docker run --rm -p 8088:80 notivelo-site
```

Never edit `site/dist`; edit `build.py` or the assets and rebuild.

## Two rules that silently break the site if ignored

1. **Asset names are content-hashed** (`site.<sha10>.css|js`), because `/assets/` is cached for a year as immutable. Don't serve stable names from `/assets/`.
2. **The CSP forbids inline styles** (`style-src 'self'`): a `style="…"` attribute is silently ignored. Use classes in `site.css`.

Every product claim must be true of production. Check the app before adding or changing one, and remove claims that stop being true.

## Releasing

| Event | Image tags | Who runs it |
|---|---|---|
| Merge to `main` touching `site/` | `ghcr.io/devswartz/notivelo-site:staging`, `:sha-<7>` | not served; for checking |
| Tag `site-vX.Y.Z` | `:site-vX.Y.Z`, `:prod` | the homelab serves `:prod` |

The homelab runs the image with `/srv/downloads` bind-mounted (its hourly mirror of the desktop installers and `version.json`), and only hosts it. Content and config changes come from this folder.
