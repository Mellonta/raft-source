import assert from "node:assert/strict";
import { MACHINE_DISK_LOW_FREE_PERCENT, isMachineDiskLow, isValidMachineDiskStatus } from "./index";
import { CLEANER_DISK_FREE_PERCENT_THRESHOLD } from "./apps/cleaner/configProtocol";

test("the machine low-disk threshold is the cleaner's", () => {
  assert.equal(MACHINE_DISK_LOW_FREE_PERCENT, CLEANER_DISK_FREE_PERCENT_THRESHOLD);
});

test("disk reports must be whole, non-negative and self-consistent", () => {
  assert.equal(isValidMachineDiskStatus({ availableBytes: 0, totalBytes: 1 }), true);
  for (const bad of [
    null,
    { availableBytes: 1, totalBytes: 0 },
    { availableBytes: -1, totalBytes: 10 },
    { availableBytes: 11, totalBytes: 10 },
    { availableBytes: 1.5, totalBytes: 10 },
    { availableBytes: "1", totalBytes: 10 },
  ]) {
    assert.equal(isValidMachineDiskStatus(bad), false, JSON.stringify(bad));
  }
});

test("low means strictly under 10% free", () => {
  assert.equal(isMachineDiskLow({ availableBytes: 9, totalBytes: 100 }), true);
  assert.equal(isMachineDiskLow({ availableBytes: 10, totalBytes: 100 }), false);
  assert.equal(isMachineDiskLow(null), false);
});

test("a disk with 20 GiB or more free is never low, whatever the percentage", () => {
  const GIB = 1024 ** 3;
  assert.equal(isMachineDiskLow({ availableBytes: 100 * GIB, totalBytes: 2048 * GIB }), false, "5% of 2 TiB");
  assert.equal(isMachineDiskLow({ availableBytes: 20 * GIB, totalBytes: 2048 * GIB }), false);
  assert.equal(isMachineDiskLow({ availableBytes: 20 * GIB - 1, totalBytes: 2048 * GIB }), true);
  assert.equal(isMachineDiskLow({ availableBytes: 15 * GIB, totalBytes: 100 * GIB }), false, "15% is not low even under 20 GiB");
});
