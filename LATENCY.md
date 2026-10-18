# Latency

Measured by `node test-latency.mjs`, 20 calls per tool, over HTTP against the built
server on this machine, with the NOAA forecast already in memory. Node v20.12.2.
Last run 2026-10-17 06:33 UTC.

A voice turn is roughly half a second in total, and the add-on is one part of that.
Everything below is the server's own share, from request received to response written.

| tool | source | p50 ms | p95 ms | max ms | budget |
|---|---|---|---|---|---|
| `storm_status` | memory | 4.6 | 10.1 | 10.1 | 50 |
| `farm_status` | memory | 2.6 | 6.2 | 6.2 | 50 |
| `can_i_run` | memory | 3.4 | 6.2 | 6.2 | 50 |
| `what_should_i_do` | memory | 2.7 | 8.6 | 8.6 | 50 |
| `what_else_is_affected` | memory | 2.0 | 3.9 | 3.9 | 50 |
| `what_can_you_do` | memory | 2.2 | 5.7 | 5.7 | 50 |
| `watch_jobs` | memory | 2.0 | 4.6 | 4.6 | 50 |
| `job_report` | memory | 2.1 | 4.0 | 4.0 | 50 |
| `log_job` | memory | 1.9 | 3.8 | 3.8 | 50 |
| `what_happened` | archive | 3.2 | 523.1 | 523.1 | 3000 |

Three tools called one after another, as a single turn might: p50 7.6 ms, p95 10.4 ms.

The slowest in-memory answer is `storm_status` at 10.1 ms p95. `what_happened` is the one tool that leaves the process: it reads the GFZ Kp archive for a
day older than the seven days NOAA keeps live, which is why it has its own budget.
