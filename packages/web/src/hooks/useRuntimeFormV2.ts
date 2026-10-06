import { useEffect, useState } from "react";
import { missingRuntimeFormV2Capabilities, parseRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import type {
  ParsedRuntimeFormV2,
  RuntimeFormV2OptionSource,
  RuntimeFormV2Sources,
} from "@botiverse/raft-runtime-form";

import api from "../api/client";
import { useServerStore } from "../store/serverStore";

/**
 * `requiredClientCapabilities` this web client implements. A v2 form that needs
 * anything else is unavailable here and the caller falls back to its v1/legacy
 * form (packages/runtime-form README, "Protocol v2").
 */
export const WEB_RUNTIME_FORM_V2_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  // Combobox for a select whose source allows a typed value (RuntimeFormV2Fields).
  "select.custom_value",
  // Choice labels and descriptions from FieldCopy.choices (runtimeFormV2Choices).
  "choice.labels",
  // Per-source status, retry and submit blocking (this hook + RuntimeFormV2Fields).
  "option_source.status",
]);

export type RuntimeFormV2State =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      form: ParsedRuntimeFormV2;
      sources: RuntimeFormV2Sources;
      /** `option_source.status`: re-request one source with `?refresh=1`. */
      retrySource?: (sourceId: string) => void;
      /** Sources being re-requested right now. */
      retryingSourceIds?: readonly string[];
    }
  | { status: "error"; errorCode?: string }
  /** The form needs client capabilities this build lacks: use the legacy form. */
  | { status: "unsupported"; missingCapabilities: string[] };

const runtimeFormV2Base = (serverId: string, machineId: string, runtimeId: string) =>
  `/servers/${serverId}/machines/${machineId}/runtime-forms/v2/${encodeURIComponent(runtimeId)}`;

/**
 * A source whose request failed, for a form that uses `option_source.status`:
 * the same "unavailable" the server would send, retryable, without a reason
 * (shown as a generic message). The form stays usable around it.
 */
function unreachableSource(form: ParsedRuntimeFormV2, sourceId: string): RuntimeFormV2OptionSource {
  const ref = form.optionSources[sourceId];
  const pointer = `/${ref?.key ?? sourceId}`;
  return ref?.kind === "dependent_select"
    ? { sourceId, kind: "dependent_select", pointer, dependsOn: `/${ref.dependsOn ?? ""}`, optionsByValue: {}, status: "unavailable", retryable: true }
    : { sourceId, kind: "select", pointer, options: [], defaultValue: "", status: "unavailable", retryable: true };
}

async function loadRuntimeFormV2Source(
  base: string,
  form: ParsedRuntimeFormV2,
  sourceId: string,
  refresh: boolean,
): Promise<RuntimeFormV2OptionSource> {
  const url = `${base}/option-sources/${encodeURIComponent(sourceId)}${refresh ? "?refresh=1" : ""}`;
  try {
    const { data } = await api.get(url);
    return data as RuntimeFormV2OptionSource;
  } catch (error) {
    // Forms without option_source.status keep the old contract: a failed
    // source fails the whole form (with the server's error code).
    if (!form.requiredClientCapabilities.includes("option_source.status")) throw error;
    return unreachableSource(form, sourceId);
  }
}

async function loadRuntimeFormV2(
  base: string,
  agentId?: string,
): Promise<Exclude<RuntimeFormV2State, { status: "idle" | "loading" }>> {
  // Edit reads the same form plus the agent's current values from the agent itself.
  const { data } = await api.get(agentId ? `/agents/${encodeURIComponent(agentId)}/runtime-form` : base);
  const form = parseRuntimeFormV2(data);
  if (!form) return { status: "error" };
  const missingCapabilities = missingRuntimeFormV2Capabilities(form, WEB_RUNTIME_FORM_V2_CAPABILITIES);
  // Checked before any option source is loaded: an unavailable form is not rendered at all.
  if (missingCapabilities.length > 0) return { status: "unsupported", missingCapabilities };
  // Each source loads on its own: with option_source.status one failing source
  // is reported on its field (loadRuntimeFormV2Source) and never fails the form.
  const sources = Object.fromEntries(await Promise.all(Object.keys(form.optionSources).map(async (sourceId) =>
    [sourceId, await loadRuntimeFormV2Source(base, form, sourceId, false)] as const)));
  return { status: "ready", form, sources, retryingSourceIds: [] };
}

/**
 * Protocol v2 create form for one runtime on one Computer: the current form as
 * the server describes it, plus its option lists. Tolerant by contract; only a
 * body that is not a v2 form at all, or a failed request, is an error. A form
 * requiring client capabilities this build lacks is "unsupported".
 */
export function useRuntimeFormV2(
  machineId: string | null | undefined,
  runtimeId: string | null,
  agentId?: string,
): RuntimeFormV2State {
  const serverId = useServerStore((state) => state.current?.id);
  const requestKey = serverId && machineId && runtimeId ? `${serverId}\0${machineId}\0${runtimeId}\0${agentId ?? ""}` : "";
  const [state, setState] = useState<{ requestKey: string; value: RuntimeFormV2State }>({ requestKey: "", value: { status: "idle" } });

  // One snapshot per request key; each branch replaces the whole object.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!serverId || !machineId || !runtimeId) return;
    let cancelled = false;
    setState({ requestKey, value: { status: "loading" } });
    const base = runtimeFormV2Base(serverId, machineId, runtimeId);
    // Updates the ready snapshot of this request only; a later request key wins.
    const updateReady = (update: (ready: Extract<RuntimeFormV2State, { status: "ready" }>) => RuntimeFormV2State) =>
      setState((previous) => previous.requestKey === requestKey && previous.value.status === "ready"
        ? { requestKey, value: update(previous.value) }
        : previous);
    loadRuntimeFormV2(base, agentId).then(
      (loaded) => {
        if (cancelled) return;
        if (loaded.status !== "ready") {
          setState({ requestKey, value: loaded });
          return;
        }
        const inFlight = new Set<string>();
        const retrySource = (sourceId: string) => {
          if (cancelled || inFlight.has(sourceId)) return;
          inFlight.add(sourceId);
          updateReady((ready) => ({ ...ready, retryingSourceIds: [...inFlight] }));
          void loadRuntimeFormV2Source(base, loaded.form, sourceId, true)
            .catch(() => unreachableSource(loaded.form, sourceId))
            .then((source) => {
              inFlight.delete(sourceId);
              if (cancelled) return;
              updateReady((ready) => ({ ...ready, sources: { ...ready.sources, [sourceId]: source }, retryingSourceIds: [...inFlight] }));
            });
        };
        setState({ requestKey, value: { ...loaded, retrySource } });
      },
      (error: unknown) => {
        if (cancelled) return;
        const code = (error as { response?: { data?: { code?: unknown } } }).response?.data?.code;
        setState({ requestKey, value: { status: "error", ...(typeof code === "string" ? { errorCode: code } : {}) } });
      },
    );
    return () => { cancelled = true; };
  }, [agentId, machineId, requestKey, runtimeId, serverId]);

  if (!requestKey) return { status: "idle" };
  if (state.requestKey !== requestKey) return { status: "loading" };
  return state.value;
}
