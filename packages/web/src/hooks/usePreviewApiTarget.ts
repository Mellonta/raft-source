import { useEffect, useState } from "react";

export function usePreviewApiTarget(enabled: boolean): "staging" | "prod" | null {
  const [target, setTarget] = useState<"staging" | "prod" | null>(null);

  // Gateway metadata is an external browser resource, refreshed by focus/visibility events.
  // eslint-disable-next-line react-doctor/no-fetch-in-effect
  useEffect(() => {
    if (!enabled) return;
    let request: AbortController | undefined;
    const refresh = () => {
      request?.abort();
      const current = new AbortController();
      request = current;
      // A build-time target becomes stale when the gateway registry changes.
      // Hide the previous claim until this read confirms the current target.
      setTarget(null);
      void fetch("/__raft_preview", { cache: "no-store", signal: current.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("Preview metadata unavailable");
          const metadata: unknown = await response.json();
          const value = metadata && typeof metadata === "object" && "apiTarget" in metadata
            ? metadata.apiTarget : null;
          if (!current.signal.aborted) setTarget(value === "staging" || value === "prod" ? value : null);
        })
        .catch(() => {
          if (!current.signal.aborted) setTarget(null);
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    // Start the same asynchronous external-resource read used by the browser listeners.
    // eslint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      request?.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  return enabled ? target : null;
}
