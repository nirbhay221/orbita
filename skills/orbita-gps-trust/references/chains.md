# The chains

Each row is a step an answer can name as `nextAction`, and the condition the server applies before naming it.
The server decides from the farm's own state. Never call a step the answer did not name.

## A job, from whether it can run to the record of it

| After | When | Next |
|---|---|---|
| `can_i_run` | blocked now and it will clear | `watch_jobs` with action `start`, the field and the machine |
| `can_i_run` | clear, on a saved field and machine | `log_job`, to be offered once the job has been run |
| `can_i_run` | asked about a place that is not saved yet | `my_farm`, to save it |
| `watch_jobs` | a watch started and nobody is on the crew list | `crew_contact` with action `add` |
| `watch_jobs` | a watch started and the crew will be emailed | `watch_jobs` with action `check` |
| `watch_jobs` | a watched job has cleared | `can_i_run` for that job |
| `crew_contact` | someone was added | `crew_contact` with action `confirm`, after a yes |
| `log_job` | the job was recorded | `job_report` |

## A job that went badly

| After | When | Next |
|---|---|---|
| `what_happened` | space weather, a military GPS test or aircraft-reported interference explains it | `log_job` with the cause in `note` |

A day with no cause found names nothing. No record is invented.

## The storm

| After | When | Next |
|---|---|---|
| `storm_status` | a storm is running or on its way | `farm_status` |
| `farm_status` | space weather is blocking a job | `can_i_run` for the job it is hurting |
| `what_should_i_do` | more steps are held back | `what_should_i_do` with the `step` given |

## Setting up

| After | When | Next |
|---|---|---|
| `my_farm` | a field or machine was saved | `farm_status` |

## A machine and its position

| After | When | Next |
|---|---|---|
| `position_trust` | the verdict is `verify` | `position_trust` with the same arguments |
| `position_trust` | the verdict is `do_not_trust` | `position_trust` with the same arguments and `windowsHours` 72: when it clears |
| `position_trust` with `windowsHours` | the first window opens within six hours | `position_trust` at that position with `inMinutes` set to when it opens |
| `position_trust` with `points` | any position is short of `trust` | `position_trust` for the worst position with `windowsHours` 72 |
| `what_should_i_do` | a robot, drone, mining or fleet role, a storm on, and a known place | `position_trust` there, with what that kind of machine relies on in `dependsOn` |

A verdict of `trust` names nothing, and neither does a window that is already open. Past six hours, read
`orbita://alerts` at its `checkAgainAt` instead of chaining.

## Reading `flow`

```json
{
  "about": "a job, from whether it can run to the record of it",
  "done": ["can_i_run", "watch_jobs"],
  "next": "crew_contact",
  "then": []
}
```

`done` is kept for fifteen minutes as tool names only. `next` is always the tool in `nextAction`. `then` is
what usually follows, and each of those tools still decides for itself whether its step applies.
