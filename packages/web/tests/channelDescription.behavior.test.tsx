import assert from "node:assert/strict";
import { cleanup, render, screen } from "@testing-library/react";
import ChannelDescription, {
  segmentChannelDescription,
} from "../src/components/channel/ChannelDescription";

afterEach(cleanup);

test("channel descriptions render complete HTTP URLs as quiet safe inline links", () => {
  const description = "Guide: https://docs.example.com/guide_(v2)). Ask in www.example.com.";
  const view = render(<ChannelDescription description={description} />);

  const link = screen.getByRole("link", { name: "https://docs.example.com/guide_(v2)" });
  assert.equal(link.getAttribute("href"), "https://docs.example.com/guide_(v2)");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(view.container.textContent, description);
  assert.equal(screen.queryByRole("link", { name: "www.example.com" }), null);

  for (const className of [
    "underline",
    "decoration-black/30",
    "hover:text-black/80",
    "focus-visible:bg-primary-soft",
    "focus-visible:outline-2",
  ]) {
    assert.ok(link.classList.contains(className), `link must retain ${className}`);
  }

  const wrappingOwner = link.parentElement;
  assert.ok(wrappingOwner?.classList.contains("line-clamp-2"));
  assert.ok(wrappingOwner?.classList.contains("[overflow-wrap:anywhere]"));
  assert.ok(wrappingOwner?.classList.contains("[@media(max-height:600px)]:line-clamp-1"));
});

test("channel description URL segmentation preserves punctuation and rejects incomplete schemes", () => {
  assert.deepEqual(
    segmentChannelDescription("See https://example.com/path?q=1，then http:// and https://."),
    [
      { kind: "text", value: "See " },
      { kind: "link", value: "https://example.com/path?q=1" },
      { kind: "text", value: "，then http:// and https://." },
    ],
  );
});

test("channel description URLs stop before adjacent CJK text and non-URL separators", () => {
  const cases = [
    ["https://raft.dev是官网", "https://raft.dev", "https://raft.dev/"],
    ["链接https://raft.dev/docs、PRD", "https://raft.dev/docs", "https://raft.dev/docs"],
    ["周报：https://notion.so/weekly|每周一更新", "https://notion.so/weekly", "https://notion.so/weekly"],
    ["看 https://a.com——然后", "https://a.com", "https://a.com/"],
    ["看 https://a.com…然后", "https://a.com", "https://a.com/"],
  ] as const;

  for (const [description, linkText, expectedHref] of cases) {
    const view = render(<ChannelDescription description={description} />);
    const link = screen.getByRole("link", { name: linkText }) as HTMLAnchorElement;
    assert.equal(link.href, expectedHref);
    assert.equal(view.container.textContent, description);
    view.unmount();
  }
});
