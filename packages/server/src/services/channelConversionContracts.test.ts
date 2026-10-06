import assert from "node:assert/strict";
import { parseConversionProgress } from "./channelConversionContracts";

describe("channel conversion progress boundary", () => {
  it("forces the current version and drops unknown fields", () => {
    const parsed = parseConversionProgress({
      version: 99,
      secret: "must not enter the ledger",
      movedParentMessages: 3,
    });
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.resources.parent?.messages, { moved: 3, cursor: null, checksum: null });
    assert.equal("secret" in parsed, false);
    assert.equal(parsed.preparedThreads, undefined);
  });

  it("rejects malformed business state before it enters a phase", () => {
    for (const payload of [
      { resources: "bad" }, { audienceCutover: { threadIds: 5 } },
      { sourceArchiveSnapshot: { archivedAt: true } }, { residualCleanupLedger: { followRows: "2" } },
      { resources: { parent: { messages: { moved: -1, cursor: null, checksum: null } } } },
    ]) assert.throws(() => parseConversionProgress(payload));
  });

  it("keeps only typed resource progress from a persisted payload", () => {
    const parsed = parseConversionProgress({
      resources: { messages: { moved: 2, cursor: "m", checksum: "c" }, tasks: "bad" },
      movedThreadAttachments: 4,
    });
    assert.deepEqual(parsed.resources.thread?.attachments, { moved: 4, cursor: null, checksum: null });
    assert.equal(parsed.resources.parent?.messages, undefined);
    assert.equal(parsed.resources.parent?.tasks, undefined);
  });

  it("preserves parent and thread progress independently", () => {
    const parsed = parseConversionProgress({ movedParentMessages: 5, movedParentMessagesCursor: "p", movedThreadMessages: 7, movedThreadMessagesCursor: "t" });
    assert.equal(parsed.resources.parent?.messages?.moved, 5);
    assert.equal(parsed.resources.thread?.messages?.moved, 7);
    assert.equal(parsed.resources.parent?.messages?.cursor, "p");
    assert.equal(parsed.resources.thread?.messages?.cursor, "t");
  });

  it("round trips the current typed resource schema", () => {
    const parsed = parseConversionProgress({ movedParentMessages: 999, resources: {
      parent: { messages: { moved: 5, cursor: "p", checksum: "pc" } },
      thread: { messages: { moved: 7, cursor: "t", checksum: "tc" } },
    } });
    assert.deepEqual(parsed.resources, {
      parent: { messages: { moved: 5, cursor: "p", checksum: "pc" } },
      thread: { messages: { moved: 7, cursor: "t", checksum: "tc" } },
    });
  });
});
