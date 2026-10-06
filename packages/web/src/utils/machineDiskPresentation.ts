import type { IntlShape } from "react-intl";
import { isMachineDiskLow } from "@botiverse/raft-shared";
import type { MachineDiskStatus } from "@botiverse/raft-shared";
import { formatFileSizeBytes } from "./fileSizePresentation";

export interface MachineDiskLowPresentation {
  free: string;
  freePercent: number;
  /**
   * Coarse severity band. A dismissed warning returns only when the band gets
   * worse, so it does not nag while space stays roughly the same.
   */
  band: "under10" | "under5" | "under2" | "under1";
}

/** Null unless the machine is online and reported less than 10% free space. */
export function machineDiskLowPresentation(
  machine: { status: string; diskStatus?: MachineDiskStatus | null },
  formatMessage: IntlShape["formatMessage"],
): MachineDiskLowPresentation | null {
  const disk = machine.diskStatus;
  if (machine.status !== "online" || !disk || !isMachineDiskLow(disk)) return null;
  const percent = disk.availableBytes / disk.totalBytes * 100;
  return {
    free: formatFileSizeBytes(disk.availableBytes, formatMessage),
    freePercent: Math.floor(percent * 10) / 10,
    band: percent < 1 ? "under1" : percent < 2 ? "under2" : percent < 5 ? "under5" : "under10",
  };
}
