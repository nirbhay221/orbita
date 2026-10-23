# Product feedback and AWS services

Written for the hackathon's product feedback field. The detailed, dated entries are in
[FRICTION.md](FRICTION.md); this is the summary, plus the AWS services Orbita uses and what each one does.

## What worked

* **The functional requirements page.** `functional-requirements.html` is specific and testable, and four
  defects in this codebase were found by reading it rather than by testing. It works as a build checklist.
* **Streamable HTTP and the 2025-11-25 specification.** A stateless server (a new server and transport per
  request) is simple to reason about and scales down to one small instance.
* **The MCP Apps model for the Echo Show panel**, once the handshake was understood (see friction entry 1).
* **Account linking guidance**, once the static-client shape was found (entry 6).

## What needs improvement

Each is a numbered entry in FRICTION.md with the task, steps, expected against actual, severity, workaround
and a suggestion.

1. The Display Modes page says to declare modes in the tool; they are declared by the view (entry 1, high).
2. A design guide link returns 404 (entry 2).
3. The QuickStart reads as generally available while the add-on path is gated (entry 3).
4. Account linking is not the generic MCP OAuth shape; Dynamic Client Registration is not supported (entry 6, high).
5. Nothing says whether the host retries a tool call, so "detect and prevent duplicate transactions" cannot be
   met reliably by a stateless server (entry 8).
6. Nothing says which `Accept` header or protocol versions the host sends (entry 9).
7. A schema validation failure reaches the customer as protocol text unless the developer rewrites it (entry 10).

## Onboarding experience

The documentation was good once found. The cost was in the gaps above, and in the add-on path being a gated
preview: it could not be tested on a real Echo, so Orbita ships with a stand-in model that plays Alexa+'s part
and says so in its own responses. A way to test an add-on end to end without waiting for access would have
changed how much of the time went to building a stand-in.

## Future use

Orbita would use a documented host retry identifier, a documented supported pattern for work that outlasts a
turn, and a proactive channel for MCP add-ons, none of which exist today.

## AWS services used

| Service | What it does here |
|---|---|
| EC2 (t4g.micro) | Runs the MCP server and the demo page as one process, with the NOAA feeds held in memory |
| API Gateway (HTTP API) | The public HTTPS address in front of the instance |
| Systems Manager Parameter Store (SecureString) | Holds the data-at-rest key and the origin secret, fetched into a tmpfs file at service start |
| Systems Manager (Run Command) | Deploys without SSH or keys |
| S3 | Holds the application bundle the instance pulls |
| IAM | An instance role limited to the bundle, the two parameter prefixes, SES and Polly |
| SES (v2) | Emails confirmed crew contacts when a watched job clears or a storm is coming |
| Strands Agents SDK | The agent in `strands/`: Strands' MCP client connects to this server, the Agent Skill it serves becomes the system prompt, each tool is wrapped so the agent sees the next step, and writes wait for a yes. Its model is Claude through Strands' Anthropic provider |
| Polly | Speaks the same sentence the tool returns, on the demo page, with per-caller and daily caps |
| DynamoDB | The farms table (`infra/`): one sealed item per farm, versioned writes, and a TTL that deletes sandbox farms after seven days |
| Lambda, EventBridge Scheduler | The alert check (`src/sweep.ts`) every fifteen minutes on its own, so a storm warning does not depend on the web server staying up |
| CloudWatch, SNS | Alarms when that check fails twice or stops running |
| CDK | The table, the check and the alarms as code, built from this repository's Dockerfile |

Not used: Bedrock and CloudFront. Bedrock is not available to this account, so the Strands agent reaches Claude
through Strands' Anthropic provider instead; moving it to Bedrock is a change of one model class. The stand-in model calls Anthropic's API directly, and the account could not
create a CloudFront distribution, which is why the public address is an API Gateway HTTP API (see
`deploy/README.md`).
