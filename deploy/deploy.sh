#!/usr/bin/env bash
# Put Orbita on AWS: one small instance, fronted by CloudFront for HTTPS.
#
# Why this shape rather than Lambda: a voice turn has roughly half a second in
# total, and a cold Lambda spends a good part of that waking up. A small
# always-on instance answers in single digit milliseconds and runs the server
# exactly as it runs locally, background NOAA poll and all, with no rewrite.
#
# Why CloudFront in front: it is the free TLS certificate and the public HTTPS
# name. The instance itself only accepts traffic from CloudFront.
#
# Everything here is idempotent. Run it again to redeploy the app.
set -euo pipefail

# Git Bash on Windows rewrites arguments that look like Unix paths into
# Windows ones, which turns an SSM parameter name into a directory and the
# lookup fails with ParameterNotFound. Harmless everywhere else.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"

AWS="${AWS:-aws}"
REGION="${REGION:-us-east-1}"
NAME="${NAME:-orbita}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.micro}"
EMAIL_FROM="${ORBITA_EMAIL_FROM:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"

ACCOUNT="$("$AWS" sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-${NAME}-deploy-${ACCOUNT}}"
KEY="app.tar.gz"

say() { printf '\n== %s\n' "$1"; }

export AWS REGION

say "bundle"
if ! "$AWS" s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  "$AWS" s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
fi
"$HERE/bundle.sh" "$BUCKET" "$KEY"

say "instance role"
if ! "$AWS" iam get-role --role-name "${NAME}-host" >/dev/null 2>&1; then
  "$AWS" iam create-role --role-name "${NAME}-host" --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  "$AWS" iam attach-role-policy --role-name "${NAME}-host" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  "$AWS" iam create-instance-profile --instance-profile-name "${NAME}-host" >/dev/null
  "$AWS" iam add-role-to-instance-profile --instance-profile-name "${NAME}-host" --role-name "${NAME}-host"
