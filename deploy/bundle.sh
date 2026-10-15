#!/usr/bin/env bash
# Build what the server needs and nothing else, then hand it to S3.
#
# The repository is private, so the instance cannot clone it. It pulls this
# tarball instead, which is also why the bundle carries package-lock.json: the
# instance installs production dependencies from the lock file rather than
# resolving fresh versions of its own.
set -euo pipefail

AWS="${AWS:-aws}"
BUCKET="${1:?usage: bundle.sh <s3-bucket> [key]}"
KEY="${2:-orbita/app.tar.gz}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"
npm run build

# Written inside the repository rather than /tmp, because the AWS CLI on Windows
# is a native program and cannot open a Unix style temp path.
mkdir -p .deploy
# deploy/ carries the secrets fetcher and the systemd drop-in, so the host installs
# the service definition from the same bundle as the code it starts. The two can no
# longer drift apart, which is how a deploy ended up running new code under old
# settings.
tar -czf .deploy/app.tar.gz dist web ui skills package.json package-lock.json deploy/orbita-secrets.sh deploy/orbita-hardening.conf

"$AWS" s3 cp .deploy/app.tar.gz "s3://${BUCKET}/${KEY}"
echo "uploaded s3://${BUCKET}/${KEY}"
