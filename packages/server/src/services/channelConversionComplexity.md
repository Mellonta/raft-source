# Channel to Joint conversion

The conversion job owns one epoch and a durable source fence. Ordinary and
private channels, including archived channels, can convert. The source URL,
message IDs and sequence numbers, Task identity/history, attachment objects and
billing provenance survive. Archive state is independent of the fence.

## Commit and recovery boundaries

Before audience cutover, cancellation or a phase failure compensates committed
canonical writes, restores the source rows and external bindings, releases the
fence, and unfreezes pending Action Cards. External binding admission is
validated before command admission and again under the source lock; binding
pause commits with the first canonical write. A restored failure retries with
a new epoch and freshly copied source rows, including writes made after the
failure. Cancel is idempotent and a new Convert after Cancel creates a new job.
Routing columns in the job are not cleanup authority: the creating server and
conversion-owned storage namespace identify the projection being removed.
Legacy jobs already committed beyond cutover still resume forward; new jobs
cannot persist this intermediate state.

Resource families move in batches of at most 128 rows. Each batch commits its
source cursor, count and checksum with the row changes. Namespace fields change;
the batch compares all other persisted fields before and after moving them.
Thread projection creation preserves the original local Thread ID. Reads expand
only a conversion's source/canonical pair and host Thread mappings, using the
same SQL snapshot as the read. Callers still authorize the local channel surface.

The worker reconstructs pending/running work from persisted jobs after a process
restart. Each pass processes at most eight jobs and one batch per job. Per-source
transaction locks serialize competing workers. Failed jobs are not automatically
retried. Completion notification is retried until its receipt is persisted.

Audience cutover, residual cleanup and finalization share one transaction.
A failure anywhere in that commit rolls back all access and personal-state
changes before compensating the earlier copy. Only explicit channel members
retain access; public server membership is not copied into the Joint ACL.
Cleanup removes lost principals' serving state in bounded statements.
Finalization releases the fence, while pending Action Cards require renewed
confirmation. A Cancel racing with this transaction either restores the source
first or observes Done; it cannot interleave with destructive cleanup. Settings continues showing progress
until the job succeeds; invitations become available after dismissing completion.

## Regression guards

`channelConversionService.test.ts` exercises compensating cancellation/failure
at every committed copy boundary and rejects cancellation after Done, archive
preservation, Task writer rejection, partial message/context/Task/board reads,
batch interruption, full row restoration, actual API reads and successful sends with persisted-message checks,
new-epoch retry with competing workers, worker replacement, resource
identity, audience cleanup and pending-card behavior. `channelConversionLockArrival.realPg.test.ts`
checks the actual PostgreSQL lock order; `channelConversionRollbackLockOrder.realPg.test.ts`
pins rollback locking every row it deletes or re-keys up front, in read-state
resolution order, so it cannot deadlock with read-all.

A same-head review must also exercise a fresh disposable full-flow fixture:
failure/reopen/cancel, cancel an unfinished upload/retry, then conversion,
invitation and acceptance from both server views. Passing a migration or the
backend suite alone does not establish that browser contract.
