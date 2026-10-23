# Orbita: architecture

How Orbita is built, what runs where, and why. Every diagram below is drawn by GitHub from the text in this file, so
it can be zoomed and panned in place, and it changes when the file does. A printable copy is in
[architecture.pdf](architecture.pdf).

What is described here is what runs. It was checked against the AWS account on 22 October 2026: the farms table holds
205 records, the alert check runs every fifteen minutes and both of its alarms read OK.

**Contents.** [At a glance](#at-a-glance) · [1. Context](#1-context-who-and-what-it-talks-to) ·
[2. On AWS](#2-on-aws-what-runs-where) · [3. Inside the server](#3-inside-the-server) ·
[4. A voice turn](#4-a-voice-turn-from-sentence-to-spoken-answer) · [5. The decision](#5-the-decision-go-or-hold) ·
[6. Storm alerts](#6-storm-alerts-when-nobody-asks) · [7. The data](#7-the-data-what-a-farm-record-holds) ·
[8. Consent](#8-consent-who-may-be-emailed) · [9. Security](#9-security) · [10. Shipping it](#10-shipping-it) ·
[11. Decisions](#11-decisions-and-why)

## At a glance

| | |
|---|---|
| Protocol | MCP 2025-11-25 over Streamable HTTP, stateless: a new server and transport per request |
| Surface | 18 tools by default, an MCP Apps panel and card, an Agent Skill as `skill://` resources, the `orbita://alerts` feed |
| Answer time | Under 13 ms at p95 for every in-memory tool ([LATENCY.md](../LATENCY.md)); Alexa+ allows about 500 ms |
| Data in | More than a dozen public feeds, read on timers from every minute to every hour, never inside a turn |
| Where it runs | One EC2 instance (t4g.micro, arm64) behind an API Gateway HTTP API, us-east-1 |
| Where farms live | DynamoDB `orbita-farms`, one sealed item per farm, versioned writes, on-demand |
| Alerts | A Lambda run by EventBridge Scheduler every 15 minutes, alarmed in CloudWatch |
| Code | TypeScript on Node 20, about 16,000 lines in `src/`, 2,467 automated checks |

## 1. Context: who and what it talks to

People and machines ask; Alexa+ (or the stand-in on the demo page) chooses a tool; Orbita answers from data it already
holds. Everything on the right is public data, read in the background.

```mermaid
flowchart LR
  subgraph Ask["Who asks"]
    F(["Farmer or crew boss"])
    O(["23 kinds of operator<br/>satellites, grid, airline, ships..."])
    M(["Machines<br/>robots, drones, fleets, spacecraft"])
  end
  H["Alexa+<br/>or the demo's stand-in:<br/>a Claude model reading tools/list"]
  OR["<b>Orbita</b><br/>MCP server"]
  subgraph Out["Who it tells"]
    C(["Crew, by email<br/>after they agree"])
    W(["Fleet software<br/>signed webhooks"])
  end
  subgraph Data["Public data"]
    N["NOAA SWPC<br/>Kp, scales, alerts, solar wind,<br/>GloTEC, OVATION, D-RAP, e-field, GOES"]
    D["DLR IMPC<br/>one-minute ROTI, 4,000 links"]
    G["USGS and INTERMAGNET<br/>27 magnetometers"]
    A["GFZ Potsdam<br/>Kp archive since 1932"]
    I["Coast Guard, FAA, CelesTrak<br/>GPS tests and outages"]
    X["Open-Meteo, NTRIP casters<br/>places, time zones, heat, base stations"]
  end
  S["Sudor<br/>heat safety add-on, over MCP"]
  F --> H
  O --> H
  M -- "MCP directly" --> OR
  H -- "MCP, OAuth 2.1 + PKCE" --> OR
  OR --> C
  OR --> W
  N --> OR
  D --> OR
  G --> OR
  A --> OR
  I --> OR
  X --> OR
  OR <-- "a crew member's day, no health data" --> S
```

## 2. On AWS: what runs where

One small always-on instance answers every request; a separate Lambda sends the alerts so they do not depend on the
server staying up. Both read and write the same table.

```mermaid
flowchart LR
  U(["Alexa+, MCP clients,<br/>the demo page"]) -- HTTPS --> GW["API Gateway<br/>HTTP API"]
  subgraph Answers["Answers: always on"]
    APP["EC2 t4g.micro<br/>Node 20 under systemd<br/>MCP endpoint, OAuth, demo pages,<br/>the /agent stand-in<br/>feeds held in memory"]
  end
  subgraph Alerts["Alerts: every 15 minutes"]
    SCH["EventBridge<br/>Scheduler"] --> LAM["Lambda: sweep<br/>image from this repo"]
    LAM -. "fails twice,<br/>or stops" .-> CW["CloudWatch<br/>alarms"] --> SNS["SNS to<br/>the operator"]
  end
  subgraph Shared["Shared by both"]
    DDB[("DynamoDB orbita-farms<br/>sealed, versioned, TTL")]
    SSM["SSM Parameter Store<br/>keys and secrets"]
    SES["SES<br/>crew email"]
  end
  subgraph DemoOnly["The demo page only"]
    ANT["Anthropic API<br/>the stand-in model"]
    POL["Polly<br/>spoken answers"]
  end
  GW -- "origin secret added" --> APP
  APP <--> DDB
  LAM <--> DDB
  APP --> SSM
  LAM --> SSM
  APP --> SES
  LAM --> SES
  APP --> ANT
  APP --> POL
  S3["S3 app bundle"] -- "SSM Run Command<br/>on deploy" --> APP
```

Defined as code: the table, the Lambda, the schedule and the alarms are one CDK stack in [`infra/`](../infra/); the
instance, its hardening and the deploy are in [`deploy/`](../deploy/). There is no SSH: administration goes through
SSM.

## 3. Inside the server

Every request builds its own MCP server and closes it when the response ends. What makes that cheap is that nothing a
tool needs is fetched while it runs: the feeds are already in memory.

```mermaid
flowchart LR
  REQ["POST /mcp"] --> GD["Guards<br/>origin check · rate limit<br/>OAuth token · safe arguments"]
  GD --> SRV["A fresh McpServer<br/>per request"]
  SRV --> T["18 tools<br/>src/tools/*.ts"]
  T --> DOM["The decision<br/>src/domain.ts"]
  T --> ST["Farm store<br/>store.ts · table.ts · vault.ts"]
  T --> SH["Shaping the answer<br/>brief.ts: three sentences<br/>finish.ts: next step<br/>flow.ts: the chain<br/>region.ts: local units"]
  BG["Background timers<br/>background.ts"] --> MEM[("Feeds in memory<br/>swpc · solarwind · glotec · roti<br/>geomag · aurora · ground<br/>particles · interference · ntrip<br/>crewheat · crewday")]
  MEM --> DOM
  SRV --> RES["Resources<br/>ui://orbita/window.html · card.html<br/>orbita://alerts · skill://"]
```

| Folder or file | Holds |
|---|---|
| `src/server.ts` | The routes, one MCP server per request, health, shutdown |
| `src/tools/` | The tools, one file per job: decide, history, setup, crew, records, roles, agents, schedule, season, discovery |
| `src/domain.ts` | Tolerances, geomagnetic latitude, the auroral oval, plasma bubbles, windows: the one model every answer uses |
| `src/standin.ts`, `src/agent.ts`, `src/rules.ts` | The Alexa+ stand-in: a model turn, and the word rules when no model runs |
| `src/store.ts`, `src/table.ts`, `src/vault.ts` | Farm records, DynamoDB with version checks, sealing |
| `src/alerts.ts`, `src/sweep.ts`, `src/lambda.ts` | The storm and clear-window alerts, and the Lambda that runs them |

## 4. A voice turn: from sentence to spoken answer

```mermaid
sequenceDiagram
  autonumber
  actor P as Farmer
  participant H as Alexa+ (or the stand-in)
  participant O as Orbita on EC2
  participant M as Feeds in memory
  participant D as DynamoDB
  P->>H: "My field is near Sorriso, Brazil. The planter's on RTK. Can I plant tonight?"
  H->>O: tools/list (once), then tools/call can_i_run {operation, place, correction, when}
  O->>D: read this farm (version v)
  O->>M: Kp forecast, measured sky, magnetometer, oval, GPS tests
  Note over O: assess(): drift vs the job's tolerance,<br/>evening plasma bubbles near the magnetic equator,<br/>storm margin, next clear window
  O-->>H: spoken text (three sentences) + structured result:<br/>verdict, window, nextAction: watch_jobs
  H-->>P: "Hold off planting tonight... clears Friday at 2 AM. Want me to watch it?"
  P->>H: "Watch it for me."
  H->>O: tools/call watch_jobs {action: start}
  O->>D: write the watch (only if still version v, else re-read and retry)
  O-->>H: "Watching planting... Want somebody on the crew emailed?"
```

The model chooses the tool and says the answer; it never makes the decision. The server's own work in that turn is a
few milliseconds; the rest is the host and the network.

## 5. The decision: go or hold

`can_i_run`, as code decides it ([`src/tools/decide.ts`](../src/tools/decide.ts), [`src/domain.ts`](../src/domain.ts)).

```mermaid
flowchart TD
  Q["Job, field, machine, time"] --> K["Kp for that time<br/>one-minute estimate now, forecast block later"]
  K --> E["Expected drift<br/>quiet error of the correction<br/>x how far the oval reaches over this<br/>geomagnetic latitude, at this hour<br/>x the RTK baseline"]
  E --> T{"Inside the job's<br/>tolerance?"}
  T -- no --> QE{"Out even on<br/>a quiet day?"}
  QE -- yes --> EQ["Not the sun:<br/>the rig cannot hold it"]
  QE -- no --> HOLD["Hold, and when it clears"]
  T -- yes --> B{"Near the magnetic equator,<br/>after sunset, in season?"}
  B -- "yes, carrier phase" --> HOLD
  B -- no --> SM{"Kp 7+ and less than<br/>twice the room?"}
  SM -- yes --> HOLD
  SM -- no --> GO["Go, and until when"]
  GO --> R{"Measured sky now<br/>40% of links disturbed?<br/>or TEC slope over the baseline?"}
  R -- yes --> HOLD
  HOLD --> R2{"Measured sky now<br/>calm, below Kp 8?"}
  R2 -- yes --> GO2["Go for now,<br/>watch the fix"]
  GO --> ADD["Add what matters:<br/>GPS tests, spoofing regions, heat for the crew,<br/>rain for spraying, the solar wind an hour out"]
  HOLD --> ADD
```

## 6. Storm alerts: when nobody asks

An add-on cannot make an Echo speak first, so the alert runs on its own clock.

```mermaid
sequenceDiagram
  autonumber
  participant SCH as EventBridge Scheduler
  participant L as Lambda: sweep
  participant N as NOAA
  participant D as DynamoDB
  participant E as SES
  actor C as Crew member
  SCH->>L: every 15 minutes (one at a time, never retried)
  L->>N: the forecast and the solar wind, once
  L->>D: every farm
  loop each farm
    L->>L: a watched job cleared? a storm within a day for its usual jobs?
    L->>D: write "sent" first, with the version it read
    L->>E: one email, only to people who agreed
  end
  E-->>C: "Planting on the North 40 has cleared"
  Note over L,D: Two failures in a row, or no run for 45 minutes:<br/>a CloudWatch alarm tells the operator.
```

Machines get the same alert as `orbita://alerts` to poll, with an `etag` that changes only when an alert does, or
pushed to their own https address by `alert_my_machines`, signed to the Standard Webhooks format.

## 7. The data: what a farm record holds

One DynamoDB item per farm or demo visitor. The body is sealed, so the table never holds a field's location or a
crew member's address in the clear.

```mermaid
erDiagram
  ITEM ||--|| FARM : "body, sealed"
  ITEM {
    string id "acct:name or demo:128-bit id"
    string body "AES-256-GCM, key id and purpose bound in"
    number v "version, raised on every write"
    number ttl "demo records only: deleted after 7 days"
  }
  FARM ||--o{ FIELD : has
  FARM ||--o{ EQUIPMENT : has
  FARM ||--o{ WATCH : waits_on
  FARM ||--o{ CREW_CONTACT : tells
  FARM ||--o{ JOB_ENTRY : logs
  FARM ||--o| MACHINE_HOOK : pushes_to
  FIELD {
    string name "North 40"
    number lat
    number lon
    number baselineKm "to the RTK base"
    string timeZone
    string countryCode "units and language"
  }
  EQUIPMENT {
    string name "planter"
    string correction "rtk ppp sbas autonomous"
    boolean hardened "scintillation protection"
  }
  WATCH {
    string operation
    string fieldId
    string equipmentId
    string notifiedAt
  }
  CREW_CONTACT {
    string name
    string email
    string confirmedAt "the farm said yes"
    string acceptedAt "the person said yes"
    string acceptHash "only a hash of the link"
  }
  JOB_ENTRY {
    string operation
    string at
    number kp "at that block"
    boolean go "inside tolerance"
    string limitedBy "space_weather or equipment"
  }
  MACHINE_HOOK {
    string url "https, public addresses only"
    string secret "whsec_ signing key"
    string lastEtag
  }
  WATCH }o--|| FIELD : on
  WATCH }o--|| EQUIPMENT : with
  JOB_ENTRY }o--|| FIELD : on
```

Lists are capped (fields, machines, crew, log, alerts sent), higher for linked accounts than for demo visitors. Account
tokens are stored as SHA-256 hashes and passphrases with scrypt, in a sealed file on the instance.

## 8. Consent: who may be emailed

The farm adding somebody is not that person agreeing. Nothing but one invitation is sent until they do.

```mermaid
stateDiagram-v2
  [*] --> Staged: crew_contact add
  Staged --> Confirmed: the farm says yes
  Confirmed --> Invited: one invitation (at most once a day)
  Invited --> Accepted: the person presses Yes on the page
  Invited --> Declined: the person presses No
  Accepted --> Emailed: a watched job clears, or a storm is coming
  Emailed --> Accepted
  Accepted --> Stopped: the stop link in any email
  Staged --> [*]: crew_contact remove
  Accepted --> [*]: crew_contact remove
  Declined --> [*]
  Stopped --> [*]
```

Opening the invitation does not accept it: a mail scanner opens every link, and a scanner is not a person agreeing. The
demo page never sends email; the invitation appears on the phone beside the screen, with the real links.

## 9. Security

```mermaid
flowchart LR
  IN(["A request"]) --> O1{"Origin allowed?<br/>spec 2025-11-25"}
  O1 -- no --> X1["403 before the body is read"]
  O1 -- yes --> O2{"Came through<br/>the gateway?"}
  O2 -- no --> X2["403: origin secret missing<br/>checked live: only /health answers direct"]
  O2 -- yes --> RL{"Within this caller's<br/>rate? 600 burst, 10/s"}
  RL -- no --> X3["429"]
  RL -- yes --> AU{"Bearer token valid?<br/>or a demo id"}
  AU -- no --> X4["401 and account linking"]
  AU -- yes --> T["The tool, scoped to that farm only"]
```

- **Account linking** is OAuth 2.1 with PKCE (S256 only), in the static-client shape Alexa+ uses: Alexa's redirect
  URIs per region, registration closed once they are set, refresh tokens rotated, a replayed one revokes the family.
- **At rest**, every farm and the token file are sealed with AES-256-GCM; the key lives in SSM and is fetched to tmpfs
  at start. A wrong key stops the server rather than starting it empty.
- **Spend** on the model and on speech has a per-caller bucket and a daily cap; a demo visitor cannot send email.
- **Webhooks** go to public https addresses only, checked when sending and connected to as checked, with no redirects.
- **Logs** hold a hash of who asked, never field names, coordinates or addresses.

## 10. Shipping it

```mermaid
flowchart LR
  DEV["Commit"] --> CI["GitHub Actions<br/>build, 2,175 unit checks on Node 20 and 22,<br/>292 against live NOAA, the CDK stack,<br/>DynamoDB Local, the Strands agent"]
  DEV --> B["deploy.sh: build, bundle"]
  B --> S3["S3"] --> RUN["SSM Run Command:<br/>unpack, npm ci, restart"] --> EC2["EC2 under systemd<br/>hardened drop-in"]
  DEV --> CDK["cdk deploy:<br/>table, Lambda image,<br/>schedule, alarms"]
```

## 11. Decisions, and why

- **Stateless, one server per request.** A restart costs nothing and every answer is independent. The one thing that
  outlives a request, the season plan's task, has its own shared store.
- **Feeds in the background, never in a turn.** A voice turn has about half a second. A live call to NOAA can take that
  on its own; a value in memory takes microseconds. When a feed is down, the last good one is used and its age is said.
- **An instance, not a Lambda, for the server.** A cold start eats the turn budget, and the feeds are worth keeping in
  memory between calls. The alerts, which must run whether the server is up or not, are the part on Lambda.
- **DynamoDB with version checks.** The server and the alert Lambda both write the same farm; each write says which
  version it read, so neither overwrites the other.
- **Code decides; the model talks.** Every verdict and number is computed, so no rewording can turn "hold off" into
  "probably fine". The stand-in's reply is checked: it may not drop an emergency number or the reason the answer is
  about this customer.
- **What is measured outranks what is forecast, and only in one direction where it is coarse.** The one-minute
  disturbance overhead can turn a forecast yes into a no and, below Kp 8, a no into a go for now; the coarser
  ionosphere map can only add a no.
- **A source that could not be read is never clear.** It moves a machine to `verify` and says what was not checked.
