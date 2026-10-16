# The tools

Written from the server's own tool list by `scripts/skill-tools.mjs`. Do not edit by hand.

A tool marked "reads" changes nothing. A tool marked "writes" saves or sends something, so the person agrees first.

## `can_i_run`

Reads.

Go or no go for a GPS-guided field operation right now or at a given time, based on the NOAA geomagnetic forecast, the field location, and the accuracy the job actually needs. Also answers how long it stays clear, and when the next clear stretch starts if it is blocked now, so it covers "can I run this", "when does it clear" and "how long have I got". Only the job is needed; the saved field and machine are used. Read the reason aloud. Use it for a single question about one job. To be told later when a blocked job clears, or to be emailed, use watch_jobs; for the weather in general with no job in mind, use storm_status.

| Argument | Values | Needed |
|---|---|---|
| `operation` | planting, strip_till, cultivating, spraying, harvest, tillage, scouting, surveying, drone_survey, machine_control | yes |
| `field` | string | no |
| `equipment` | string | no |
| `place` | string | no |
| `correction` | rtk, ppp, sbas, autonomous | no |
| `when` | string | no |
| `deadline` | string | no |

## `crew_contact`

Writes.

Manage who gets emailed when a watched job clears or a storm is coming. action add stages someone, and nothing is ever sent until action confirm, which the customer has to say yes to first. action remove stops emailing them. Call this when someone says to tell, notify, add, confirm or stop telling a crew member, operator or manager. To link a crew member's working day from their heat safety add-on, pass action add with their name and the dayCode they read out.

| Argument | Values | Needed |
|---|---|---|
| `action` | add, confirm, remove | yes |
| `name` | string | yes |
| `email` | string | no |
| `role` | string | no |
| `when` | window_clear, storm, both | no |
| `dayCode` | string | no |

## `farm_status`

Reads.

Every registered field and machine, and whether accuracy holds for each at the moment, as one overview. Call this when someone asks how the farm is looking, what is going on across the fields, or for a summary of everything. It does not look at past jobs (use job_report) and does not answer one specific job (use can_i_run).

No arguments.

## `job_report`

Writes.

Summarise logged jobs over recent days, and which ran while space weather put them outside tolerance. Name a confirmed crew contact in emailTo and the same report is emailed to them, for a client, an insurer or the office. Call this when the customer asks for a report, a record, or to send one to someone. It reads jobs already logged; to record a new one use log_job.

| Argument | Values | Needed |
|---|---|---|
| `days` | integer | no |
| `emailTo` | string | no |

## `log_job`

Writes.

Record a job that was actually run, with the space weather at the time, so it can be reported on later, for a crew, a client or an insurer. Call this when the customer says they planted, sprayed, surveyed or ran a job, including how much was done. It records something that already happened; it does not check whether a job can run (use can_i_run) or summarise past jobs (use job_report).

| Argument | Values | Needed |
|---|---|---|
| `operation` | planting, strip_till, cultivating, spraying, harvest, tillage, scouting, surveying, drone_survey, machine_control | yes |
| `field` | string | no |
| `equipment` | string | no |
| `when` | string | no |
| `acres` | number | no |
| `note` | string | no |

## `my_farm`

Writes.

Describe the operation: add or correct a field or site by its name and nearest town, add or correct a machine by its name and the correction it runs, or take one off the list. Call this when someone says where a field or site is, what correction a planter, sprayer, rover, drone or dozer runs, or asks to remove a field or a machine or to forget everything. A field and a machine can be given together. It only records them; for whether a job can run use can_i_run, and for people on the crew use crew_contact.

| Argument | Values | Needed |
|---|---|---|
| `fieldName` | string | no |
| `place` | string | no |
| `crop` | string | no |
| `acres` | number | no |
| `baselineKm` | number | no |
| `machineName` | string | no |
| `correction` | rtk, ppp, sbas, autonomous | no |
| `hardened` | boolean | no |
| `removeWhat` | field, machine, everything | no |
| `removeName` | string | no |

## `plan_season`

Reads.

Work out which jobs hold accuracy on which fields across the next 45 days, from the NOAA 45 day Ap forecast. Use this for questions about weeks rather than today: when to book a custom crew, which week to plan planting, whether a machine can hold a tolerance at all. The spoken answer gives the longest clear run; the full table is in the structured result for a host that has a screen.

No arguments.

## `position_trust`

Reads.

