// Optional typed Trace V2 shadow projection into ScopeDB (RAFT_TRACE_SCOPEDB_PROJECTOR).
import type { TraceUploadRuntimeEnv } from "../env";
import type { JsonObject } from "../shared/http";
import type { TraceBundleMetadata } from "./bundles";
import { inferDaemonServiceVersion, type LocalTraceRecord } from "./otlp";
import {
  ScopeDbTraceEventProjector,
  TRACE_PROJECTION_RECORD_VALIDATION_ERROR,
  type ProjectableTraceRecord,
  type TraceProjectionResource,
  type TraceProjectionSkipReasonClass,
} from "./traceEventProjector";

export type V2ProjectorStatus = "success" | "failed" | "skipped";

interface V2ProjectionResult {
  status: V2ProjectorStatus;
  spansProjected: number;
  rowsProjected: number;
  spansSkipped: number;
  skipReasonClasses: readonly TraceProjectionSkipReasonClass[];
  errorClass?: string;
}

export function projectorConfigured(env: TraceUploadRuntimeEnv): boolean {
  return env.RAFT_TRACE_SCOPEDB_PROJECTOR === "on";
}

function projectorFlagInvalid(env: TraceUploadRuntimeEnv): boolean {
  const value = env.RAFT_TRACE_SCOPEDB_PROJECTOR;
  return value !== undefined && value !== "" && value !== "off" && value !== "on";
}

export function initialV2ProjectorStatus(env: TraceUploadRuntimeEnv): "pending" | "failed" | "skipped" {
  if (projectorFlagInvalid(env)) return "failed";
  if (!projectorConfigured(env)) return "skipped";
  return env.TRACE_INGEST_OTLP_ENDPOINT ? "pending" : "failed";
}

export function projectorDisabledByMissingCanonicalSink(env: TraceUploadRuntimeEnv): V2ProjectionResult {
  if (projectorFlagInvalid(env)) {
    return {
      status: "failed",
      spansProjected: 0,
      rowsProjected: 0,
      spansSkipped: 0,
      skipReasonClasses: [],
      errorClass: "ProjectorFlagInvalidError",
    };
  }
  if (!projectorConfigured(env)) {
    return { status: "skipped", spansProjected: 0, rowsProjected: 0, spansSkipped: 0, skipReasonClasses: [] };
  }
  return {
    status: "failed",
    spansProjected: 0,
    rowsProjected: 0,
    spansSkipped: 0,
    skipReasonClasses: [],
    errorClass: "CanonicalSinkUnconfiguredError",
  };
}

export async function projectV2BestEffort(
  env: TraceUploadRuntimeEnv,
  records: readonly ProjectableTraceRecord[],
  resource: TraceProjectionResource,
): Promise<V2ProjectionResult> {
  if (projectorFlagInvalid(env)) {
    return {
      status: "failed",
      spansProjected: 0,
      rowsProjected: 0,
      spansSkipped: 0,
      skipReasonClasses: [],
      errorClass: "ProjectorFlagInvalidError",
    };
  }
  if (!projectorConfigured(env)) {
    return { status: "skipped", spansProjected: 0, rowsProjected: 0, spansSkipped: 0, skipReasonClasses: [] };
  }
  const endpoint = env.SCOPEDB_TRACE_EVENTS_ENDPOINT;
  const token = env.SCOPEDB_TRACE_EVENTS_WRITE_KEY;
  if (!endpoint || !token) {
    return {
      status: "failed",
      spansProjected: 0,
      rowsProjected: 0,
      spansSkipped: 0,
      skipReasonClasses: [],
      errorClass: "ProjectorConfigurationError",
    };
  }
  try {
    const projector = new ScopeDbTraceEventProjector({
      endpoint,
      token,
      client: env.SCOPEDB_TRACE_EVENTS_CLIENT,
    });
    const result = await projector.project(records, resource);
    if (result.spansSkipped > 0) {
      console.warn("[TraceUploadWorker] V2 trace projection skipped invalid records", {
        error_class: TRACE_PROJECTION_RECORD_VALIDATION_ERROR,
        spans_skipped: result.spansSkipped,
      });
      return {
        status: "failed",
        ...result,
        errorClass: TRACE_PROJECTION_RECORD_VALIDATION_ERROR,
      };
    }
    return { status: "success", ...result };
  } catch (error) {
    const errorClass = error instanceof Error && error.name ? error.name : "Error";
    console.warn("[TraceUploadWorker] V2 trace projection failed", { error_class: errorClass });
    return {
      status: "failed",
      spansProjected: 0,
      rowsProjected: 0,
      spansSkipped: 0,
      skipReasonClasses: [],
      errorClass,
    };
  }
}

export function webProjectionResource(
  env: TraceUploadRuntimeEnv,
  serverId: string,
  resourceAttrs: JsonObject,
): TraceProjectionResource {
  return {
    serviceName: "slock-web",
    deploymentEnvironment: env.DEPLOYMENT_ENV,
    serviceVersion: versionAttr(resourceAttrs["service.version"]),
    serviceRevision: env.SLOCK_RELEASE_SHA,
    serverId,
  };
}

export function daemonProjectionResource(
  env: TraceUploadRuntimeEnv,
  metadata: TraceBundleMetadata,
  records: readonly LocalTraceRecord[],
): TraceProjectionResource {
  return {
    serviceName: env.TRACE_INGEST_SERVICE_NAME || "slock-daemon",
    deploymentEnvironment: metadata.deploymentEnvironment ?? env.DEPLOYMENT_ENV,
    serviceVersion: versionAttr(inferDaemonServiceVersion(records)),
    serviceRevision: env.SLOCK_RELEASE_SHA,
    serverId: metadata.serverId,
    machineId: metadata.machineId,
    agentId: metadata.agentId,
  };
}

export function stringAttr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function versionAttr(value: unknown): string | undefined {
  const version = stringAttr(value);
  if (!version || version.length > 64 || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) return undefined;
  return version;
}
