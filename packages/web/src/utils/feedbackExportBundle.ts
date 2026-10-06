import type { Agent } from "../store/agentStore";
import type { Machine } from "../store/machineStore";

export interface FeedbackExportBundleV2 {
  schemaVersion: "slock-feedback-export-v2";
  generatedAt: string;
  appVersion: string | null;
  daemonVersion: string | null;
  issue: {
    description: string | null;
  };
  reporter: {
    id: string | null;
    email: string | null;
    name: string | null;
    displayName: string | null;
  };
  server: {
    id: string | null;
    slug: string | null;
    name: string | null;
  };
  agent: {
    id: string;
    name: string;
    displayName: string | null;
    description: string | null;
    status: Agent["status"];
    runtime: string;
    model: string;
    reasoningEffort: Agent["reasoningEffort"];
    machineId: string | null;
    machineName: string | null;
    machineStatus: string | null;
    // Facts reported by the machine RUNNING the agent (not the reporter's
    // browser/desktop; that is `browser`), as last seen by this client.
    // null = unknown: no machine, not loaded, or never reported. Never
    // substituted from the client platform.
    machineOs: string | null;
    machineComputerVersion: string | null;
    // Last time the server heard from the machine (ISO); the freshness
    // reference for the machine facts above. null = unknown/never.
    machineLastHeartbeat: string | null;
  };
  logs: {
    recentMessages: {
      included: boolean;
      source: "server_dm_history";
      durability: "durable";
      entries: unknown[] | null;
    };
    ephemeralActivityBuffer: {
      included: boolean;
      source: "client_socket_buffer";
      durability: "ephemeral";
      entries: unknown[] | null;
    };
    durableTrajectoryLog: {
      included: boolean;
      source: "server_activity_log";
      durability: "durable";
      entries: unknown[] | null;
    };
  };
  /**
   * Deprecated v1 aliases kept for external/debug tooling compatibility.
   * Prefer `logs.ephemeralActivityBuffer` and `logs.durableTrajectoryLog`.
   */
  activityLog: unknown[] | null;
  trajectoryLog: unknown[] | null;
  browser: {
    url: string;
    userAgent: string;
    language: string;
    languages: readonly string[];
    platform: string;
    timezone: string;
    viewport: { width: number; height: number };
    screen: { width: number; height: number };
  };
}

export type AgentMachineSnapshot = Pick<
  FeedbackExportBundleV2["agent"],
  "machineName" | "machineStatus" | "machineOs" | "machineComputerVersion" | "machineLastHeartbeat"
> & {
  daemonVersion: FeedbackExportBundleV2["daemonVersion"];
};

function reportedOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// Snapshot of the agent's machine for the report. `machine` must be the row
// for the agent's own machineId (or null/undefined when unassigned or not
// loaded); every missing fact stays null.
export function snapshotAgentMachine(
  machine: Pick<Machine, "name" | "status" | "os" | "computerVersion" | "daemonVersion" | "lastHeartbeat"> | null | undefined,
): AgentMachineSnapshot {
  return {
    machineName: machine?.name ?? null,
    machineStatus: machine?.status ?? null,
    machineOs: reportedOrNull(machine?.os),
    machineComputerVersion: reportedOrNull(machine?.computerVersion),
    machineLastHeartbeat: reportedOrNull(machine?.lastHeartbeat),
    daemonVersion: machine?.daemonVersion ?? null,
  };
}

interface BuildFeedbackExportBundleOptions {
  generatedAt?: string;
  appVersion: string | null;
  daemonVersion: string | null;
  description: string;
  reporter: FeedbackExportBundleV2["reporter"];
  server: FeedbackExportBundleV2["server"];
  agent: FeedbackExportBundleV2["agent"];
  recentMessages: unknown[] | null;
  ephemeralActivityBuffer: unknown[] | null;
  durableTrajectoryLog: unknown[] | null;
  includeRecentMessages?: boolean;
  includeEphemeralActivityBuffer?: boolean;
  includeDurableTrajectoryLog?: boolean;
  browser: FeedbackExportBundleV2["browser"];
}

export function buildFeedbackExportBundle({
  generatedAt = new Date().toISOString(),
  appVersion,
  daemonVersion,
  description,
  reporter,
  server,
  agent,
  recentMessages,
  ephemeralActivityBuffer,
  durableTrajectoryLog,
  includeRecentMessages,
  includeEphemeralActivityBuffer,
  includeDurableTrajectoryLog,
  browser,
}: BuildFeedbackExportBundleOptions): FeedbackExportBundleV2 {
  return {
    schemaVersion: "slock-feedback-export-v2",
    generatedAt,
    appVersion,
    daemonVersion,
    issue: {
      description: description.trim() || null,
    },
    reporter,
    server,
    agent,
    logs: {
      recentMessages: {
        included: includeRecentMessages ?? recentMessages !== null,
        source: "server_dm_history",
        durability: "durable",
        entries: recentMessages,
      },
      ephemeralActivityBuffer: {
        included: includeEphemeralActivityBuffer ?? ephemeralActivityBuffer !== null,
        source: "client_socket_buffer",
        durability: "ephemeral",
        entries: ephemeralActivityBuffer,
      },
      durableTrajectoryLog: {
        included: includeDurableTrajectoryLog ?? durableTrajectoryLog !== null,
        source: "server_activity_log",
        durability: "durable",
        entries: durableTrajectoryLog,
      },
    },
    activityLog: ephemeralActivityBuffer,
    trajectoryLog: durableTrajectoryLog,
    browser,
  };
}
