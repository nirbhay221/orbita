# Backtest: three planting seasons, replayed

Observed Kp (GFZ Potsdam), 15 April to 15 June, through the same decision code the server runs.
The job is planting on RTK, which needs about two inches. A block is three hours.

| Season | Place | Blocks | Outside tolerance | Days affected |
|---|---|---|---|---|
| 2023 | Fargo, North Dakota | 489 | 4 (0.8%) | 2 |
| 2023 | Grand Island, Nebraska | 489 | 4 (0.8%) | 2 |
| 2023 | Saskatoon, Saskatchewan | 489 | 5 (1.0%) | 3 |
| 2023 | Lubbock, Texas | 489 | 4 (0.8%) | 2 |
| 2024 | Fargo, North Dakota | 489 | 13 (2.7%) | 4 |
| 2024 | Grand Island, Nebraska | 489 | 13 (2.7%) | 4 |
| 2024 | Saskatoon, Saskatchewan | 489 | 15 (3.1%) | 6 |
| 2024 | Lubbock, Texas | 489 | 13 (2.7%) | 4 |
| 2025 | Fargo, North Dakota | 489 | 7 (1.4%) | 4 |
| 2025 | Grand Island, Nebraska | 489 | 7 (1.4%) | 4 |
| 2025 | Saskatoon, Saskatchewan | 489 | 9 (1.8%) | 4 |
| 2025 | Lubbock, Texas | 489 | 7 (1.4%) | 4 |

## Every kind of job, 2025 season

Share of three-hour blocks where the answer would have been "not now".

| Job | Correction | Fargo, North Dakota | Grand Island, Nebraska | Saskatoon, Saskatchewan | Lubbock, Texas |
|---|---|---|---|---|---|
| planting | RTK | 1.4% | 1.4% | 1.8% | 1.4% |
| surveying | RTK | 1.4% | 1.4% | 5.1% | 1.4% |
| drone survey | RTK | 1.4% | 1.4% | 1.8% | 1.4% |
| machine control | RTK | 1.4% | 1.4% | 1.8% | 1.4% |
| spraying | WAAS | 1.4% | 1.4% | 1.8% | 1.4% |
| harvest | WAAS | 1.4% | 1.4% | 1.8% | 1.4% |
| tillage | WAAS | 0.0% | 0.0% | 0.2% | 0.0% |
| spraying | PPP | 0.0% | 0.0% | 1.2% | 0.0% |
| scouting | none | 0.0% | 0.0% | 1.2% | 0.0% |
| surveying | PPP | never, on this correction | never, on this correction | never, on this correction | never, on this correction |
| tillage | none | never, on this correction | never, on this correction | never, on this correction | never, on this correction |

The first run of this table found a second fault. The rules for WAAS, PPP and no correction made every northern
site 60 percent worse on a quiet day, so a sprayer on WAAS at Fargo was told it could never hold spraying
tolerance, and walking a field with a phone was called impossible in Saskatchewan. Every correction is now judged
from the same measure of how disturbed the sky is. Only the RTK row is anchored to published measurements; the
others are scaled from it.

Strongest block in each season:

* 2023: Kp 8.3 at 2023-04-23 18:00 UTC
* 2024: Kp 9.0 at 2024-05-11 00:00 UTC
* 2025: Kp 7.7 at 2025-04-16 18:00 UTC

**What this replay was for.** The first run of it showed the earlier model calling RTK planting outside tolerance
from Kp 4 at northern sites: 26 percent of all blocks at Fargo in 2025. Growers do not lose guidance a quarter of
the time, so the model was wrong, and it was rebuilt around how far the auroral oval has come instead of Kp alone,
anchored to three published measurements (see rtkMultiplier in src/domain.ts). The table above is the rebuilt
model: a few percent of blocks, on the days that had real storms.

What this shows: how often, and where, the answer would have been "not now". What it does not show: that a
receiver in these fields drifted by the modelled amount. The Kp-to-drift model has not been checked against a receiver.

Generated 2026-10-04 by `node evals/backtest.mjs`.

## Against real receivers, 2024 season

Five-minute positions from permanent GPS stations at the four sites (Nevada Geodetic Laboratory), per three-hour
block, against what the model says about RTK planting there. "Degraded" means fewer than half the positions exist,
or their 95th percentile is more than 5 cm out.

| Station | Blocks | Model no, receiver degraded | Model no, receiver fine | Model yes, receiver degraded | Model yes, receiver fine | Agree |
|---|---|---|---|---|---|---|
| Saskatoon, Saskatchewan (SKSK) | 496 | 12 | 3 | 34 (21 below Kp 4) | 447 | 92.5% |
| Fargo, North Dakota (NDFG) | 456 | 8 | 5 | 14 (10 below Kp 4) | 429 | 95.8% |
| Grand Island, Nebraska (NEGI) | 496 | 4 | 9 | 12 (11 below Kp 4) | 471 | 95.8% |
| Lubbock, Texas (TXLU) | 440 | 1 | 3 | 16 (15 below Kp 4) | 420 | 95.7% |

Share of positions that exist in each three-hour block of 10 and 11 May 2024 (100 is all of them):

* Saskatoon, Saskatchewan: 100 100 100 100 100 97 0 0 0 0 0 0 0 14 100 100
* Fargo, North Dakota: 100 100 100 100 100 100 39 0 0 0 0 0 3 100 100 100
* Grand Island, Nebraska: 100 100 100 100 100 100 89 0 0 0 0 67 100 100 100 100
* Lubbock, Texas: 100 100 100 100 100 100 61 0

What it shows. Every one of the four receivers lost precise positioning for twelve hours or more from the evening
of 10 May, and the model calls those blocks. Below that level the receivers held about 2 cm, including through
Kp 5 and 6, which is why the model no longer calls a job off at Kp 4. Most of the blocks the model clears and a
receiver was degraded in are at low Kp: ordinary gaps and noise at a station, nothing to do with the sun.
Two things it does not flatter. Lubbock has no positions at all on 11 May, so that day is left out and its row
undercounts the storm. And at Saskatoon about a dozen blocks at Kp 4 and above were degraded while the model said
clear, which suggests the model is still a little too easy at that latitude at night.

What it does not show. These positions are worked out afterwards from both GPS frequencies, which removes most of
the ionosphere and discards the epochs it cannot solve. That is not RTK in a cab. It says when precise positioning
was lost, which is what a go or no-go is about, and not how far a rover drifted while it still had a fix. In a
severe storm the honest description is that the fix is lost, not that it wanders by some number of inches.

Generated 2026-10-04 by `node evals/receivers.mjs`.
