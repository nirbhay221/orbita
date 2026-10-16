# What moves a position verdict

`position_trust` returns `trust`, `verify` or `do_not_trust`. The rule is the same everywhere: one reason
against gives `do_not_trust`, one reason for caution gives `verify`, and nothing against it gives `trust`.
Anything that could not be read counts as caution, never as clear.

The reasons are in `reasons` as sentences, and the readings behind them are in `checks`.

## A receiver on the ground

Give `lat` and `lon`, or a saved `field`. `needMeters` is the accuracy the action needs, 5 when not given.
`correction` is `rtk`, `ppp`, `sbas` or `autonomous`, and `autonomous` when not given. Pass `hardened: true`
only for a receiver with scintillation protection: the scintillation rows below then give `verify`, never
`do_not_trust`. Pass `inMinutes` (up to 360) for an action that is not now: the verdict is then judged from the
forecast for that time, says so, and carries `forecastOnly: true`, because the sky can only be measured now.

| What was found | Verdict |
|---|---|
| The expected error is outside `needMeters` at the current Kp | `do_not_trust` |
| An RTK receiver, in a storm strong enough that RTK loses its fix there | `do_not_trust` |
| The measured sky over the point is disturbed, for RTK or PPP, needing better than 0.3 metres | `do_not_trust` |
| The measured sky over the point is disturbed, for RTK or PPP, needing 0.3 metres or looser | `verify` |
| Evening near the magnetic equator in that longitude's season, for RTK or PPP | `verify`, or `do_not_trust` under 0.3 metres |
| A planned military GPS interference test reaches the point | `verify` |
| The point is in a region the FAA or EASA lists for routine jamming and spoofing | `verify` |
| A high share of aircraft over the area reported degraded GPS the day before (only when the server reads aircraft reports) | `verify` |
| Three or more GPS satellites out of service at once | `verify` |
| The solar wind upstream says a disturbance is likely within the hour | `verify` |
| The space weather reading is older than 45 minutes, or a source could not be read | `verify` |

Fields returned: `verdict`, `confidence`, `expectedErrorM`, `needM`, `correction`, `position`, `reasons`,
`checks` (with `spoofingRegion`), `recheckInMinutes`, `sources`.

## A spacecraft

Give `altitudeKm` of 100 or more. `lat` and `lon` are then the point on the ground below, and are optional.

| Orbit | What is judged |
|---|---|
| Low, under 2,000 km | Drag on the predicted orbit in a geomagnetic storm, and the craft's own GPS receiver over the magnetic equator in the evening and at high latitude |
| Medium and high | Energetic electrons in the outer radiation belt, and surface charging in a strong storm |
| Any | A solar radiation storm |

Fields returned: `verdict`, `confidence`, `spacecraft`, `altitudeKm`, `orbit`, `reasons`, `checks`,
`recheckInMinutes`, `sources`.

## Which form to call

One tool, five forms. Pick by what the caller has, and use one at a time:

| The caller has | Call | Gets |
|---|---|---|
| One position, acting now or within six hours | `lat`, `lon` (and `inMinutes`) | One verdict |
| A spacecraft | `altitudeKm` of 100 or more | One verdict for its orbit |
| More it relies on than its fix | `dependsOn`, with or without `satellite_position` | The worst verdict, and one per dependency |
| Many positions: a fleet, a swarm, a co-op's sites | `points`, up to 1,000 | Counts, the worst verdict, and the ones not trusted, worst first |
| A plan for the next days | `windowsHours`, up to 72 | Every clear window at that accuracy |

`points` and `windowsHours` take the receiver and accuracy the same way a single call does. A point in a fleet
call gets exactly the verdict it would get alone. Windows come from NOAA's three hour forecast and carry
`forecastOnly: true`; call the single form again just before acting.

## Anything else it relies on

`dependsOn` names what else the sun can reach: `satellite_link`, `hf_radio`, `grid_power`,
`electronics_at_altitude` (give `altitudeKm`), `compass`, `gps_time`, `traffic_awareness`. Each is judged from
live data and capped at what its evidence supports: `grid_power` and `compass` never go past `verify`. The
answer leads with one sentence of verdicts, then the reasons worst first, and `dependencies` holds each one with
its source.

## Alerts to poll

A scheduler does not need to ask every few minutes. Read the resource `orbita://alerts`: each saved site and
machine is `imminent` (out of tolerance within a day), `watch` (within three) or `clear`, with the blocked hours
and the clear windows. `etag` changes only when an alert does; re-plan when it changes, and read it again at
`checkAgainAt`, which is sooner when a storm is close.

## Asking again

`recheckInMinutes` is 30 after `trust` and 10 after anything else. For `verify` and `do_not_trust` the answer
carries `nextAction`: the same call with the same arguments. Make it when the time is up.

When NOAA cannot be reached the answer has `unavailable: true` and the verdict `verify`. It names no next call.
