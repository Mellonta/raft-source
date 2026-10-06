import { axSurface } from "../../core/renderer";
import {
  AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
  type AgentLoginIntegrationInventoryProjection,
} from "@botiverse/raft-shared";

export interface RegisteredIntegrationService {
  id: string;
  clientId: string;
  appType?: "server_local" | "slock_builtin" | "third_party_global";
  name: string;
  description: string | null;
  homepageUrl: string | null;
  returnUrl: string | null;
  agentManifestUrl: string | null;
  agentManifestUrlSource?: "explicit" | "well_known" | null;
  allowedScopes?: string[];
  createdAt: string;
  updatedAt: string;
  /** Set by the platform's official-app judgment (contract rev3.1), never by the app. Absent/false = ordinary service. */
  official?: boolean;
  /** One-line purpose the platform records for an official app; empty for ordinary services. */
  purpose?: string;
}

export interface ActiveAgentLogin {
  id: string;
  serviceId: string;
  clientId: string;
  appType?: "server_local" | "slock_builtin" | "third_party_global";
  name: string;
  description: string | null;
  homepageUrl: string | null;
  returnUrl: string | null;
  agentManifestUrl: string | null;
  agentManifestUrlSource?: "explicit" | "well_known" | null;
  scopes: string[];
  createdAt: string;
}

export interface IntegrationListResponse {
  services: RegisteredIntegrationService[];
  activeLogins: ActiveAgentLogin[];
}

export function projectCurrentIntegrationList(data: IntegrationListResponse): IntegrationListResponse {
  const services = data.services.filter((service) => service.appType !== "slock_builtin");
  const serviceIds = new Set(services.map((service) => service.id));
  return {
    services,
    activeLogins: data.activeLogins.filter((login) => (
      login.appType !== "slock_builtin" && serviceIds.has(login.serviceId)
    )),
  };
}

export interface IntegrationLoginResponse {
  status: "logged_in" | "already_logged_in" | "approval_required" | "install_required";
  nextAction?: "install_from_marketplace";
  service: RegisteredIntegrationService;
  scopes: string[];
  requestId?: string;
  session?: {
    status: "stored";
    authentication?: "unverified";
    source: "cache" | "fresh";
    path: string | null;
  };
  approval?: {
    requestId: string;
    target: string | null;
    actionCardMessageId: string | null;
  };
  installation?: {
    serverSlug: string;
    serverName: string;
    marketplaceUrl: string;
    target: string | null;
    actionCardMessageId: string | null;
  };
}

// The platform response describes the Raft grant. The CLI cannot infer an
// authenticated application session from arbitrary Set-Cookie headers.
export type IntegrationLoginOutput = Omit<IntegrationLoginResponse, "status"> & {
  status: IntegrationLoginResponse["status"] | "grant_active";
};

function formatMaybe(value: string | null | undefined): string {
  return value?.trim() || "-";
}

export function buildAgentCallbackHandoffUrl(returnUrl: string | null | undefined, requestId: string): string | null {
  if (!returnUrl?.trim()) return null;
  try {
    const url = new URL(returnUrl);
    url.searchParams.set("code", requestId);
    return url.toString();
  } catch {
    return null;
  }
}

function pushServiceBlock(
  lines: string[],
  service: RegisteredIntegrationService,
  active: ActiveAgentLogin | undefined,
): void {
  lines.push(`- ${service.name}`);
  lines.push(`  service: ${service.clientId}`);
  lines.push(`  id: ${service.id}`);
  lines.push(`  session: ${active ? "active login" : "not logged in"}`);
  lines.push(`  return URL: ${formatMaybe(service.returnUrl)}`);
  if (service.agentManifestUrl) {
    lines.push(`  agent behavior manifest: ${service.agentManifestUrl}`);
    lines.push(`  local CLI env: raft integration env --service ${JSON.stringify(service.clientId)}`);
    lines.push(`  for login_with_raft HTTP API action manifests: raft integration invoke --service ${JSON.stringify(service.clientId)} --list-actions`);
  }
  if (service.homepageUrl) lines.push(`  homepage: ${service.homepageUrl}`);
  if (service.description) lines.push(`  description: ${service.description}`);
  // Contract rev3.1 §4b: the `official` mark is platform-set, never app-supplied, and
  // the list shows installed services only. Ordinary services print neither line.
  if (service.official === true) lines.push("  official: yes (set by the platform, never by the app)");
  if (service.official === true && service.purpose && service.purpose.trim()) lines.push(`  purpose: ${service.purpose.trim()}`);
  if (!active) lines.push(`  next: raft integration login --service ${JSON.stringify(service.clientId)}`);
}

