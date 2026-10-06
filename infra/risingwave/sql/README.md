# RisingWave SQL

These definitions and validation queries support the Inbox materialized views.
They are executable infrastructure inputs, not PostgreSQL/Drizzle migrations.
The numeric prefixes retain links to the design history in `rfcs/`.

The local bootstrap in `packages/server/scripts/bootstrap-risingwave-local.ts`
(raftdev `--risingwave` and the `risingwave-real` CI job) selects, statement by
statement, exactly the relations the server reads and their dependencies from
024 (CDC-table indexes only), 061, 063-unified-inbox-chain, 063-chain-v5,
066, 067, 068, 071 (indexes only), and 074, in that order (069's
`rw_followed_thread_stats_v2`, 070's `rw_followed_thread_stats_v3` and 072's
`rw_followed_threads_v4` are superseded by 074's `rw_followed_threads_v5`, which
also covers joint threads, and are not applied; 074 also reads the `rw_tasks`
CDC table). The selection lives in `RISINGWAVE_BOOTSTRAP_ARTIFACTS`
(`scripts/dev/raftdev-risingwave-bootstrap.ts`), which is also the list of
applied relations. When a new generation replaces a
view the server reads, add it there, or the `risingwave-real` job fails. That
script is the consumer to check when
changing file locations.

Do not run every file alphabetically: some are superseded generations kept
because tests still read them. For local setup use `./raftdev --risingwave`,
which applies exactly the `RISINGWAVE_BOOTSTRAP_ARTIFACTS` list above, in
order.

The views read Postgres through CDC source tables (`rw_messages`, `rw_channels`
and the others named in each file's prerequisites). The local bootstrap creates
them for a loopback Postgres and RisingWave. For any other cluster, create the
CDC source and its tables first, then apply the same files in the same order.
