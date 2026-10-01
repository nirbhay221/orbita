# Deploying Orbita

One small instance serving the MCP endpoint and the demo page, with CloudFront
in front of it for HTTPS. Both the add-on and the page are the same process, so
this is one deployment, not two.

```sh
AWS="/c/Program Files/Amazon/AWSCLIV2/aws.exe" ./deploy/deploy.sh
```

Idempotent: running it again rebuilds the bundle, pushes it to S3, and restarts
the service on the existing instance through SSM.

## What it creates

| Resource | Why | Cost |
|---|---|---|
| `t4g.micro` instance, Amazon Linux 2023, arm64 | Runs the server unchanged, including the 15 minute NOAA poll and the crew email timer | about $6 a month |
| Public IPv4 address | CloudFront has to reach the origin | free for the first 750 hours a month on the free plan, otherwise about $3.60 a month |
| CloudFront distribution, Free flat rate plan | HTTPS certificate and public name, 1 million requests and 100 GB a month, no overage charges | $0 |
| S3 bucket | Holds the app bundle the instance pulls at boot | pennies |
| IAM role | Lets the instance read that one object and send crew email through SES | free |

## Choices worth knowing

**Why not Lambda.** A voice turn has roughly half a second end to end. A cold
Node Lambda can spend a good part of that starting, and the server keeps NOAA in
memory between calls, which a function that sleeps cannot. A small always-on box
answers in single digit milliseconds and needs no rewrite.

**Why not App Runner.** It is closed to new customers and needs a paid account
plan. Lightsail is not available on the free plan at all.

**The instance is not on the open internet.** That is the design, and it needs
CloudFront: the security group is meant to accept port 80 only from CloudFront's
published origin ranges. On an account where CloudFront cannot be created, the public
address is an API Gateway HTTP API instead, and that changes the problem. AWS
publishes no managed prefix list for API Gateway (checked, not assumed: the lists are
CloudFront, DynamoDB, Route 53 health checks and a few others), so "allow only the
gateway" cannot be written as a security group rule, and removing `0.0.0.0/0` would
take the service offline rather than harden it. What can be written is a shared
secret the gateway injects and the origin requires, described below. There is no SSH:
all administration goes through SSM Session Manager, so there are no keys to lose.

**Secrets live in SSM Parameter Store, not on the box.** The data-at-rest key and the
origin secret are SecureStrings under `/orbita/` and `/sudor/`. The instance role can
read exactly those two prefixes. At service start a small script fetches them into a
file on tmpfs, which is gone at reboot, readable only by the service user, and never
part of an image, a unit file or a repository.

## Sealing the data, and the order that keeps it up

Everything the server remembers, where a farm's fields are, its machines, who is on
the crew, and the account tokens, is sealed with AES-256-GCM when a key is set. The
service is configured to refuse to start without one, because a server that silently
falls back to plaintext when a variable is missing is worse than one that is down.

That makes the order matter. Doing these out of order causes an outage, so do them in
this order.

**1. Create the data key, and back it up somewhere that is not this account.** This
key is the only thing that opens the data. Losing it is losing the data, and there is
no recovery.

```sh
aws ssm put-parameter --region us-east-1 --name /orbita/data-key --type SecureString \
  --value "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
```

**2. Install the fetcher and the systemd drop-in on the existing instance.** Redeploying
the app alone never touches the unit file, so without this step the new code runs under
the old settings, no key and auth off, and looks deployed. A drop-in is used rather
than a replacement unit so the instance keeps the `ORBITA_PUBLIC_URL` and
`ORBITA_EMAIL_FROM` it was created with. `npm ci` is part of it because the new code
needs two packages the old bundle never installed.

```sh
aws ssm send-command --region us-east-1 --instance-ids <id> \
  --document-name AWS-RunShellScript --parameters 'commands=[
    "aws s3 cp s3://<bucket>/orbita/app.tar.gz /tmp/app.tar.gz",
    "tar -xzf /tmp/app.tar.gz -C /opt/orbita",
    "cd /opt/orbita && npm ci --omit=dev && chown -R orbita:orbita /opt/orbita",
    "install -d -m 0755 /usr/local/libexec",
    "install -m 0755 /opt/orbita/deploy/orbita-secrets.sh /usr/local/libexec/orbita-secrets",
    "install -d /etc/systemd/system/orbita.service.d",
    "install -m 0644 /opt/orbita/deploy/orbita-hardening.conf /etc/systemd/system/orbita.service.d/10-hardening.conf",
    "systemctl daemon-reload", "systemctl restart orbita"]'
```

On start the existing plaintext file is read and immediately re-sealed. To undo,
delete the drop-in and restart.

**3. Only then arm the origin secret.** The secret can exist for weeks before anything
sends it, and the fetcher hands it to the service only when `/orbita/origin-enforce`
is `on`. Enforcing before the gateway sends the header answers every public request
with a 403. So: update the API Gateway integration to append `x-orbita-origin`, confirm
the public address still works, and only then:

```sh
aws ssm put-parameter --region us-east-1 --name /orbita/origin-enforce --type String --value on --overwrite
aws ssm send-command ... "systemctl restart orbita"
```

**Rotating the key.** Create the new key, move the old value into
`/orbita/data-key-previous`, put the new one in `/orbita/data-key`, restart. Data
sealed under the old key still opens and is re-sealed under the new one on the next
load. The old key can be retired once `/health` shows `storage.previousKeys` and a
restart has happened.

**Behind API Gateway, trust exactly one proxy hop.** The drop-in sets
`ORBITA_TRUST_PROXY=1`. Without it every visitor reaches the process from the
gateway's address, so a per-address limit would let one noisy visitor lock everyone
out. It must stay `0` if the process is ever reachable directly, because
`X-Forwarded-For` is then whatever the caller says it is. The origin secret is what
makes one hop safe.

## After the first deploy

1. Wait for CloudFront to finish, a few minutes.
2. Point `ORBITA_PUBLIC_URL` at the CloudFront name so the OAuth metadata
   publishes the public address rather than the instance's own name.
3. Verify a real GNSS forecast round trip before telling anyone the address:
   ```sh
   curl -s https://<domain>/health
   curl -s https://<domain>/mcp -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"storm_status","arguments":{}}}'
   ```

## Turning it off

```sh
aws ec2 terminate-instances --instance-ids <id>
aws cloudfront get-distribution-config --id <dist>   # disable, then delete
```
