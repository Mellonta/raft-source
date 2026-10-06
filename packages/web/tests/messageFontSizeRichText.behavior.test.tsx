import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { TestIntlProvider } from "./helpers/intl";

Object.assign(globalThis, { React });

const { default: MarkdownContent } = await import("../src/components/markdown/MarkdownContent");
const { AttachmentCommentRefChip } = await import("../src/components/message/AttachmentCommentRefChip");

test("message rich text tokens inherit the message font-size scale", () => {
  const html = renderToStaticMarkup(
    <TestIntlProvider>
      <div className="text-[18px]">
        <MarkdownContent
          source={[
            "# Primary heading",
            "",
            "## Secondary heading",
            "",
            "### Tertiary heading",
            "",
            "Inline `code` keeps the message body scale.",
            "",
            "| A | B |",
            "| - | - |",
            "| 1 | 2 |",
            "",
            "```ts",
            "const scaled = true;",
            "```",
          ].join("\n")}
        />
      </div>
    </TestIntlProvider>,
  );

  const inheritedTokenCount = html.match(/\[font-size:inherit\]/g)?.length ?? 0;
  assert.equal(inheritedTokenCount, 2);
  assert.match(html, /<h1\b[^>]*class="[^"]*text-\[1\.286em\][^"]*"[^>]*>Primary heading<\/h1>/);
  assert.match(html, /<h2\b[^>]*class="[^"]*text-\[1\.143em\][^"]*"[^>]*>Secondary heading<\/h2>/);
  assert.match(html, /<h3\b[^>]*class="[^"]*text-\[1\.071em\][^"]*"[^>]*>Tertiary heading<\/h3>/);
  assert.match(html, /<pre class="(?=[^"]*\[font-size:inherit\])(?=[^"]*font-mono)[^"]*"/);
  assert.match(
    html,
    /<code\b[^>]*class="(?=[^"]*\[font-size:0\.875em\])(?=[^"]*leading-\[1\.3em\])(?=[^"]*font-mono)[^"]*"/,
  );
  assert.match(html, /<table class="[^"]*\[font-size:inherit\][^"]*"/);

  // Reference chips take the body size from the RUI message-reference recipe
  // (raft-ui 0.5.16, #319), so they follow the font-size preference with no
  // local scale.
});

test("attachment comment-ref chip scales with the message body font-size preference", () => {
  const html = renderToStaticMarkup(
    <TestIntlProvider>
      <AttachmentCommentRefChip
        commentRef={{
          attachmentId: "att-1",
          filename: "notes.txt",
          hostMessageId: "host-1",
          hostSource: { type: "channel", routeKind: "channel", channelId: "chan-1" },
          anchorLabel: null,
          anchorQuote: null,
        }}
        commentsEnabled={true}
        onJumpToHost={() => {}}
        bodyFontSizeClass="text-[13px]"
      />
    </TestIntlProvider>,
  );

  // The chip wrapper carries the same font-size class the message body uses and
  // the chip inherits it (raft-ui 0.5.16 message-reference rule), so the "re:"
  // chip scales from the user's body size rather than the outer base size
  // (stdrc task #463).
  assert.match(html, /class="mb-0\.5 text-\[13px\]"/);
  assert.match(html, /\[font-size:inherit\]/);
  assert.doesNotMatch(html, /\[font-size:0\.875em\][^"]*"[^>]*data-slot="message-reference"/);
});
