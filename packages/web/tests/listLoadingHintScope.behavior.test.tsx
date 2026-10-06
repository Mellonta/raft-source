import assert from "node:assert/strict";
import { cleanup, render, screen } from "@testing-library/react";
import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import HistoryTopState from "../src/components/message/HistoryTopState";

// Task #503: "is the CONVERSATION list itself loading?"
//
// The e2e assertion used to answer that with `scroller.textContent.includes("Loading")`.
// A natural failure proved it was a false positive: the single match was a message
// row whose text was an attachment's loading label ("Loading <filename>"). Message
// bodies and attachment states legitimately contain the word "Loading".
//
// The reader is now scoped to markers on the list's OWN pagination hints:
//   list-loading-older   header, HistoryTopState(noun="messages")
//   list-loading-newer   footer, ChatPanel channelFooter
//   thread-loading-*     thread panel — deliberately distinct, so a thread's hint
//                        can never be reported as the parent conversation loading
//
// These tests verify the REAL components. They deliberately do not re-implement
// the e2e predicate: a copy stays green even if the e2e callback is reverted, so it
// would prove nothing about the code that actually runs in CI.

afterEach(cleanup);

test("conversation header hint exposes list-loading-older while loading", () => {
  render(
    <HistoryTopState hasMore historyLimited={false} loadingOlder noun="messages" />,
    { wrapper: TestIntlProvider },
  );

  const hint = screen.queryByTestId("list-loading-older");
  assert.ok(hint, "conversation pagination hint must expose list-loading-older");
  assert.match(hint.textContent ?? "", /Loading older messages/);
});

test("conversation header hint exposes no marker when it is not loading", () => {
  render(
    <HistoryTopState hasMore historyLimited={false} loadingOlder={false} noun="messages" />,
    { wrapper: TestIntlProvider },
  );

  // The negative direction: the same component in the same state must not present
  // the marker, otherwise the assertion could never distinguish loading from idle.
  assert.equal(screen.queryByTestId("list-loading-older"), null);
});

test("thread header hint uses a distinct marker, not the conversation one", () => {
  render(
    <HistoryTopState hasMore historyLimited={false} loadingOlder noun="replies" />,
    { wrapper: TestIntlProvider },
  );

  assert.ok(
    screen.queryByTestId("thread-loading-older"),
    "thread pagination hint must expose thread-loading-older",
  );
  assert.equal(
    screen.queryByTestId("list-loading-older"),
    null,
    "a thread hint must never be reported as the parent conversation list loading",
  );
});
