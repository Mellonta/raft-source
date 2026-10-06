import { useCallback, useEffect, useState } from "react";
import { ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { AgentRuntimeProviderAvailabilityView, AgentRuntimeProviderKind } from "@botiverse/raft-shared";
import api from "../api/client";
import { useServerFeatureFlag } from "../store/serverFeatureFlags";
import { useServerStore } from "../store/serverStore";

/**
 * Whether "Run on <provider>" can be offered: the server's feature flag
 * (`antiproton_hosted_runtime`, evaluated through the feature-flag client) and
 * then the server's availability probe, which also checks that the deployment
 * has the provider configured. Nothing about the configuration reaches the web.
 */
export function useAgentRuntimeProvider(kind: AgentRuntimeProviderKind, enabled = true) {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  const feature = useServerFeatureFlag(ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY);
  const requestEnabled = enabled && feature.enabled && Boolean(serverId);
  const [available, setAvailable] = useState(false);

  const refresh = useCallback(async () => {
    if (!requestEnabled) return;
    try {
      const { data } = await api.get<AgentRuntimeProviderAvailabilityView>(`/agent-runtime-providers/${kind}`);
      setAvailable(data.available === true);
    } catch {
      setAvailable(false);
    }
  }, [kind, requestEnabled]);

  useEffect(() => {
    void refresh();
  }, [refresh, serverId]);

  return { available: requestEnabled && available, refresh };
}
