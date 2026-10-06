import { useCallback, useEffect, useRef, useState } from "react";
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";

export const CONVERSION_OBSERVATION_CONFIRM_MS = 10_000;

/** Bound the foreground confirmation state, never the truth of the command. */
export function useConversionObservationNotice(initialStartedAt?: number, initialServerPending = false) {
  const generationRef = useRef(initialStartedAt === undefined ? 0 : 1);
  const [notice, setNotice] = useState<{ generation: number; kind: "pending" | "unavailable" } | null>(
    initialStartedAt === undefined ? null : { generation: 1, kind: initialServerPending ? "pending" : "unavailable" },
  );
  const generation = notice?.generation ?? null;
  const [settledGeneration, setSettledGeneration] = useState<number | null>(
    initialStartedAt !== undefined && currentTimeMs() - initialStartedAt >= CONVERSION_OBSERVATION_CONFIRM_MS ? 1 : null,
  );
  const setWarning = useCallback((active: boolean) => {
    setNotice((previous) => active ? { generation: previous?.generation ?? ++generationRef.current, kind: "unavailable" } : null);
  }, []);
  const setPending = useCallback(() => {
    setNotice((previous) => ({ generation: previous?.generation ?? ++generationRef.current, kind: "pending" }));
  }, []);
  useEffect(() => {
    if (generation === null) return;
    const remaining = initialStartedAt === undefined ? CONVERSION_OBSERVATION_CONFIRM_MS
      : Math.max(0, CONVERSION_OBSERVATION_CONFIRM_MS - (currentTimeMs() - initialStartedAt));
    const timer = setClockTimeout(() => setSettledGeneration(generation), remaining);
    return () => clearClockTimeout(timer);
  }, [generation, initialStartedAt]);
  return {
    warning: notice?.kind === "unavailable",
    pending: notice?.kind === "pending",
    settled: generation !== null && generation === settledGeneration,
    setWarning,
    setPending,
  };
}
