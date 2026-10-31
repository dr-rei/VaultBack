# VaultBack domain vocabulary

- **Schedule:** a recurring backup configuration selecting source connections, database scope, destinations, format, retry limits and retention.
- **Execution:** one scheduled, manual, retry or catch-up request, with its non-secret configuration snapshot and durable aggregate outcome.
- **Pair:** one source connection and destination within an execution, including the selected database scope and whether that destination is required.
- **Attempt:** one concrete try to execute a pair. A completed attempt can link to a historical `backup_runs` artifact record. A retry is a new current backup, not reconstruction of an earlier point in time.
- **Source group:** source connections sharing a concurrency limit. Host and effective port provide the automatic grouping; administrator overrides identify aliases or proxies.
- **Queue:** durable eligible work ordered by explicit administrator priority and enqueue sequence. Active work is never preempted by reprioritization.
- **Verified freshness:** age of the latest successful, artifact-verified backup matching a pair's current protection configuration. Optional destinations do not determine required protection status.
- **Recovery confidence:** separate evidence that a particular artifact was restored and checked on a dedicated recovery destination, with cleanup results and tested timestamps.
- **Catch-up:** one current execution after downtime that records missed scheduled occurrences without claiming to recreate those historical recovery points.
- **Incident:** a persisted transition such as first failure, recovery, exhausted retries, missed start, stale protection or excessive running time.
- **Notification outbox:** durable notification intent and delivery evidence. Delivery is at least once; a crash after provider acceptance can produce a duplicate.
