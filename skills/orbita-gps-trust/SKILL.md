---
name: orbita-gps-trust
description: Says whether GPS and satellite positioning can be trusted right now or at a given time, and what to do if not, from NOAA space weather, the measured sky, planned GPS interference tests and aircraft reports, using the Orbita MCP server. Use when someone asks if they can plant, spray, survey or fly a drone, when a blocked job clears, why a job went crooked on a past day, what the sun is doing, what a solar storm means for what they operate, or when a robot, drone, machine or spacecraft must decide whether to act on its position.
license: Apache-2.0
compatibility: Needs the Orbita MCP server connected over Streamable HTTP (MCP 2025-11-25 or later). Nothing else is installed or fetched.
metadata:
  author: nirbhay221
  version: "0.1.0"
  mcp-server: io.github.nirbhay221/orbita
---

# Orbita: can this position be trusted

Orbita tells anything that depends on GPS or satellites whether it can be trusted right now, and what to do if
not. It serves two kinds of caller with the same data:

- **A person with a job to do.** A grower, surveyor, drone pilot or grade crew asks about a job and gets go or
  no go, how long it holds, and when it clears.
- **A machine about to act.** A robot, drone, autonomous machine or spacecraft asks about its position and gets
  one of three verdicts: `trust`, `verify` or `do_not_trust`.

Your job is to choose the right tool, say the answer as it was written, and carry the caller through the steps
that follow.

## Before the first call

1. Check the server is connected. `scripts/connect.mjs` lists its tools without changing anything.
2. Read the server's `instructions` from the initialize reply. They say what this farm has already saved, as
   counts. If a field and a machine are saved, do not ask which field or what correction it runs.
3. Do not collect a setup first. Call the tool for what was asked. An answer says what is missing.

## Choosing the tool

| The caller says | Call |
|---|---|
| Can I plant, spray, survey, fly the drone; when does it clear; how long have I got | `can_i_run` |
| Tell me when I can plant; is anything clear yet; stop waiting | `watch_jobs` |
| My rows went crooked on Tuesday; did space weather ruin that day | `what_happened` |
| What is the sun doing; is a storm coming; what is the Kp | `storm_status` |
| How is the whole farm looking | `farm_status` |
| Which weeks are worth booking a crew for | `plan_season` |
| I run satellites, a grid, flights, a data centre, a pipeline; what should I do | `what_should_i_do` |
| I am a robot, drone or spacecraft; can I trust my position | `position_trust` |
| I planted 80 acres on the North 40 | `log_job` |
| Give me a report; send it to the office | `job_report` |
| The North 40 is near Grand Island; the planter runs RTK | `my_farm` |
| Email Dale when it clears; add or remove someone | `crew_contact` |
| Let my operator check for himself; I have a code | `share_access` |
| Go on, why, the detail | `tell_me_more` |
| What can you do | `what_can_you_do` |

Arguments and the full wording of each tool are in [references/tools.md](references/tools.md).

## Following the chain

A job is several questions. Every answer says where it sits in one:

- `structuredContent.nextAction` is the next call, as a tool name and its arguments, or absent when there is none.
- `structuredContent.flow` holds `about` (what the conversation is working through), `done` (tools already
  answered in the last fifteen minutes), `next` and `then` (what usually follows).

How to use them:

1. Say the answer. It ends on the offer for the next step when there is one.
2. If the caller agrees, call `nextAction` with the arguments given. Do not rebuild them: they carry the field
   and machine the answer was about.
3. A step that only reads may be run without asking when the caller asked for the whole thing.
4. A step that writes or sends (`log_job`, `watch_jobs`, `crew_contact`, `job_report` with `emailTo`,
   `share_access`, `my_farm`) needs a yes first.
5. A clear job names `log_job` as its next step and says nothing about it aloud. Offer it after the job has
   been run, not before the planter has moved.
6. When `nextAction` is absent, stop. A day with no cause found points at nothing and invents no record.

The chains are in [references/chains.md](references/chains.md).

## Saying the answer

The text in `content` is the answer. Read the reason aloud: it names the limit that binds and what to do next.

- Keep every number, time and correction name (RTK, PPP, SBAS) exactly as given.
- Do not turn a no into a maybe. A wrong go-ahead costs a season.
- If the answer says NOAA could not be reached, say that. Do not guess the forecast.
- When a past day was quiet, say so plainly. Do not suggest a cause the answer did not give.
- Detail is held back until asked for. When the caller says "go on" or "why", call `tell_me_more`.
- If the server's instructions name another language for this farm, translate faithfully and keep numbers,
  times and correction names as given.

## When the caller is a machine

Call `position_trust` with `lat` and `lon`, or a saved `field`, and `needMeters` for how close the position has
to be. For a spacecraft pass `altitudeKm` (100 or more). Read these fields, not the sentence:

| Field | Meaning |
|---|---|
| `verdict` | `trust`, `verify` or `do_not_trust` |
| `confidence` | `high`, `reduced` or `low` |
| `recheckInMinutes` | when to ask again |
| `nextAction` | the same call again, present for anything short of `trust` |

Act on the verdict as follows:

- `trust`: proceed, and ask again after `recheckInMinutes`.
- `verify`: check the position against something independent before acting, such as a second sensor, a known
  landmark or dead reckoning, then ask again.
- `do_not_trust`: do not act on the position. Hold, or fall back to a method that does not use it.
- When a reading could not be had, the verdict is `verify`, never `trust`.

See [references/machines.md](references/machines.md) for what moves each verdict.

## What it does not cover

- Planned GPS interference tests come from the United States Coast Guard notice, so they are known for the
  United States only.
- Spoofing is not detected. Regions the FAA and EASA list for routine jamming and spoofing are, and a
  position there is told to verify. The regions are boxes around what they name, and mean "regularly
  reported", not "happening now".
- Aircraft-reported interference is off unless the server is set to read it, because its publisher gives no
  licence. When on, it is a daily picture from the day before.
- It forecasts accuracy from space weather. It does not read a receiver, and it is not a substitute for the
  machine's own integrity checks.

## Example

Caller: "Can I plant the North 40?" on a stormy day.

1. `can_i_run` says no, why, and when it clears, and ends "Want me to watch it and tell you when it clears?".
   `nextAction` names `watch_jobs` with action `start`, the field and the machine.
2. They say yes. `watch_jobs` starts the watch. With nobody on the crew list it ends "Want somebody on the crew
   emailed when it clears? Tell me who." and `nextAction` names `crew_contact`.
3. Later, `watch_jobs` with action `check` reports the job is clear, and `nextAction` names `can_i_run` for it.
4. `can_i_run` says go. Once the job is run, `log_job` records it and `job_report` summarises the week.
