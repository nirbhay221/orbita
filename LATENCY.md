# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, with the NOAA forecast already in memory. Node v20.12.2.
Last run 2026-10-01 02:49 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `storm_status` | memory | 3.2 | 9.5 | 9.5 | 50 |
| `farm_status` | memory | 2.0 | 4.5 | 4.5 | 50 |
| `can_i_run` | memory | 2.4 | 5.1 | 5.1 | 50 |
| `what_should_i_do` | memory | 2.0 | 3.7 | 3.7 | 50 |
| `what_else_is_affected` | memory | 1.9 | 3.7 | 3.7 | 50 |
| `what_can_you_do` | memory | 1.9 | 4.2 | 4.2 | 50 |
| `watch_jobs` | memory | 1.7 | 3.7 | 3.7 | 50 |
| `job_report` | memory | 1.8 | 3.9 | 3.9 | 50 |
| `log_job` | memory | 1.9 | 4.1 | 4.1 | 50 |
| `what_happened` | archive | 2.5 | 504.7 | 504.7 | 3000 |

Three tools called one after another, as a single turn might: p50 6.7 ms, p95 11.5 ms.

The slowest in-memory answer is `storm_status` at 9.5 ms p95. `what_happened` is the one tool that leaves the process: it reads the GFZ Kp archive for a
day older than the seven days NOAA keeps live, which is why it has its own budget.
