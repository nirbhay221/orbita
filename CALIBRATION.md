# Calibration against real receivers

How the one judgement in the storm model was chosen, and how it does on a year it was not chosen on.
Made by `node evals/calibrate.mjs` on 2026-10-17, from Nevada Geodetic Laboratory five-minute
positions and GFZ Potsdam definitive Kp. See the top of that script for what "degraded" means and what it does
not measure.

Fitted on 2024 at SKSK, NDFG, NEGI, TXLU (9616 three-hour blocks, 376 degraded).
Tested on 2025 at SKSK, NEGI, TXLU (7080 blocks, 340 degraded). The laboratory has published no 2025 file for the others.

## Choosing the offset, on 2024

Degrees poleward of NOAA's aurora view line at which the disturbed sky is taken to be overhead.

| Offset | Balanced accuracy | Degraded blocks held | Fine blocks held (false holds) | Degraded at Kp 6 and above, held |
|---|---|---|---|---|
| 0 (in the code, best on 2024) | 63.5% | 104 of 376 | 65 | 53 of 61 |
| 1 | 58.5% | 66 of 376 | 55 | 53 of 61 |
| 2 | 57.4% | 58 of 376 | 52 | 50 of 61 |
| 3 | 56.7% | 52 of 376 | 47 | 49 of 61 |
| 4 (before calibration) | 56.4% | 50 of 376 | 47 | 48 of 61 |
| 5 | 55.6% | 44 of 376 | 47 | 44 of 61 |
| 6 | 55.6% | 44 of 376 | 47 | 44 of 61 |
| 7 | 55.6% | 44 of 376 | 47 | 44 of 61 |
| 8 | 55.6% | 44 of 376 | 47 | 44 of 61 |
| 9 | 55.6% | 44 of 376 | 47 | 44 of 61 |
| 10 | 55.6% | 44 of 376 | 47 | 44 of 61 |

## On 2025, which was not used to choose

| Offset | Balanced accuracy | Degraded blocks held | Fine blocks held (false holds) | Degraded at Kp 6 and above, held |
|---|---|---|---|---|
| 0 (in the code, best on 2024) | 63.5% | 95 of 340 | 62 | 35 of 43 |
| 4 (before calibration) | 53.5% | 25 of 340 | 20 | 25 of 43 |

## Each station, with the offset in the code

Of the blocks the model held planting on RTK, how many the receiver there really lost.

| Station | Year | Blocks held | Of those, really lost | Blocks lost in all |
|---|---|---|---|---|
| Saskatoon (SKSK) | 2024 | 103 | 83 | 214 |
| Fargo (NDFG) | 2024 | 18 | 9 | 65 |
| Grand Island (NEGI) | 2024 | 27 | 9 | 54 |
| Lubbock (TXLU) | 2024 | 21 | 3 | 43 |
| Saskatoon (SKSK) | 2025 | 131 | 88 | 202 |
| Grand Island (NEGI) | 2025 | 12 | 5 | 91 |
| Lubbock (TXLU) | 2025 | 14 | 2 | 47 |

## What the receivers did, by Kp

Share of three-hour blocks in which a station lost precise positioning, whatever the model said.

| Kp | 2024 blocks | Lost | 2025 blocks | Lost |
|---|---|---|---|---|
| below 4 | 8844 | 2.5% | 5922 | 2.9% |
| 4 to 5 | 462 | 15.4% | 769 | 9.8% |
| 5 to 6 | 138 | 18.1% | 275 | 19.3% |
| 6 to 7 | 81 | 21.0% | 76 | 31.6% |
| 7 to 8 | 51 | 29.4% | 29 | 41.4% |
| 8 and above | 40 | 72.5% | 9 | 77.8% |

The best value is at the edge of the range tried. Below 0 the disturbed sky would sit equatorward of where the
aurora can be seen at all, which is not physical, so the search stops there.

Reading it. Most degraded blocks are at quiet Kp: a station's own gaps and noise, which no space weather model
can or should call. That is why no offset holds more than a minority of all degraded blocks, and why the column
that matters is the last one, the blocks lost in a real storm. The share lost climbs with Kp in both years, which
is the relationship the model is built on, measured rather than assumed.