For a software agent, robot, drone, autonomous machine or spacecraft about to act on its position: whether that position can be trusted right now, or a set number of minutes ahead (inMinutes, judged from the forecast), as one of three verdicts (trust it, verify it first, or do not trust it), with the reasons. On the ground it combines space weather, the measured sky, planned military GPS tests and aircraft-reported jamming; for a spacecraft, give its altitude and it judges drag, its own receiver and charging. Call this when an agent or machine asks whether to rely on its position or whether GPS is reliable somewhere. It is not for whether a farm or survey job can run (use can_i_run), nor for what went wrong earlier (use what_happened).

| Argument | Values | Needed |
|---|---|---|
| `lat` | number | no |
| `lon` | number | no |
| `field` | string | no |
| `altitudeKm` | number | no |
| `needMeters` | number | no |
| `inMinutes` | integer | no |
| `hardened` | boolean | no |
| `correction` | rtk, ppp, sbas, autonomous | no |

## `share_access`

Writes.

Let another person ask about this farm from their own account, without being able to change anything. action invite gives the owner a one-time code to read to them. action join is said by the other person, with the code, from their own account. action leave is the other person stopping. action stop is the owner ending it for everybody. Call this when someone says let my operator check for himself, give Dale access, I have a code, or stop sharing. It is not for adding somebody to be emailed; that is crew_contact.

| Argument | Values | Needed |
|---|---|---|
| `action` | invite, join, leave, stop | yes |
| `code` | string | no |

## `storm_status`

Reads.

Current geomagnetic conditions and any active NOAA alerts, in plain language: the Kp index, the storm scale, and whether anything is happening right now. Call this when someone asks what the sun or space weather is doing, whether a storm is coming, or for the Kp. It does not say whether a job can run; use can_i_run for that.

No arguments.

## `tell_me_more`

Reads.

Continue the last answer. Answers are kept short for listening, and the detail is held back until asked for. Call this when the customer says go on, tell me more, why, what else, give me the detail or the rest, straight after another answer. It takes no arguments and only continues; it does not answer a new question.

No arguments.

## `watch_jobs`

Writes.

Wait on a job that space weather is blocking. action start watches a job and says when the forecast clears it. action check reports which watched jobs are clear now and when the rest clear. action stop cancels a watch, or all of them when no job is named. Call this when the customer wants to be told when they can run something, asks whether anything is clear yet, or says to stop waiting. Confirmed crew contacts are emailed when a watched job clears. Use it to be told later, not to answer whether a job can run right now; that is can_i_run. The job must be named when starting a watch.

| Argument | Values | Needed |
|---|---|---|
| `action` | start, check, stop | yes |
| `operation` | planting, strip_till, cultivating, spraying, harvest, tillage, scouting, surveying, drone_survey, machine_control | no |
| `field` | string | no |
| `equipment` | string | no |

## `what_can_you_do`

Reads.

Explain what this add-on is for and how to ask for it. Call this when the customer asks what you can do, what this is, how to use it, or opens with something too vague to route. It changes nothing and needs no setup. Do not use it when the customer has asked a specific question, even a short one; use the tool for that.

No arguments.

## `what_happened`

Reads.

Look back at a past day, or a time on that day, and say whether space weather explains a job that went badly. Call this when someone describes crooked rows, skips, overlap, a survey that would not close, or a machine that seemed to be misbehaving, and names a day. If the conditions were quiet, say so plainly rather than inventing a cause. It looks backwards only; for whether a job can run now or later, use can_i_run.

| Argument | Values | Needed |
|---|---|---|
| `when` | string | yes |
| `operation` | planting, strip_till, cultivating, spraying, harvest, tillage, scouting, surveying, drone_survey, machine_control | no |
| `field` | string | no |
| `equipment` | string | no |

## `what_should_i_do`

Reads.

Protective steps for somebody who looks after something a solar storm can reach: drones, satellites, the power grid, flights, HF radio, GPS timing, pipelines, directional drilling, railway signalling, a vessel holding position, automated mining, a vehicle fleet, aurora watching, a household, a small plane, a magnetic survey or robots. Timed to the NOAA forecast. Call this when someone asks what they should do, whether to postpone, or says what they operate and asks whether it will affect them. Read the answer aloud as given. It is not for whether a field job can run (use can_i_run) or for the current Kp (use storm_status).

| Argument | Values | Needed |
|---|---|---|
| `role` | field_crew, drone_pilot, satellite_operator, crewed_spaceflight, grid_operator, airline, hf_radio, timing, data_centre, pipeline, drilling, rail, maritime_dp, mining, fleet, aurora, household, general_aviation, magnetic_survey, robots | no |
| `orbit` | low, medium, high, beyond | no |
| `step` | integer | no |
| `place` | string | no |
