import { PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED } from "./piBuiltinModels.generated";
import type { AgentStatus } from "./index";

type PresetProviderConnectionProviderId = keyof typeof PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED;
type GatewayProviderConnectionProviderId = "openai-compatible" | "anthropic-compatible";

export const PROVIDER_CONNECTION_PROVIDER_IDS = [
  ...(Object.keys(PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED) as PresetProviderConnectionProviderId[]),
  "openai-compatible",
  "anthropic-compatible",
] as const satisfies readonly (PresetProviderConnectionProviderId | GatewayProviderConnectionProviderId)[];

export type ProviderConnectionProviderId = typeof PROVIDER_CONNECTION_PROVIDER_IDS[number];
export type ProviderConnectionAuthMethod = "api_key" | "oauth";
export type ProviderConnectionStatus = "unchecked" | "ready" | "error" | "pending_auth" | "expired";

export interface ProviderConnectionProviderOption {
  id: ProviderConnectionProviderId;
  label: string;
  providerKind: "preset" | "gateway";
}

export interface ProviderConnectionCatalog {
  connections: ProviderConnectionSummary[];
  providerOptions: ProviderConnectionProviderOption[];
}

/** Latest durable Computer verification for one connection (catalog read model). */
export interface ProviderConnectionLatestVerified {
  computerId: string;
  computerName: string | null;
  runtime: string;
  model: string;
  verifiedAt: string;
}

export interface ProviderConnectionSummary {
  id: string;
  name: string;
  providerId: ProviderConnectionProviderId;
  authMethod: ProviderConnectionAuthMethod;
  endpointUrl: string | null;
  supportsImageInput: boolean;
  enabled: boolean;
  status: ProviderConnectionStatus;
  configVersion: number;
  credentialVersion: number;
  hasCredential: boolean;
  assignedAgentCount: number;
  latestVerified: ProviderConnectionLatestVerified | null;
  lastCheckedAt: string | null;
  lastErrorCategory: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Minimal identity of one Agent holding an assignment to a provider connection.
 * Deliberately credential-free and free of provider configuration: it answers
 * "which Agent blocks this connection?" and nothing else.
 */
export interface ProviderConnectionAssignedAgent {
  id: string;
  name: string;
  displayName: string | null;
  runtime: string;
  status: AgentStatus;
  /** Computer name the Agent is bound to, or null when it has none. */
  computerName: string | null;
  /** True when the Agent is soft-deleted but its assignment still exists. */
  deleted: boolean;
}

export interface ProviderConnectionAssignedAgentList {
  agents: ProviderConnectionAssignedAgent[];
}

/** Credential-free metadata materialized by the server for one exact launch. */
export interface ProviderConnectionLaunchProjection {
  providerId: ProviderConnectionProviderId;
  endpointUrl: string | null;
  supportsImageInput: boolean;
}

export function isProviderConnectionProviderId(value: unknown): value is ProviderConnectionProviderId {
  return typeof value === "string"
    && (PROVIDER_CONNECTION_PROVIDER_IDS as readonly string[]).includes(value);
}
