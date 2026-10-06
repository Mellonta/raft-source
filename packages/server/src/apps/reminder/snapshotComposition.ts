import {
  appSnapshotTraceAttrs,
  appSourceTraceAttrs,
} from "@botiverse/raft-shared/src/appRuntimeTrace";
import type { ReminderJob } from "@botiverse/raft-shared";

import { composeAppSnapshot } from "../../services/appSnapshotComposition";
import { BUILT_IN_REMINDER_APP } from "./definition";
import { getSnapshotForAgent, toReminderJob } from "./service";

export function composeReminderSnapshot(ownerAgentId: string) {
  const snapshotTraceAttrs = appSnapshotTraceAttrs({
    appId: BUILT_IN_REMINDER_APP.appId,
    ownerAgentId,
    snapshotKind: "reminder",
  });
  return composeAppSnapshot<ReminderJob>(
    [
      {
        snapshotTraceAttrs,
        build: async () =>
          (await getSnapshotForAgent(ownerAgentId)).map((row) => ({
            value: toReminderJob(row),
            traceAttrs: appSourceTraceAttrs({
              ownerAgentId,
              sourceRef: {
                kind: "reminder",
                id: row.id,
                revision: String(row.version),
              },
            }),
          })),
      },
    ],
    snapshotTraceAttrs,
  );
}
