# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, with the NOAA forecast already in memory. Node v20.12.2.
Last run 2026-10-04 19:35 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `storm_status` | memory | 6.3 | 17.8 | 17.8 | 50 |
| `farm_status` | memory | 3.2 | 5.1 | 5.1 | 50 |
| `can_i_run` | memory | 4.8 | 8.2 | 8.2 | 50 |
| `what_should_i_do` | memory | 3.9 | 8.7 | 8.7 | 50 |
| `what_else_is_affected` | memory | 3.2 | 5.2 | 5.2 | 50 |
| `what_can_you_do` | memory | 3.2 | 5.4 | 5.4 | 50 |
| `watch_jobs` | memory | 4.3 | 6.9 | 6.9 | 50 |
| `job_report` | memory | 4.2 | 9.0 | 9.0 | 50 |
| `log_job` | memory | 4.0 | 6.1 | 6.1 | 50 |
| `what_happened` | archive | 7.1 | 525.1 | 525.1 | 3000 |

Three tools called one after another, as a single turn might: p50 17.7 ms, p95 31.2 ms.

The slowest in-memory answer is `storm_status` at 17.8 ms p95. `what_happened` is the one tool that leaves the process: it reads the GFZ Kp archive for a
day older than the seven days NOAA keeps live, which is why it has its own budget.
