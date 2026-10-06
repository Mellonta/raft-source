import assert from "node:assert/strict";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttachmentCommentRefChip,
} from "../src/components/message/AttachmentCommentRefChip";
import type { Message } from "../src/store/messageStore";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => cleanup());

function makeCommentRef(
  overrides: Partial<NonNullable<Message["commentRef"]>> = {},
): NonNullable<Message["commentRef"]> {
  return {
    attachmentId: "attachment-1",
    filename: "flagged.txt",
    hostMessageId: "host-message-1",
    hostSource: null,
    anchorLabel: null,
    anchorQuote: null,
    ...overrides,
  };
}

function renderChip(
  commentRef: Message["commentRef"] | null | undefined,
  commentsEnabled: boolean,
): string {
  return renderToStaticMarkup(
    <TestIntlProvider>
      <AttachmentCommentRefChip
        commentRef={commentRef}
        commentsEnabled={commentsEnabled}
        onJumpToHost={() => {}}
      />
    </TestIntlProvider>,
  );
}

test("AttachmentCommentRefChip renders when the message has a comment ref and the feature flag allows it", () => {
  const html = renderChip(makeCommentRef(), true);

  assert.match(html, /data-message-affordance="attachment-comment-ref-chip"/);
  assert.match(html, /bg-brutal-stone\/25/);
  assert.match(html, /data-base-ui-tooltip-trigger/);
  assert.match(html, /re: flagged\.txt/);
  assert.doesNotMatch(html, /Stryker was here!/);
});

test("AttachmentCommentRefChip suppresses the ref when the feature flag denies it", () => {
  assert.equal(renderChip(makeCommentRef(), false), "");
});

test("AttachmentCommentRefChip suppresses the ref when the message has no comment ref", () => {
  assert.equal(renderChip(null, true), "");
});

test("AttachmentCommentRefChip includes anchor labels in visible text and titles", () => {
  const html = renderChip(makeCommentRef({ anchorLabel: "line 7" }), true);

  assert.match(html, /data-base-ui-tooltip-trigger/);
  assert.match(html, /re: flagged\.txt · line 7/);
});

test("AttachmentCommentRefChip host links include jump copy and call the jump handler", () => {
  let jumpCount = 0;
  render(
    <TestIntlProvider>
      <AttachmentCommentRefChip
        commentRef={makeCommentRef({
          anchorLabel: "cell A1",
          hostSource: "message",
        })}
        commentsEnabled={true}
        onJumpToHost={() => {
          jumpCount += 1;
        }}
      />
    </TestIntlProvider>,
  );
  const link = document.querySelector('[data-message-affordance="attachment-comment-ref-chip"]');
  assert.ok(link.hasAttribute("data-base-ui-tooltip-trigger"), "jump hint now rides the RUI tooltip trigger");
  assert.match(link.className, /bg-brutal-stone\/25/);
  fireEvent.click(link);
  assert.equal(jumpCount, 1);
});

test("AttachmentCommentRefChip host links omit anchor-label fallback copy when no anchor label exists", () => {
  render(
    <TestIntlProvider>
      <AttachmentCommentRefChip
        commentRef={makeCommentRef({ hostSource: "message" })}
        commentsEnabled={true}
        onJumpToHost={() => {}}
      />
    </TestIntlProvider>,
  );
  const link = document.querySelector('[data-message-affordance="attachment-comment-ref-chip"]');
  assert.ok(link.hasAttribute("data-base-ui-tooltip-trigger"), "jump hint now rides the RUI tooltip trigger");
  assert.doesNotMatch(link.outerHTML, /Stryker was here!/);
});
