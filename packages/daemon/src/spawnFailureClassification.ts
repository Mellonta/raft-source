import {
  RuntimeModelNotConfiguredError,
  isProviderConnectionMaterializationError,
  isRuntimeModelNotFoundError,
  spawnFailureCodeOf,
  type SpawnFailureReason,
} from "./spawnFailureErrors";

export type { SpawnFailureReason } from "./spawnFailureErrors";

type RuntimeModelNotFoundErrorLike = { model: string };

export interface SpawnFailureClassification {
  reason: SpawnFailureReason;
  detail: string;
  userMessage: string;
}

/**
 * Map a launch failure to a stable reason + a user message that never carries
 * raw detail. Decides by the error's typed code only (task #1120): message
 * text is for logs, so a "not found" in a model error can no longer be read as
 * a missing executable. Anything without a known code is the generic fallback.
 */
export function classifySpawnFailure(error: unknown): SpawnFailureClassification {
  const detail = error instanceof Error ? error.message : String(error);
  const reason = spawnFailureCodeOf(error) ?? "runtime_spawn_failed";

  switch (reason) {
    case "runtime_version_too_old":
      return { reason, detail, userMessage: detail };
    case "provider_connection_materialization_failed": {
      const typed = isProviderConnectionMaterializationError(error)
        ? error
        : isProviderConnectionMaterializationError((error as { cause?: unknown }).cause)
          ? (error as { cause: import("./spawnFailureErrors").ProviderConnectionMaterializationError }).cause
          : null;
      const safeDetail = typed?.kind === "http" && typed.status !== undefined
        ? `Provider connection materialization failed (HTTP ${typed.status})`
        : typed?.kind === "invalid_payload"
          ? "Provider connection materialization returned an invalid payload"
          : typed?.kind === "invalid_environment"
            ? "Provider connection materialization returned an invalid environment"
            : "Provider connection materialization failed";
      return { reason, detail, userMessage: `${safeDetail}. Check Server Settings → AI Providers and retry.` };
    }
    case "agent_proxy_bind_failed":
      return {
        reason,
        detail,
        userMessage: "Local agent proxy could not start. Check if another daemon or service is using the required local port.",
      };
    case "runner_credential_mint_failed":
      return {
        reason,
        detail,
        userMessage: "Runner credential mint failed. Ensure the server is deployed and the daemon binary is compatible.",
      };
    case "model_not_found": {
      const typed = isRuntimeModelNotFoundError(error)
        ? error
        : isRuntimeModelNotFoundError((error as { cause?: unknown }).cause)
          ? (error as { cause: RuntimeModelNotFoundErrorLike }).cause
          : null;
      const model = typed ? typed.model : "the configured model";
      return {
        reason,
        detail,
        userMessage: `Model ${model} is not available for this runtime on this computer. Choose another model in the agent's settings and retry.`,
      };
    }
    case "runtime_not_found":
      return {
        reason,
        detail,
        userMessage: "Runtime executable not found. Ensure the required CLI is installed and available on PATH.",
      };
    case "model_not_configured": {
      const cause = (error as { cause?: unknown }).cause;
      const typed = error instanceof RuntimeModelNotConfiguredError
        ? error
        : cause instanceof RuntimeModelNotConfiguredError ? cause : null;
      const model = typed ? typed.model : "the configured model";
      return {
        reason,
        detail,
        userMessage: `Model ${model} is not configured for this runtime on this computer. Choose a configured model in the agent's settings, or add it to the runtime's configuration there, then restart the agent.`,
      };
    }
    case "runtime_login_required":
      return {
        reason,
        detail,
        userMessage: "The runtime needs you to log in on this computer before it can start. Log in to the runtime there, then restart the agent.",
      };
    case "runtime_config_invalid":
      return {
        reason,
        detail,
        userMessage: "The runtime's configuration on this computer is invalid, so the agent cannot start. Fix the runtime configuration there, then restart the agent.",
      };
    case "runtime_spawn_failed":
      return {
        reason,
        detail,
        userMessage: "Runtime failed to start. Check the Computer logs for details and retry.",
      };
  }
}