export const formatIntegrationList = axSurface(
  "Agent Login inventory with scope preamble (shared projection with the system prompt).",
  (
  data: IntegrationListResponse,
  inventoryProjection: AgentLoginIntegrationInventoryProjection =
    AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
): string => {
  const inventoryCopy = inventoryProjection.copy;
  // Older Servers may still return historical tombstone rows. Never project
  // them as an available service or active Agent Login.
  const { services: visibleServices, activeLogins: visibleActiveLogins } = projectCurrentIntegrationList(data);
  const activeByServiceId = new Map(visibleActiveLogins.map((login) => [login.serviceId, login]));
  const lines: string[] = [
    inventoryCopy.heading,
    inventoryCopy.scope,
    inventoryCopy.exclusion,
    inventoryCopy.boundary,
    inventoryCopy.reference,
    "",
  ];

  lines.push("Registered services:");
  if (visibleServices.length === 0) {
    lines.push("- none");
  } else {
    for (const service of visibleServices) {
      pushServiceBlock(lines, service, activeByServiceId.get(service.id));
    }
  }

  lines.push("");
  lines.push("Active agent logins:");
  if (visibleActiveLogins.length === 0) {
    lines.push("- none");
  } else {
    for (const login of visibleActiveLogins) {
      lines.push(`- ${login.name}`);
      lines.push(`  service: ${login.clientId}`);
      lines.push(`  grant id: ${login.id}`);
      lines.push("  session: active login");
      lines.push(`  scopes: ${login.scopes.length > 0 ? login.scopes.join(", ") : "-"}`);
      lines.push(`  return URL: ${formatMaybe(login.returnUrl)}`);
      if (login.agentManifestUrl) {
        lines.push(`  agent behavior manifest: ${login.agentManifestUrl}`);
        lines.push(`  local CLI env: raft integration env --service ${JSON.stringify(login.clientId)}`);
        lines.push(`  for login_with_raft HTTP API action manifests: raft integration invoke --service ${JSON.stringify(login.clientId)} --list-actions`);
      }
      lines.push(`  created: ${login.createdAt}`);
    }
  }

  return (lines.join("\n"));
},
  {
    examples: [{ args: [{ services: [{ id: "svc-2", clientId: "lens", name: "lens", appType: "third_party_global", description: "trajectory viewer", returnUrl: "https://lens.example/callback", homepageUrl: "https://lens.example", agentManifestUrl: null }], activeLogins: [{ id: "grant-00000001", serviceId: "svc-2", clientId: "lens", name: "lens", description: "trajectory viewer", homepageUrl: "https://lens.example", returnUrl: "https://lens.example/callback", agentManifestUrl: null, scopes: ["identity", "openid"], createdAt: "2026-08-31T08:00:00.000Z" }] } as never] }],
  },
);

