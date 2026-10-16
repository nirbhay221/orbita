# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, with the NOAA forecast already in memory. Node v20.12.2.
Last run 2026-10-16 16:22 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `storm_status` | memory | 4.4 | 11.6 | 11.6 | 50 |
| `farm_status` | memory | 2.8 | 5.0 | 5.0 | 50 |
| `can_i_run` | memory | 3.8 | 6.7 | 6.7 | 50 |
| `what_should_i_do` | memory | 4.0 | 7.1 | 7.1 | 50 |
| `what_else_is_affected` | memory | 3.0 | 10.3 | 10.3 | 50 |
| `what_can_you_do` | memory | 2.7 | 4.9 | 4.9 | 50 |
| `watch_jobs` | memory | 2.7 | 5.7 | 5.7 | 50 |
| `job_report` | memory | 2.6 | 4.2 | 4.2 | 50 |
| `log_job` | memory | 3.1 | 6.4 | 6.4 | 50 |
| `what_happened` | archive | 3.3 | 543.0 | 543.0 | 3000 |

Three tools called one after another, as a single turn might: p50 8.7 ms, p95 12.1 ms.

The slowest in-memory answer is `storm_status` at 11.6 ms p95. `what_happened` is the one tool that leaves the process: it reads the GFZ Kp archive for a
day older than the seven days NOAA keeps live, which is why it has its own budget.
