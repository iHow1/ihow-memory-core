# Workspace and activation-ledger lock recovery

This document describes the 0.1.1 lock protocol. Package publication does not upgrade an installed or running client.

## Owner publication and exclusion

The public lock remains a regular file containing a PID and an ISO timestamp. The writer first opens
a unique sibling owner file exclusively, writes the complete record, and closes it. It then publishes
the lock with a same-directory hard link that cannot replace an existing pathname. A write failure
cleans up the private file and descriptor without exposing a public lock. A process crash before
publication can leave an unreferenced `.owner-*` sibling, but it does not block writers.

The public owner PID is authoritative for liveness. A live PID, including the current process, is
never evicted just because a timestamp is old. Permission-denied or unknown liveness also preserves
the lock. A definitely dead PID permits immediate recovery. PID reuse can conservatively retain a
lock; this implementation does not authenticate process birth times.

For a legacy empty or malformed owner record without a valid PID, filesystem mtime provides the age:
the workspace grace interval is 60 seconds and the activation-ledger interval is 5 seconds. Fresh or
future-dated records remain protected so an older writer can finish initialization. The grace interval
is an orphan heuristic for records lacking an owner, not proof that no paused legacy writer exists.
New publishers avoid that initialization window by publishing only complete records.

Symlinks, non-regular files, oversized owner records and records that change while inspected are not
treated as permission to delete a lock. Filesystem errors propagate; unsupported hard links have no
unsafe fallback. The filesystem must provide atomic exclusive hard-link creation and coherent local
metadata. Validation is on the local macOS filesystem; network filesystems are not certified.

## Stale recovery

Recovery acquires a separate `<lock>.reclaim` guard, also published with a complete owner record. It
then reads the public lock again and checks device, inode, size, mtime, ctime, content and staleness.
An observer that waited while another process replaced the lock must retry; it cannot remove the
replacement using its earlier stale decision. The guard serializes cooperating reapers. Release also
checks inode ownership and reports an ownership loss instead of deleting a replacement file.

All new reapers use this protocol. Older clients still understand the ordinary PID lock format but
do not honor the recovery guard. Stop or restart old writers when rolling out the new generation;
mixed old/new stale-recovery races are outside the new protocol's exclusion guarantee.

The recovery guard is not recursively reclaimed. If its owner is dead, or its malformed record is
aged, callers report `workspace_lock_recovery_interrupted` or
`activation_ledger_lock_recovery_interrupted`. This deliberately stops ambiguous recovery instead of
creating a second stale-reaper race. A crash in that short critical section can therefore require an
operator; this change does not claim fully automatic recovery from every crash location.

For operator recovery, stop cooperating writers, inspect both files and owner PIDs, verify absence of
open handles where supported, and verify inode/content/mtime again immediately before preserving the
orphan under a unique quarantine name. Do not blindly delete locks by age. Resume writers and verify
an actual write/read round-trip. Quarantined files are evidence, not files to restore over a live lock.

## Budget and scope

Workspace calls retain their per-path same-process queue and 5-second file-contention timeout.
Activation-ledger calls use the shared path-level primitive without that queue, retaining their
5-millisecond retry and 40-millisecond contention budget. The host's existing fail-open wrapper still
handles ledger failure. This does not change memory contents, FTS projection, recall eligibility,
activation trust, routing, telemetry consent or model calls.

The telemetry transport has a separate lock and is outside this patch.

## Verification

`tests/lock-recovery.test.mjs` covers aged empty/malformed locks, initialization and publication
failures, fresh legacy initialization, live/unknown owner protection, a paused stale observer facing a
replacement lock, interrupted recovery guards, killed writers, and six-process read-modify-write
contention. `tests/lock-concurrency.test.mjs` retains the existing cross-process, queue and isolation
checks. Activation-ledger tests cover old empty-lock recovery without losing prior evidence and
bounded host-hook contention. Storage, governance, journal, FTS and checkpoint checks must accompany
the candidate; the integrated release still requires its separately frozen full gate.