export const formatIntegrationLogin = axSurface(
  "Login outcome incl. approval/installation requirement shapes.",
  (data: IntegrationLoginOutput): string => {
  if (data.status === "install_required") {
    const lines = [
      `Marketplace install required: ${data.service.name}`,
      `service: ${data.service.clientId}`,
      `id: ${data.service.id}`,
      `server: ${data.installation?.serverName ?? "-"}`,
      `scopes: ${data.scopes.length > 0 ? data.scopes.join(", ") : "-"}`,
      `next action: ${data.nextAction ?? "install_from_marketplace"}`,
      `marketplace: ${data.installation?.marketplaceUrl ?? "-"}`,
    ];
    if (data.installation?.actionCardMessageId) {
      lines.push(`install card: ${data.installation.actionCardMessageId}`);
      lines.push(`target: ${data.installation.target ?? "-"}`);
      lines.push("next: ask a server owner/admin to install the app with this card, then rerun this command");
    } else {
      lines.push("install card: not posted");
      lines.push("next: ask a server owner/admin to install this public Marketplace app on the named Server, or rerun with --target <channel-or-thread> to post an install card");
    }
    lines.push("note: the app exists; it is not installed on this Server yet. This command did not install it.");
    return (lines.join("\n"));
  }
  if (data.status === "approval_required") {
    const lines = [
      `Human approval required: ${data.service.name}`,
      `service: ${data.service.clientId}`,
      `id: ${data.service.id}`,
      `scopes: ${data.scopes.length > 0 ? data.scopes.join(", ") : "-"}`,
      `request id: ${data.approval?.requestId ?? data.requestId}`,
    ];
    if (data.approval?.actionCardMessageId) {
      lines.push(`approval card: ${data.approval.actionCardMessageId}`);
      lines.push(`target: ${data.approval.target ?? "-"}`);
      lines.push("next: ask a server owner/admin to approve the card, then rerun this command");
    } else {
      lines.push("approval card: not posted");
      lines.push("next: rerun with --target <channel-or-thread> to post a human approval card, or ask a server owner/admin to approve this request");
    }
    return (lines.join("\n"));
  }

  const verb = "Raft grant active";
  const lines = [
    `${verb}: ${data.service.name}`,
    `service: ${data.service.clientId}`,
    `id: ${data.service.id}`,
    `scopes: ${data.scopes.length > 0 ? data.scopes.join(", ") : "-"}`,
    `return URL: ${formatMaybe(data.service.returnUrl)}`,
  ];
  if (data.service.agentManifestUrl) {
    lines.push(`agent behavior manifest: ${data.service.agentManifestUrl}`);
    lines.push(`local CLI env: raft integration env --service ${JSON.stringify(data.service.clientId)}`);
    lines.push(`for login_with_raft HTTP API action manifests: raft integration invoke --service ${JSON.stringify(data.service.clientId)} --list-actions`);
  }
  lines.push("grant: this agent is authorized in Raft; application authentication has not been verified");
  lines.push("identity: run `raft profile show` if the service or human asks for your Raft Agent identity card");
  if (data.session) {
    lines.push("session: callback cookies stored for this agent; application authentication unverified");
    if (data.session.path) lines.push(`session store: ${data.session.path}`);
    lines.push(`next: use \`raft integration invoke --service ${JSON.stringify(data.service.clientId)} --list-actions\` only for login_with_raft HTTP API action manifests; for session-cookie services, verify authentication with a documented read-only service check before use`);
  } else {
    lines.push("session: no service callback session was established; Raft grant is active");
    lines.push("next: follow the service documentation to establish and verify application authentication");
  }
  return (lines.join("\n"));
},
  {
    examples: [{ args: [{ status: "logged_in", service: { id: "svc-2", clientId: "lens", name: "lens", appType: "third_party_global", description: "trajectory viewer", returnUrl: "https://lens.example/callback", homepageUrl: null, agentManifestUrl: null }, scopes: ["identity"], session: { status: "stored", source: "fresh", path: null } } as never] }],
  },
);

// --- v1 invoke error/receipt surfaces (moved from invokeV1.ts, error-face AX coverage) ---
import type { IntegrationActionReceiptV1, IntegrationErrorV1 } from "./invokeV1";

