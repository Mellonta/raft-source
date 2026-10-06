/**
 * task #1120 — typed agent launch failures.
 *
 * Every failure the daemon can name carries a stable machine-readable code
 * (`code` on new error classes; `spawnFailureCode` on classes whose `code`
 * already means something else). `classifySpawnFailure` decides by code only.
 * Messages are for humans and logs; nothing dispatches on their text.
 */

// task #1123: the reason enum is the wire contract now, so it lives in shared;
// re-exported here so daemon call sites keep their import path.
import { SPAWN_FAILURE_REASONS as SHARED_SPAWN_FAILURE_REASONS, type SpawnFailureReason } from "@botiverse/raft-shared";
export type { SpawnFailureReason } from "@botiverse/raft-shared";

const SPAWN_FAILURE_REASONS: ReadonlySet<string> = new Set<string>(SHARED_SPAWN_FAILURE_REASONS);

/**
 * The stable code of a launch failure, or null when the error is not one the
 * daemon classifies. Node's own `ENOENT` (spawn of a missing executable) is the
 * one foreign code accepted, as `runtime_not_found`.
 */
export function spawnFailureCodeOf(error: unknown): SpawnFailureReason | null {
  if (!(error instanceof Error)) return null;
  const typed = error as { code?: unknown; spawnFailureCode?: unknown };
  if (typeof typed.spawnFailureCode === "string" && SPAWN_FAILURE_REASONS.has(typed.spawnFailureCode)) {
    return typed.spawnFailureCode as SpawnFailureReason;
  }
  if (typeof typed.code === "string") {
    if (SPAWN_FAILURE_REASONS.has(typed.code)) return typed.code as SpawnFailureReason;
    if (typed.code === "ENOENT") return "runtime_not_found";
  }
  return null;
}

/** The configured model is not available to this runtime on this computer. */
export class RuntimeModelNotFoundError extends Error {
  readonly code = "model_not_found" as const;
  readonly runtimeId: string;
  readonly model: string;

  constructor(input: { runtimeId: string; model: string }) {
    super(`Model ${input.model} is not available for the ${input.runtimeId} runtime on this computer`);
    this.name = "RuntimeModelNotFoundError";
    this.runtimeId = input.runtimeId;
    this.model = input.model;
  }
}

/**
 * The selected model has no entry in the runtime's configuration on this
 * computer (Kimi: config.toml [models."X"]). Distinct from model_not_found so
 * only this runtime-confirmed case stops automatic relaunches (task #1221).
 */
export class RuntimeModelNotConfiguredError extends Error {
  readonly code = "model_not_configured" as const;
  readonly runtimeId: string;
  readonly model: string;

  constructor(input: { runtimeId: string; model: string }) {
    super(`Model ${input.model} is not configured for the ${input.runtimeId} runtime on this computer`);
    this.name = "RuntimeModelNotConfiguredError";
    this.runtimeId = input.runtimeId;
    this.model = input.model;
  }
}

/** The runtime needs a human login on this computer before it can start. */
export class RuntimeLoginRequiredError extends Error {
  readonly code = "runtime_login_required" as const;
  readonly runtimeId: string;

  constructor(input: { runtimeId: string; message: string }) {
    super(input.message);
    this.name = "RuntimeLoginRequiredError";
    this.runtimeId = input.runtimeId;
  }
}

/** The runtime rejected its configuration on this computer (not the model name). */
export class RuntimeConfigInvalidError extends Error {
  readonly code = "runtime_config_invalid" as const;
  readonly runtimeId: string;

  constructor(input: { runtimeId: string; message: string }) {
    super(input.message);
    this.name = "RuntimeConfigInvalidError";
    this.runtimeId = input.runtimeId;
  }
}

/** The runtime's executable / entry point could not be resolved on this computer. */
export class RuntimeExecutableNotFoundError extends Error {
  readonly code = "runtime_not_found" as const;
  readonly runtimeId: string;

  constructor(input: { runtimeId: string; message: string }) {
    super(input.message);
    this.name = "RuntimeExecutableNotFoundError";
    this.runtimeId = input.runtimeId;
  }
}

/** The local Agent Credential Proxy could not bind its listening port. */
export class AgentProxyBindError extends Error {
  readonly code = "agent_proxy_bind_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "AgentProxyBindError";
  }
}

export type ProviderConnectionMaterializationFailureKind = "http" | "invalid_payload" | "invalid_environment";

/** The server could not materialize the provider connection for launch. */
export class ProviderConnectionMaterializationError extends Error {
  readonly code = "provider_connection_materialization_failed" as const;
  readonly kind: ProviderConnectionMaterializationFailureKind;
  readonly status?: number;

  constructor(input: { kind: ProviderConnectionMaterializationFailureKind; status?: number; message: string }) {
    super(input.message);
    this.name = "ProviderConnectionMaterializationError";
    this.kind = input.kind;
    this.status = input.status;
  }
}

export function isRuntimeModelNotFoundError(error: unknown): error is RuntimeModelNotFoundError {
  return error instanceof RuntimeModelNotFoundError || (error instanceof Error && (error as { code?: unknown }).code === "model_not_found");
}

export function isProviderConnectionMaterializationError(error: unknown): error is ProviderConnectionMaterializationError {
  return error instanceof ProviderConnectionMaterializationError
    || (error instanceof Error && (error as { code?: unknown }).code === "provider_connection_materialization_failed");
}
