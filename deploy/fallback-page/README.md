# Deploy-Window Fallback Page (v.tokendeal.cloud)

Friendly, branding-free **dark grey "Something went wrong"** page shown to visitors during deploy / crash windows, instead of a raw `502 Bad Gateway`.

## What it is
- `updating.html` — self-contained page (no CDN, no fonts, no images, works fully offline of the app itself).
- Shown by nginx **only when** the Node app upstream is unreachable (`502/503/504`).
- Contains three bouncing dots, a plain English message ("This website is currently facing a technical issue… please try again later") and zero branding, tracking or service hints.
- **Hidden, hold-0.65s diagnostics** (bottom-right) for power users:
  - Status circle + card: auto-detects whether the network/ISP blocks the domain, the server is down, or the site loads fine — in color (🟢/🟡/🟠/🔴/⚫).
  - **Clear Cache & Fresh Network** button: clears Cache API, service workers, sessionStorage, JS-accessible cookies and IndexedDB — **localStorage is preserved**.
- Silently probes `/` every 3s and auto-reloads the moment the app is back.

## Files
- `updating.html` — the page (served from `/var/www/vwebrtc-updating/`).
- `nginx-v.tokendeal.cloud.conf` — the full vhost **as installed on the VPS** (includes the fallback wiring).
- `install-fallback.sh` — idempotent installer for fresh VPS / disaster recovery:
  1. Backs up the live vhost (dereferences symlinks).
  2. Installs the page into `/var/www/vwebrtc-updating/updating.html`.
  3. Patches the vhost with `error_page 502 503 504 /__updating__;` + an `internal` location.
  4. `nginx -t` (aborts + restores backup on failure), `nginx -s reload`, verifies `HTTP 200`.

## Notes
- The `internal` location means the page is **never** served while the app is healthy — nginx only uses it for 502/503/504 responses.
- Status code stays `502` (deliberate) so the page's own auto-probe can detect "app still down".
- Backups of the vhost live in `/root/nginx-backups/`.
