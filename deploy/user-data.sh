#!/usr/bin/env bash
# Cloud-init for the Orbita host. Amazon Linux 2023, arm64, t4g.micro.
#
# The instance holds no credentials of its own: it reads the app bundle from S3
# and sends crew email through SES using an instance role, so nothing secret is
# ever written to disk or into this file.
#
# Placeholders are replaced at deploy time: __BUCKET__, __KEY__, __PUBLIC_URL__,
# __EMAIL_FROM__.
set -euxo pipefail

dnf -y update
dnf -y install nodejs20 nodejs20-npm tar gzip || dnf -y install nodejs npm tar gzip
command -v node || ln -sf /usr/bin/node-20 /usr/bin/node

useradd --system --create-home --shell /usr/sbin/nologin orbita || true
install -d -o orbita -g orbita /opt/orbita /var/lib/orbita

aws s3 cp "s3://__BUCKET__/__KEY__" /tmp/app.tar.gz
tar -xzf /tmp/app.tar.gz -C /opt/orbita
chown -R orbita:orbita /opt/orbita

cd /opt/orbita
npm ci --omit=dev
chown -R orbita:orbita /opt/orbita

cat >/etc/systemd/system/orbita.service <<'UNIT'
[Unit]
Description=Orbita MCP server and demo page
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=orbita
WorkingDirectory=/opt/orbita
# Port 80 needs a capability rather than root, so a bug in the server is not a
# bug running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
Environment=NODE_ENV=production
Environment=PORT=80
Environment=ORBITA_DATA=/var/lib/orbita/farms.json
Environment=ORBITA_OUTBOX=/var/lib/orbita/outbox.jsonl
Environment=ORBITA_PUBLIC_URL=__PUBLIC_URL__
Environment=ORBITA_EMAIL_FROM=__EMAIL_FROM__
Environment=AWS_REGION=us-east-1
ExecStart=/usr/bin/node /opt/orbita/dist/server.js
Restart=always
RestartSec=3
# The only writable path it needs is its own state directory.
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/var/lib/orbita

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now orbita.service