export const formatIntegrationReceiptV1 = axSurface(
  "v1 action receipt block: operation/authority/transport/schema/readback/rollback statuses and next action.",
  (input: {
    receipt: IntegrationActionReceiptV1;
    value?: unknown;
  }): string => {
  const lines = [
    `Action receipt: ${input.receipt.operation.status}`,
    `service: ${input.receipt.target.service_id}`,
    `action: ${input.receipt.action.name}`,
    `effect: ${input.receipt.action.effect}`,
    `receipt id: ${input.receipt.receipt_id}`,
    `invocation id: ${input.receipt.invocation.id}`,
    `attempt: ${input.receipt.invocation.attempt}`,
    `authority: ${input.receipt.authority.status}`,
    `transport: ${input.receipt.transport.status}`,
    `HTTP status: ${input.receipt.transport.http_status ?? "-"}`,
    `response schema: ${input.receipt.response_schema.status}`,
    `readback: ${input.receipt.readback.status}`,
    `rollback: ${input.receipt.rollback.mode}/${input.receipt.rollback.status}`,
    `retryable: ${input.receipt.retryable ? "yes" : "no"}`,
    `next: ${input.receipt.next_action}`,
  ];
  if (input.value !== undefined) {
    lines.push("result:");
    lines.push(JSON.stringify(input.value, null, 2));
  }
  return lines.join("\n");
},
  {
    examples: [{
      args: [{
        receipt: {
          receipt_id: "rcpt-00000001",
          target: { service_id: "lens" },
          action: { name: "list_trajectories", effect: "read" },
          operation: { status: "succeeded" },
          invocation: { id: "inv-00000001", attempt: 1 },
          authority: { status: "granted" },
          transport: { status: "ok", http_status: 200 },
          response_schema: { status: "valid" },
          readback: { status: "confirmed" },
          rollback: { mode: "none", status: "not_needed" },
          retryable: false,
          next_action: "none",
        } as never,
        value: { count: 2 },
      }],
    }],
  },
);

export const formatIntegrationErrorV1 = axSurface(
  "v1 invoke typed error text: labelled evidence block (manifest/auth/authority/transport/schema/readback) plus optional appended receipt.",
  (error: IntegrationErrorV1, receipt?: IntegrationActionReceiptV1): string => {
    const base = (() => {
  return [
    `Error: ${error.message}`,
    `Code: ${error.code}`,
    `Service: ${error.service_id}`,
    `Action: ${error.action ?? "-"}`,
    `Effect: ${error.effect ?? "-"}`,
    `Fault domain: ${error.fault_domain}`,
    `Retryable: ${error.retryable ? "yes" : "no"}`,
    `Manifest: ${error.evidence.manifest}`,
    `Auth: ${error.evidence.auth}`,
    `Authority: ${error.evidence.authority}`,
    `Transport: ${error.evidence.transport}`,
    `Response schema: ${error.evidence.response_schema}`,
    `Readback: ${error.evidence.readback}`,
    `Schema path: ${error.schema_path ?? "-"}`,
    `HTTP status: ${error.http_status ?? "-"}`,
    `Request id: ${error.request_id ?? "-"}`,
    `Next action: ${error.next_action}`,
  ].join("\n");
})();
    return base + (receipt ? `\nReceipt:\n${formatIntegrationReceiptV1({ receipt })}` : "");
  },
  {
    examples: [{
      args: [{
        message: "Upstream schema mismatch",
        code: "INVOKE_SCHEMA_INVALID",
        service_id: "lens",
        action: "list_trajectories",
        effect: "read",
        fault_domain: "service",
        retryable: false,
        evidence: { manifest: "ok", auth: "ok", authority: "ok", transport: "ok", response_schema: "failed", readback: "not_reached" },
        schema_path: "$.items[0].id",
        http_status: 200,
        request_id: "req-00000001",
        next_action: "Report the schema mismatch to the service owner.",
      } as never],
    }],
  },
);

export const formatIntegrationTokenReceiverOutput = axSurface(
  "JWT-redacted output forwarded from the caller-selected receiving process.",
  (redactedOutput: string) => redactedOutput,
  { examples: [{ args: ["receiver result: <redacted>"] }] },
);

export const formatIntegrationTokenReceipt = axSurface(
  "Audience JWT private process delivery receipt; does not assert service authentication.",
  (result: { audience: string; expiresAt: string }) =>
    `Agent JWT delivered for ${result.audience}; expires ${result.expiresAt}. Service authentication is determined by the receiver.`,
  { examples: [{ args: [{ audience: "example-service", expiresAt: "2026-10-05T00:05:00Z" }] }] },
);
