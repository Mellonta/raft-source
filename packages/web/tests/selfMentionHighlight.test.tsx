import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, render, screen } from "@testing-library/react";
import MentionLink from "../src/components/message/MentionLink";
import { useAuthStore } from "../src/store/authStore";

// Independent of the product constant — this pins the RENDERED chip box.
// Since raft-ui 0.5.15 the box layout (inline-flex / gap / truncate / padding)
// comes from the RUI message-reference recipe; since 0.5.16 (#319) the recipe
// also owns size and the text-baseline alignment. MentionLink adds nothing to
// the box: task #708 measured that a local `align-middle` override sank every
// @mention 1.3px below the surrounding text (Brutal 1.55px). Vertical
// alignment is a layout fact jsdom cannot see — it is pinned in a real
// browser by tests/e2e/tests/message/mention-baseline.spec.ts.
const EXPECTED_SELF_MENTION_BOX_TOKENS = [
  "inline-flex",
  "max-w-full",
  "truncate",
  "border",
  "px-1",
  "py-0",
  "[font-size:inherit]",
  "leading-[1.2em]",
  "select-text",
] as const;

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null } as never);
});

function renderMention(
  mentionType: "user" | "agent",
  mentionId: string,
  label: string,
) {
  return render(
    <MentionLink mentionType={mentionType} mentionId={mentionId} onNavigate={() => undefined}>
      {label}
    </MentionLink>,
  );
}

test("self mention uses the inbox mention-you yellow treatment", () => {
  useAuthStore.setState({ user: { id: "user-self", name: "self" } } as never);
  renderMention("user", "user-self", "@self");

  const chip = screen.getByText("@self");
  assert.match(
    chip.className,
    /(^|\s)bg-primary(\s|$)/,
    "self mention must use the semantic primary-soft fill",
  );
  for (const token of EXPECTED_SELF_MENTION_BOX_TOKENS) {
    assert.match(
      chip.className,
      new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`),
      `self mention must keep box token ${token}`,
    );
  }
  assert.doesNotMatch(chip.className, /leading-\[21px\]/);
});

test("agent mentions never use the self-mention highlight", () => {
  useAuthStore.setState({ user: { id: "user-self", name: "self" } } as never);
  renderMention("agent", "user-self", "@agent");
  const agent = screen.getByText("@agent");
  assert.doesNotMatch(agent.className, /(^|\s)bg-soft-signal(\s|$)/, "agent mentions must not pick up the self-mention fill");
  assert.match(agent.className, /underline/);
  cleanup();

  renderMention("user", "user-other", "@other");
  const other = screen.getByText("@other");
  assert.doesNotMatch(other.className, /(^|\s)bg-soft-signal(\s|$)/, "other-human mentions stay underlined, not yellow");
  assert.match(other.className, /underline/);
});
