import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createChannelRefRegex, createChannelThreadRefRegex } from "../src/utils/messageReferencePatterns";

test("channel refs support CJK channel names", () => {
  const matches = Array.from("go to #对话流专修 and #android-artifacts".matchAll(createChannelRefRegex()));

  assert.deepEqual(matches.map((match) => match[1]), ["对话流专修", "android-artifacts"]);
});

test("channel thread refs support CJK channel names", () => {
  const matches = Array.from("see #对话流专修:abc123 and #product:deadbee".matchAll(createChannelThreadRefRegex()));

  assert.deepEqual(matches.map((match) => [match[1], match[2]]), [
    ["对话流专修", "abc123"],
    ["product", "deadbee"],
  ]);
});

test("MessageItem bare refs use shared Slock Ref scanners", () => {
  const source = readFileSync(new URL("../src/components/message/MessageItem.tsx", import.meta.url), "utf8");
  const shared = readFileSync(new URL("../../shared/src/raftRefs.ts", import.meta.url), "utf8");

  for (const factory of [
    "createRaftUserRefRegex",
    "createRaftChannelThreadRefRegex",
    "createRaftDmThreadRefRegex",
    "createRaftBareTaskRefRegex",
    "createRaftChannelRefRegex",
    "createRaftMessageRefRegex",
  ]) {
    assert.match(source, new RegExp(`${factory}\\(\\)`), `MessageItem must call ${factory}`);
    assert.match(shared, new RegExp(`export function ${factory}\\(\\): RegExp`), `${factory} must live in shared`);
  }

  assert.doesNotMatch(source, /@\\\(\[\\p\{L\}\\p\{N\}_-\]\+\)/);
  assert.doesNotMatch(source, /dm:@\(\[\\w-\]\+\):\(\[\\da-f\]\{6,8\}\)/);
  assert.doesNotMatch(source, /\(\^\|\[\^\\w\/\]\)\(\?:\(task\\s\+\)\)\?#\(\\d\+\)\\b/);
  assert.doesNotMatch(source, /#\(\[\\w-\]\+\)/);
});

test("MessageItem resolves bare mention labels from the canonical identity directory", () => {
  const source = readFileSync(new URL("../src/components/message/MessageItem.tsx", import.meta.url), "utf8");

  assert.match(source, /const safeName = name\.replace/);
  assert.match(source, /data-mention="\$\{safeName\}"/);
  assert.match(source, /const visibleLabel = resolvedMention\?\.displayName/);
  assert.match(source, /escapeMessageHtmlText\(visibleLabel\)/);
  assert.match(source, /resolveMentionByIdentity\(entry\.type, entry\.id\)/);
  assert.match(source, /: `@\$\{name\}`/);
  assert.doesNotMatch(source, /pendingLabel=/);
});

test("all message reference chips share one box from the RUI recipe (no local font scale)", () => {
  const source = readFileSync(new URL("../src/components/message/MessageItem.tsx", import.meta.url), "utf8");
  const mention = readFileSync(
    new URL("../src/components/message/MentionLink.tsx", import.meta.url),
    "utf8",
  );
  const attachmentComments = readFileSync(
    new URL("../src/components/message/AttachmentCommentsPanel.tsx", import.meta.url),
    "utf8",
  );
  const attachmentCommentRefChip = readFileSync(
    new URL("../src/components/message/AttachmentCommentRefChip.tsx", import.meta.url),
    "utf8",
  );
  const referenceChip = readFileSync(
    new URL("../src/components/message/ReferenceChip.tsx", import.meta.url),
    "utf8",
  );
  const taskRefSection = source.slice(
    source.indexOf("const taskRef"),
    source.indexOf("const raftPermalink"),
  );

  // Since raft-ui 0.5.16 (rui#319) the RUI message-reference recipe owns the
  // whole chip box: body size on the body baseline, the box made of the
  // text's own line box. slock composes MessageReferenceChip/Text and appends
  // only behaviour classes (cursor, busy/unavailable opacity) — no font scale
  // and no hand-spelled box. In-message refs stay on the arrow cursor (stdrc
  // task #28 msg=ca65d96d).
  for (const src of [source, mention, referenceChip, attachmentCommentRefChip]) {
    assert.doesNotMatch(src, /MSG_REF_CHIP_FONT_SCALE|messageRefChip/, "the local font scale is retired");
    assert.doesNotMatch(src, /\bMSG_REF_CHIP\b(?!\w)/, "old MSG_REF_CHIP box must stay retired");
    assert.doesNotMatch(src, /inline-block max-w-full overflow-hidden text-ellipsis/);
  }
  assert.match(referenceChip, /className="cursor-default"/);

  assert.match(source, /<MessageReferenceChip\s+variant="link"/);
  assert.match(source, /<MessageReferenceChip\s+variant="accent"/);
  assert.match(source, /<MessageReferenceText\s+variant="primary"/);
  assert.match(source, /cursor-wait opacity-80/);

  // The permalink chip renders through ReferenceChip with the Link icon and the
  // in/out-of-server soft-signal color, plus the non-bold trailing "msg" badge.
  assert.match(source, /raftPermalink[\s\S]*?<ReferenceChip[\s\S]*?icon=\{Link\}/);
  assert.match(source, /raftPermalink[\s\S]*?variant="link"/);
  assert.match(source, /text-\[10px\] font-normal leading-none text-foreground-placeholder/);

  // Comment ref chips render through ReferenceChip with the MessageSquare icon
  // and the stone color (distinct from the permalink's soft-signal, per stdrc).
  // The anchor label is carried inside the single `label` string (rendered in
  // ReferenceChip's one truncating span), not in a separate shrink-0 trailing
  // span that can overflow the chip.
  assert.match(attachmentCommentRefChip, /<ReferenceChip[\s\S]*?icon=\{MessageSquare\}/);
  assert.match(attachmentCommentRefChip, /data-message-affordance="attachment-comment-ref-chip"/);
  assert.match(attachmentCommentRefChip, /variant="muted"/);
  assert.match(
    attachmentCommentRefChip,
    /const detail = `\$\{commentRef\.filename\}\$\{commentRef\.anchorLabel \? ` · \$\{commentRef\.anchorLabel\}` : ""\}`/,
  );
  assert.match(attachmentCommentRefChip, /const label = formatMessage\(\{ id: "message\.attachment\.rePrefix" \}, \{ name: detail \}\)/);
  assert.match(referenceChip, /<span className="min-w-0 truncate">\{label\}<\/span>/);
  assert.doesNotMatch(attachmentCommentRefChip, /commentRef\.anchorLabel \? <span className="shrink-0 whitespace-nowrap">/);
  assert.match(attachmentComments, /data-message-affordance="attachment-comment-anchor"[\s\S]*?className="[^"]*overflow-hidden[^"]*"[\s\S]*?<span className="min-w-0 truncate">/);
  assert.match(attachmentComments, /data-message-affordance="attachment-comment-pending-anchor"[\s\S]*?className="[^"]*overflow-hidden[^"]*"[\s\S]*?<span className="min-w-0 truncate">/);

  // MentionLink self-mention chip composes the SAME box (Huarong blocker).
  assert.match(mention, /variant=\{isSelfMention \? "primary" : "secondary"\}/);

  // No chip (in either renderer) may re-inline the old box or a link-hand cursor.
  assert.doesNotMatch(source, /inline-block border border-black[^"`]*leading-\[21px\]/);
  assert.doesNotMatch(mention, /inline-block border border-black[^"`]*leading-\[21px\]/);
  assert.doesNotMatch(attachmentCommentRefChip, /inline-block border border-black[^"`]*leading-\[21px\]/);
  assert.doesNotMatch(source, /cursor-pointer/);
  assert.doesNotMatch(mention, /cursor-pointer/);
  assert.doesNotMatch(attachmentCommentRefChip, /cursor-pointer/);
  assert.doesNotMatch(source, /dataTaskRef[\s\S]*?bg-brutal-lime/);
  assert.doesNotMatch(taskRefSection, /inline-flex/);
  assert.doesNotMatch(taskRefSection, /font-mono text-sm/);
  assert.doesNotMatch(taskRefSection, /py-0\.5/);
  assert.doesNotMatch(taskRefSection, /leading-none/);
  assert.doesNotMatch(taskRefSection, /border-2/);
  assert.doesNotMatch(source, /inline-flex h-5 items-center/);
});

test("MessageItem permalink chip uses onOpenPermalink without cross-server branching (B1 / 73dddf321)", () => {
  const source = readFileSync(new URL("../src/components/message/MessageItem.tsx", import.meta.url), "utf8");

  // Verify staging 73dddf321 fix: cross-server permalinks must not branch on isCurrentServer
  assert.doesNotMatch(source, /const _?isCurrentServer =/);
  assert.doesNotMatch(source, /if \(_?isCurrentServer\)/);
  assert.match(source, /onOpenPermalink\?\.(\(href\)|href)/);
});
