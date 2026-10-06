import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthStore } from "../store/authStore";
import { useChannelStore } from "../store/channelStore";
import { useServerStore } from "../store/serverStore";
import { channelConversionState, isChannelConversionBlocked } from "../store/channelConversionState";
import {
  clearConversionObservation, conversionObservationFromServer, conversionObservationScope,
  readPendingConversionCommand, retainServerConversionObservation, usePendingConversionCommand,
} from "../store/conversionObservationStore";
import type { ConversionObservationToken } from "../store/conversionObservationStore";

/** Parent and Thread composers use the parent channel identity. Dialogs also
 * retain discovered commands for their existing close/reopen observation loop. */
export function useChannelConversionState(channelId: string, observe = false) {
  const userId = useAuthStore((state) => state.user?.id);
  const serverId = useServerStore((state) => state.current?.id);
  const channel = useChannelStore((state) => state.channels.find((entry) => entry.id === channelId));
  const state = useMemo(() => channelConversionState(channel), [channel]);
  // eslint-disable-next-line react-doctor/no-event-handler -- Pure branded storage-key adapter.
  const observationScope = conversionObservationScope(userId, serverId, channelId);
  const localPendingCommand = usePendingConversionCommand(observationScope);
  const [resolved, setResolved] = useState<{ scope: typeof observationScope; id: string } | null>(null);
  const serverCommand = state.command;
  const pendingCommand = useMemo(() => localPendingCommand ?? (
    observe && serverCommand?.status === "pending"
      && !(resolved?.scope === observationScope && resolved.id === serverCommand.id)
      ? conversionObservationFromServer(serverCommand) : null
  ), [localPendingCommand, observe, serverCommand, resolved, observationScope]);
  // Retain the existing observation across later channel hydration; this is not
  // another writable business snapshot. Phase one deliberately keeps its format.
  useEffect(() => {
    // eslint-disable-next-line react-doctor/no-event-handler -- Synchronize a discovered server receipt, not a UI event.
    if (observe && observationScope && serverCommand?.status === "pending") {
      retainServerConversionObservation(observationScope, conversionObservationFromServer(serverCommand));
    }
  }, [observe, observationScope, serverCommand]);
  const finishObservation = useCallback((token: ConversionObservationToken | undefined = pendingCommand?.token) => {
    clearConversionObservation(observationScope, token);
    if (token) setResolved({ scope: observationScope, id: token });
  }, [observationScope, pendingCommand?.token]);
  return { state, observationScope, pendingCommand, finishObservation,
    blocked: isChannelConversionBlocked(channel, pendingCommand) };
}

/** Re-read at dispatch: a socket update may precede the next React render. */
export function readChannelConversionBlocked(channelId: string): boolean {
  const scope = conversionObservationScope(useAuthStore.getState().user?.id, useServerStore.getState().current?.id, channelId);
  const channel = useChannelStore.getState().channels.find((entry) => entry.id === channelId);
  return isChannelConversionBlocked(channel, readPendingConversionCommand(scope));
}
