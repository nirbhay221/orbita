#!/usr/bin/env bash
# Cloud-init for the Orbita host. Amazon Linux 2023, arm64, t4g.micro.
#
# The instance holds no credentials of its own: it reads the app bundle from S3
# and sends crew email through SES using an instance role, so nothing secret is
# ever written to disk or into this file.
#
# That includes the data-at-rest key. It lives in SSM Parameter Store as a
# SecureString and is fetched when the service starts into a file on tmpfs, which
# is gone at reboot, readable only by the service user, and never part of an image,
# a unit file or this script.
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

install -d -m 0755 /usr/local/libexec
cat >/usr/local/libexec/orbita-secrets <<'SH'
#!/usr/bin/env bash
# Fetch this service's secrets from SSM Parameter Store into a tmpfs file.
#
# Runs as root immediately before the service starts. A parameter that does not
# exist is simply left out, which is deliberate: the service then decides what
# that means. With ORBITA_REQUIRE_ENCRYPTION=on, a missing data key stops it from
# starting, which is the correct failure, rather than serving farms from a
# plaintext file because an environment variable was forgotten.
set -euo pipefail
umask 077
install -d -m 0750 -o orbita -g orbita /run/orbita
out=/run/orbita/env
: >"$out"

get() {
  aws ssm get-parameter --region us-east-1 --name "$1" --with-decryption \
    --query Parameter.Value --output text 2>/dev/null || true
}

key="$(get /orbita/data-key)"
[ -n "$key" ] && printf 'ORBITA_DATA_KEY=%s\n' "$key" >>"$out"

# Keys being rotated out, comma separated. Data sealed under them still opens and is
# re-sealed under the current key on the next load.
prev="$(get /orbita/data-key-previous)"
[ -n "$prev" ] && printf 'ORBITA_DATA_KEY_PREVIOUS=%s\n' "$prev" >>"$out"

# The origin secret is only handed to the service when it has been armed, and arming
# is a separate, explicit parameter. The secret can exist for weeks before anything
# sends it: if the service enforced it the moment it existed, deploying before the
# API Gateway integration was updated to send the header would answer every public
# request with a 403. Order: update the gateway, confirm it works, then arm.
if [ "$(get /orbita/origin-enforce)" = "on" ]; then
  sec="$(get /orbita/origin-secret)"
  [ -n "$sec" ] && printf 'ORBITA_ORIGIN_SECRET=%s\n' "$sec" >>"$out"
fi

chown orbita:orbita "$out"
chmod 0400 "$out"
SH
chmod 0755 /usr/local/libexec/orbita-secrets

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
# The + runs the fetch with full privileges despite the sandboxing below, because
# it has to write /run/orbita. The service itself never runs as root.
ExecStartPre=+/usr/local/libexec/orbita-secrets
EnvironmentFile=-/run/orbita/env
Environment=NODE_ENV=production
Environment=PORT=80
# Refuse to start without a data key rather than store farms in the clear.
Environment=ORBITA_REQUIRE_ENCRYPTION=on
# Account linking needs a passphrase, and tokens survive a deploy. The demo page keeps
# working through its own sandbox door, which cannot reach a linked account.
Environment=ORBITA_AUTH=on
Environment=ORBITA_AUTH_DATA=/var/lib/orbita/auth.json
# One hop: API Gateway. Without it every visitor shares the gateway's address and one
# noisy visitor rate-limits everybody. Safe only because the origin secret, once
# armed, means nothing else can reach this process to forge the header.
Environment=ORBITA_TRUST_PROXY=1
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