fi
# Read the bundle, send crew email, and read its own secrets. Nothing else.
#
# The secrets are the data-at-rest key and the origin secret, held in SSM Parameter
# Store as SecureStrings under /orbita/ and /sudor/ (the two add-ons share this host).
# The instance can also send email (SES) and synthesise speech (Polly, which has no resource-level
# permissions, so it is "*"). The demo page's /speak endpoint needs Polly, and without this line it
# fails on the instance even though it works on a developer machine with broader credentials.
# Re-running this script applies the policy to an existing role.
# Read access is scoped to exactly those two prefixes, so a bug in either server
# cannot read anything else in the account's parameter store, and the values are
# fetched at service start into a tmpfs file rather than written into this script,
# the unit file or the AMI.
"$AWS" iam put-role-policy --role-name "${NAME}-host" --policy-name "${NAME}-app" --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[
    {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::${BUCKET}/*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"ses:SendEmail\"],\"Resource\":\"*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"polly:SynthesizeSpeech\"],\"Resource\":\"*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\",\"ssm:GetParameters\"],\"Resource\":[
      \"arn:aws:ssm:${REGION}:*:parameter/orbita/*\",
      \"arn:aws:ssm:${REGION}:*:parameter/sudor/*\"]}
  ]}"

say "security group"
VPC="$("$AWS" ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
SG="$("$AWS" ec2 describe-security-groups --region "$REGION" --filters Name=group-name,Values="${NAME}-web" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ "$SG" = "None" ] || [ -z "$SG" ]; then
  SG="$("$AWS" ec2 create-security-group --region "$REGION" --group-name "${NAME}-web" --vpc-id "$VPC" \
    --description "Orbita origin, CloudFront only" --query GroupId --output text)"
  # Only CloudFront's origin-facing ranges, so the instance is not on the open
  # internet. No SSH at all: administration goes through SSM.
  PL="$("$AWS" ec2 describe-managed-prefix-lists --region "$REGION" \
    --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
    --query 'PrefixLists[0].PrefixListId' --output text)"
  "$AWS" ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" \
    --ip-permissions "IpProtocol=tcp,FromPort=80,ToPort=80,PrefixListIds=[{PrefixListId=$PL}]" >/dev/null
fi

say "instance"
AMI="$("$AWS" ssm get-parameter --region "$REGION" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query 'Parameter.Value' --output text)"
EXISTING="$("$AWS" ec2 describe-instances --region "$REGION" \
  --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)"

if [ "$EXISTING" != "None" ] && [ -n "$EXISTING" ]; then
  echo "instance $EXISTING already running, redeploying the app onto it"
  "$AWS" ssm send-command --region "$REGION" --instance-ids "$EXISTING" \
    --document-name AWS-RunShellScript \
    --parameters "commands=[\"aws s3 cp s3://${BUCKET}/${KEY} /tmp/app.tar.gz\",\"tar -xzf /tmp/app.tar.gz -C /opt/orbita\",\"cd /opt/orbita && npm ci --omit=dev\",\"chown -R orbita:orbita /opt/orbita\",\"systemctl restart orbita\"]" \
    --query 'Command.CommandId' --output text
  INSTANCE="$EXISTING"
else
  mkdir -p "$HERE/../.deploy"
  USERDATA=".deploy/user-data.rendered.sh"
  sed -e "s|__BUCKET__|${BUCKET}|g" -e "s|__KEY__|${KEY}|g" \
      -e "s|__PUBLIC_URL__|${PUBLIC_URL:-}|g" -e "s|__EMAIL_FROM__|${EMAIL_FROM}|g" \
      "$HERE/user-data.sh" > "$USERDATA"
  INSTANCE="$("$AWS" ec2 run-instances --region "$REGION" \
    --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile "Name=${NAME}-host" \
    --security-group-ids "$SG" \
    --metadata-options "HttpTokens=required" \
    --user-data "file://$USERDATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${NAME}}]" \
    --query 'Instances[0].InstanceId' --output text)"
  "$AWS" ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE"
fi

DNS="$("$AWS" ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE" \
  --query 'Reservations[0].Instances[0].PublicDnsName' --output text)"
echo "instance $INSTANCE at $DNS"

say "cloudfront"
DIST="$("$AWS" cloudfront list-distributions --query "DistributionList.Items[?Comment=='${NAME}'].Id | [0]" --output text 2>/dev/null || true)"
if [ "$DIST" = "None" ] || [ -z "$DIST" ]; then
  mkdir -p "$HERE/../.deploy"
  CONFIG=".deploy/cloudfront.json"
  cat > "$CONFIG" <<JSON
{
  "CallerReference": "${NAME}-$(date +%s)",
  "Comment": "${NAME}",
  "Enabled": true,
  "Origins": {"Quantity": 1, "Items": [{
    "Id": "origin",
    "DomainName": "${DNS}",
    "CustomOriginConfig": {"HTTPPort": 80, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only",
      "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
      "OriginReadTimeout": 30, "OriginKeepaliveTimeout": 5}
  }]},
  "DefaultCacheBehavior": {
    "TargetOriginId": "origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {"Quantity": 7,
      "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET","HEAD"]}},
    "Compress": true,
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }
}
JSON
  DIST="$("$AWS" cloudfront create-distribution --distribution-config "file://$CONFIG" --query 'Distribution.Id' --output text)"
fi
DOMAIN="$("$AWS" cloudfront get-distribution --id "$DIST" --query 'Distribution.DomainName' --output text)"

cat <<DONE

Deployed.
  page and MCP endpoint   https://${DOMAIN}
  MCP                     https://${DOMAIN}/mcp
  health                  https://${DOMAIN}/health
  instance                ${INSTANCE}
  distribution            ${DIST}

CloudFront takes a few minutes to finish deploying the first time. After that,
set ORBITA_PUBLIC_URL on the instance to https://${DOMAIN} so the OAuth metadata
publishes the public name, and restart the service:
  ${AWS} ssm send-command --region ${REGION} --instance-ids ${INSTANCE} \\
    --document-name AWS-RunShellScript \\
    --parameters 'commands=["systemctl restart orbita"]'
DONE
