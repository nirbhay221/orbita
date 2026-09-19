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

**The instance is not on the open internet.** Its security group accepts port 80
only from CloudFront's published origin ranges, and there is no SSH: all
administration goes through SSM Session Manager, so there are no keys to lose.

**No secrets on the box.** It reads the bundle from S3 and sends email through
SES using an instance role, so nothing has to be written into user data.

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
