---
doc_id: app
title: Built-in Apps
description: Understand built-in reminders and memory cleanup hints, and configure Cleaner with raft app config.
---

{/*
Verified against:
- packages/cli/src/commands/app/config.ts (view, set, unset, and atomic updates)
- packages/server/src/apps/cleaner/definition.ts (built-in app registration and config fields)
- packages/shared/src/apps/cleaner/configProtocol.ts (canonical defaults, bounds, and disk threshold)
- packages/daemon/src/apps/cleaner/runtime.ts (memory and disk checks, memory hint with daily rewake cooldown, disk is trace-only)
- packages/daemon/src/apps/cleaner/definition.ts (memory threshold action and disk cleanup guidance action)
- manual/agent-knowledge/inbox.md (linked inbox guide)
@ verified 2026-10-01 against repository sources; no live runner verification in this update
*/}

## Built-in apps

Built-in apps deliver reminders and cleanup hints to your agent's [inbox](/agent-knowledge/inbox).
Use `raft inbox check` to read them.

- **`system.reminder`** delivers due reminders.
- **`system.cleaner`** reminds you to tidy up when `MEMORY.md` exceeds its size threshold. It
  also checks whether the disk holding agent data has less than 10% (and under 20 GiB) available space, but low disk
  space is a machine-wide condition, so it is not sent to agents.

## Respond to a memory hint

`MEMORY.md` is loaded into context each session. Keep it concise:

- Remove outdated information, such as superseded decisions, completed task status, and obsolete
  environment details. Check against current sources; old information may still be valid.
- Keep an index in memory and move supporting details or history into notes.

At most once a week the hint also suggests deleting workspace files you know are unused, such as
stale worktrees, old build outputs, or temporary downloads. Cleaner does not scan your workspace;
delete only what you are sure you no longer need, or nothing.

Cleaner provides a reminder; you decide what to keep and what to remove. After `MEMORY.md` falls
within the size threshold, the hint clears on the next check.

The hint is advisory. It wakes a running agent at most once a day while `MEMORY.md` stays over the
threshold, or sooner if the file grows by a quarter or more since the last hint. It never starts a
stopped agent; the hint waits in the inbox until the agent wakes for another reason.

The hint's suggested command raises the size threshold, usually by doubling it. Use that when the
larger memory file is intentional; otherwise, trim the file first.

## Configure Cleaner

Run these commands in the agent's environment. Settings apply to that agent. `enabled` and
`interval_seconds` control both checks; `threshold_bytes` controls only the memory check.
The disk threshold is fixed: less than 10% and less than 20 GiB available.

View the current settings:

```sh
raft app config --app system.cleaner
```

| Setting | Default | Allowed values |
| --- | --- | --- |
| `enabled` | `true` | `true` or `false` |
| `threshold_bytes` | `65536` (64 KiB) | `4096`–`1073741824` bytes |
| `interval_seconds` | `3600` (1 hour) | `900`–`604800` seconds |

For example, set the size threshold to 128 KiB:

```sh
raft app config --app system.cleaner --set threshold_bytes=131072
```

Restore the default threshold:

```sh
raft app config --app system.cleaner --unset threshold_bytes
```

Turn Cleaner off or back on:

```sh
raft app config --app system.cleaner --set enabled=false
raft app config --app system.cleaner --set enabled=true
```

`--set` and `--unset` can each be repeated to change several settings in one command. The output
shows current values and whether each is a default or an override. `Revision` counts configuration
changes.

`system.reminder` has no configurable settings. See the [inbox guide](/agent-knowledge/inbox) for
handling its reminders.
