// Passive AX resource registry (RFC 072).
//
// A passive resource is something an agent could look at with an active
// command, and whose staleness the CLI can notice for it: the agent's local
// ledger records the version (`rev`) it last actually saw, and each command
// that touches the resource compares that against the current version. The
// registry is the only place a new resource type is declared; the CLI's
// engine dispatches on these fields and never on the type name.
//
// Admission rule: a thing is a resource only if a bounded, agent-specific
// version can be given for it. An unbounded, query-driven listing (for
// example the integration marketplace) is not one.
//
// "Seen" is bounded twice (RFC 072 §7), and both bounds are part of the
// contract:
// - it lasts one model context. The daemon issues a new opaque contextId at
//   every runtime spawn and every compaction start; anything recorded under
//   another contextId counts as not seen;
// - it means the CLI delivered the content into the context (stdout flushed),
//   NOT that the model read or learned it: runtimes truncate long tool output.
//   A hold guarantees the content landed in context before the action ran,
//   nothing more; it is not proof the agent has learned a rule.
//
// Policy, by the consequence of missing a change:
// - hold: the action waits until the current version has been delivered.
// A lighter tier (one hint line naming the active command when the version
// moved) lands with its first user, the channel description type.

import { formatHint, RAFT_HINTS } from "./hint";

export type PassiveResourcePolicy = "hold";

export interface PassiveResourceSpec {
  /** Where the current version comes from. */
  revSource: "server-seq" | "content-hash";
  /** Consequence tier of acting without having seen the current version. */
  policy: PassiveResourcePolicy;
  /** The active command that shows the resource; printed verbatim where it is pointed to. */
  activeCommand: (id: string) => string;
  /** What touches the resource. */
  touchedBy: readonly string[];
}

export const PASSIVE_RESOURCES = {
  // A conversation's messages. Version: the highest message seq the agent
  // has read in full. Enforced by the send freshness hold (server decides).
  thread: {
    revSource: "server-seq",
    policy: "hold",
    activeCommand: (id) => formatHint(RAFT_HINTS.messageRead({ target: id })),
    touchedBy: ["message send"],
  },
  // A consequential command's usage guidance (RFC 072 §7). Version: hash of
  // the text. The first run in a context delivers it instead of executing;
  // `--help` always prints it in full and also counts as delivery.
  "command.guidance": {
    revSource: "content-hash",
    policy: "hold",
    activeCommand: (id) => `raft ${id} --help`,
    touchedBy: ["the command itself", "--help"],
  },
} as const satisfies Record<string, PassiveResourceSpec>;

export type PassiveResourceType = keyof typeof PASSIVE_RESOURCES;
