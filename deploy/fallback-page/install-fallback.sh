#!/usr/bin/env bash
# ============================================================
#  WeMeet — Deploy-Window Fallback Page Installer (v.tokendeal.cloud)
# ============================================================
#  Installs /var/www/vwebrtc-updating/updating.html and patches the
#  nginx vhost so that HTTP 502/503/504 (deploy / crash-loop windows)
#  serve a friendly auto-refreshing "Something went wrong" page
#  instead of a raw Bad Gateway.
#
#  Safe to re-run: idempotent (skips if already installed).
#  Always backs up the real vhost file (dereferences symlinks).
# ============================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBROOT="/var/www/vwebrtc-updating"
NGINX_CONF_AVAIL="/etc/nginx/sites-available/v.tokendeal.cloud"
BACKUP_DIR="/root/nginx-backups"

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: run as root (sudo)." >&2
  exit 1
fi

echo "==> Backing up $NGINX_CONF_AVAIL"
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/v.tokendeal.cloud.bak-$(date +%Y%m%d-%H%M%S)"
cp -L "$NGINX_CONF_AVAIL" "$BACKUP"
echo "    -> $BACKUP"

echo "==> Installing fallback page"
mkdir -p "$WEBROOT"
cp "$HERE/updating.html" "$WEBROOT/updating.html"
chmod 644 "$WEBROOT/updating.html"
echo "    -> $WEBROOT/updating.html"

if grep -q "error_page 502 503 504 /__updating__" "$NGINX_CONF_AVAIL"; then
  echo "==> nginx vhost already patched (error_page present) — skipping edit"
else
  echo "==> Patching nginx vhost"
  python3 - "$NGINX_CONF_AVAIL" <<'PYEOF'
import sys
path = sys.argv[1]
src = open(path).read()
anchor = '    add_header Permissions-Policy "camera=*, microphone=*, display-capture=*" always;\n'
inject = '''
    # Deploy windows: show a friendly auto-refreshing "updating" page instead of a raw 502
    error_page 502 503 504 /__updating__;

    location = /__updating__ {
        root /var/www/vwebrtc-updating;
        internal;
        default_type text/html;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        try_files /updating.html =502;
    }
'''
if anchor not in src:
    raise SystemExit("ERROR: anchor line not found in vhost — manual edit required.")
open(path, "w").write(src.replace(anchor, anchor + inject, 1))
print("    patched OK")
PYEOF
fi

echo "==> Validating nginx configuration"
if ! nginx -t; then
  echo "    nginx -t FAILED — restoring backup" >&2
  cp -L "$BACKUP" "$NGINX_CONF_AVAIL"
  nginx -t || true
  exit 1
fi

echo "==> Reloading nginx"
nginx -s reload
sleep 1

echo "==> Verifying site"
curl -sS --resolve v.tokendeal.cloud:443:127.0.0.1 -o /dev/null -w "    HTTPS v.tokendeal.cloud/ -> HTTP %{http_code}\n" https://v.tokendeal.cloud/ || true

echo "==> Done. Fallback page is live for 502/503/504 windows."
