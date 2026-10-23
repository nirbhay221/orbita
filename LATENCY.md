# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, with the NOAA forecast already in memory. Node v20.12.2.
Last run 2026-10-22 23:47 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `storm_status` | memory | 4.4 | 9.2 | 9.2 | 50 |
| `farm_status` | memory | 2.9 | 4.7 | 4.7 | 50 |
| `can_i_run` | memory | 3.9 | 6.5 | 6.5 | 50 |
| `what_should_i_do` | memory | 3.2 | 6.4 | 6.4 | 50 |
| `what_else_is_affected` | memory | 2.5 | 5.2 | 5.2 | 50 |
| `what_can_you_do` | memory | 2.8 | 4.7 | 4.7 | 50 |
| `watch_jobs` | memory | 3.9 | 6.5 | 6.5 | 50 |
| `job_report` | memory | 2.7 | 5.4 | 5.4 | 50 |
| `log_job` | memory | 2.5 | 5.3 | 5.3 | 50 |
| `what_happened` | archive | 5.4 | 385.6 | 385.6 | 3000 |

Three tools called one after another, as a single turn might: p50 12.4 ms, p95 16.9 ms.

The slowest in-memory answer is `storm_status` at 9.2 ms p95. `what_happened` is the one tool that leaves the process: it reads the GFZ Kp archive for a
day older than the seven days NOAA keeps live, which is why it has its own budget.
