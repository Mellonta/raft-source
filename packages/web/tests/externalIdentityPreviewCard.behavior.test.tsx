import "./helpers/domSetup";
import "./helpers/installResizeObserver";
import assert from "node:assert/strict";
import { act } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import ExternalIdentityPreviewCard from "../src/components/message/ExternalIdentityPreviewCard";
import { renderWithIntl } from "./helpers/intl";

afterEach(() => {
  cleanup();
});

function renderSlackIdentity() {
  let navigationCount = 0;
  renderWithIntl(
    <ExternalIdentityPreviewCard
      displayName="Ada Lovelace"
      provider="slack"
      workspaceName="Analytical Engines"
      actorKind="human"
      avatarUrl="https://cdn.example.test/ada.png"
      testId="slack-sender-avatar"
      onNavigate={() => { navigationCount += 1; }}
    />,
  );
  return {
    trigger: screen.getByRole("button", { name: "View Ada Lovelace's external identity" }),
    navigationCount: () => navigationCount,
  };
}

test("clicking an external sender avatar navigates to standard identity detail instead of pinning the hover card", async () => {
  const { trigger, navigationCount } = renderSlackIdentity();

  assert.ok(screen.queryByTestId("external-identity-preview") === null);
  assert.equal(trigger.dataset.avatarKind, "external");
  assert.equal(trigger.dataset.avatarSource, "external-avatar");

  fireEvent.click(trigger);
  assert.equal(navigationCount(), 1);
  assert.ok(screen.queryByTestId("external-identity-preview") === null);
});

test("hovering an external sender avatar opens the same identity preview", async () => {
  const { trigger, navigationCount } = renderSlackIdentity();

  fireEvent.mouseEnter(trigger);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });

  const preview = await screen.findByTestId("external-identity-preview");
  assert.match(preview.textContent ?? "", /Ada Lovelace/);
  assert.match(preview.textContent ?? "", /Slack · Human/);
  assert.match(preview.textContent ?? "", /From Analytical Engines/);
  assert.match(preview.textContent ?? "", /External identity/);
  assert.ok(preview.querySelector("a") === null, "external projections must not link to a Raft profile");
  assert.equal(navigationCount(), 0);

  fireEvent.mouseLeave(trigger);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 140));
  });
  await waitFor(() => assert.ok(screen.queryByTestId("external-identity-preview") === null));
});

test("external identity preview localizes its accessible label and actor kind", async () => {
  renderWithIntl(
    <ExternalIdentityPreviewCard
      displayName="访客甲"
      provider="slack"
      workspaceName="示例工作区"
      actorKind="guest"
      avatarUrl={null}
      onNavigate={() => {}}
    />,
    { locale: "zh-cn" },
  );

  const trigger = screen.getByRole("button", { name: "查看 访客甲 的外部身份" });
  assert.equal(trigger.dataset.avatarSource, "placeholder");
  fireEvent.mouseEnter(trigger);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });

  const preview = await screen.findByTestId("external-identity-preview");
  assert.match(preview.textContent ?? "", /Slack · 访客/);
  assert.match(preview.textContent ?? "", /来自 示例工作区/);
  assert.match(preview.textContent ?? "", /外部身份/);
});

test("historical external messages without a frozen workspace name omit that row", async () => {
  renderWithIntl(
    <ExternalIdentityPreviewCard
      displayName="Historical Sender"
      provider="slack"
      workspaceName={null}
      actorKind="human"
      avatarUrl={null}
      onNavigate={() => {}}
    />,
  );

  fireEvent.mouseEnter(screen.getByRole("button", { name: "View Historical Sender's external identity" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  const preview = await screen.findByTestId("external-identity-preview");
  assert.doesNotMatch(preview.textContent ?? "", /From /);
  assert.doesNotMatch(preview.textContent ?? "", /workspace-opaque-id/);
});
