import { agentApiInboxSourceRefSchema } from "@botiverse/raft-shared/src/agentApiContract";
import { appSourceTraceAttrs } from "@botiverse/raft-shared/src/appRuntimeTrace";
import { BUILT_IN_RAP_APPS } from "./rapBuiltinAppManifests";

/**
 * Validates the app reference on an inbound wake request before it becomes span
 * attributes.
 *
 * The wake request arrives from a machine over the websocket. The machine's
 * IDENTITY is authenticated; its CONTENT is not. A modified or older daemon can
 * put any string into `appId` / `sourceRef.id`, and until now those went
 * straight onto `server.agent.wake_request`.
 *
 * NOTE on the shape of the gap, because the first reading of it was narrower
 * than the truth: `filterAppRuntimeTraceAttrs` /
 * `SERVER_BUILT_IN_APP_TRACE_ALLOWED_KEYS` do constrain the KEY layer — but on
 * the RECEIPT paths, not here. This span hands its attrs to `withTraceRoot`,
 * which passes `options.attrs` to `startSpan` untouched, and the server has no
 * equivalent of the daemon's span-attr contract. So on this path NEITHER layer
 * was constrained, not just the value layer (@Leiysky read the path and named
 * the value gap; @Stone named the boundary; the key half is corrected here).
 *
 * "The value space is guaranteed by the daemon's registry" would be the server
 * taking the other side's code as its own guarantee, which is exactly what a
 * trust boundary exists to refuse. So the server checks for itself.
 *
 * The known-app set is the SERVER's own (`BUILT_IN_RAP_APPS`, assembled from
 * each app's own `definition.ts`). It is deliberately NOT imported from the daemon:
 * borrowing the daemon's list would reconnect the boundary this closes
 * (@Leiysky).
 *
 * Failure does not change wake semantics — the wake is still handled. Only the
 * span loses the unvalidated values and gains `app_ref_invalid`, so an operator
 * can tell "no app reference was sent" from "one was sent and rejected"
 * (@Stone).
 */
export function wakeRequestAppRefTraceAttrs(input: {
  appId?: unknown;
  ownerAgentId: string;
  sourceRef?: unknown;
}): Record<string, unknown> {
  // No app reference at all is the ordinary case for most wakes, and is not a
  // rejection. Saying otherwise would make `app_ref_invalid` fire constantly and
  // stop meaning anything.
  if (input.appId === undefined && input.sourceRef === undefined) return {};

  const knownAppIds = new Set<string>(BUILT_IN_RAP_APPS.map((app) => String(app.appId)));
  if (typeof input.appId !== "string" || !knownAppIds.has(input.appId)) {
    return { app_ref_invalid: true, app_ref_invalid_reason: "unknown_app_id" };
  }

  const sourceRef = agentApiInboxSourceRefSchema.safeParse(input.sourceRef);
  if (!sourceRef.success) {
    return { app_ref_invalid: true, app_ref_invalid_reason: "source_ref_malformed" };
  }

  return {
    ...appSourceTraceAttrs({
      appId: input.appId,
      ownerAgentId: input.ownerAgentId,
      sourceRef: sourceRef.data,
    }),
    app_ref_invalid: false,
  };
}
