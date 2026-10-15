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

## Asking again

`recheckInMinutes` is 30 after `trust` and 10 after anything else. For `verify` and `do_not_trust` the answer
carries `nextAction`: the same call with the same arguments. Make it when the time is up.

When NOAA cannot be reached the answer has `unavailable: true` and the verdict `verify`. It names no next call.
