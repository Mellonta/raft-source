import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import type { RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";

import api from "../src/api/client";
import RuntimeAccountUsageChip, {
  RuntimeAccountUsageGateChip,
} from "../src/components/machine/RuntimeAccountUsageChip";
import { useServerStore } from "../src/store/serverStore";
import {
  resetServerFeatureFlagsForTests,
} from "../src/store/serverFeatureFlags";
import {
  RuntimeAccountUsageClient,
} from "../src/utils/runtimeAccountUsageClient";
import type { RuntimeAccountUsageReadResult } from "../src/utils/runtimeAccountUsageClient";
import type { RuntimeAccountUsageRefreshResult } from "../src/utils/runtimeAccountUsageClient";
import { renderWithIntl as render, TestIntlProvider } from "./helpers/intl";

function matchMediaForViewport(mobile: boolean): typeof window.matchMedia {
  return ((query: string) => ({
    matches: query.includes("max-width: 767px") ? mobile : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

window.matchMedia = matchMediaForViewport(false);

function setMobileViewport() {
  window.matchMedia = matchMediaForViewport(true);
}

function setDesktopViewport() {
  window.matchMedia = matchMediaForViewport(false);
}

globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number);
globalThis.cancelAnimationFrame ??= ((handle: number) => clearTimeout(handle));

const originalPost = api.post;
const initialServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.post = originalPost;
  setDesktopViewport();
  resetServerFeatureFlagsForTests();
  useServerStore.setState(initialServerState, true);
});

function snapshot(
  health: RuntimeAccountUsageSnapshot["accounts"][number]["health"] = "ok",
  usedRatio = 0.75,
): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "codex",
    collectedAt: "2026-08-02T01:00:00.000Z",
    staleAfter: "2026-08-02T01:15:00.000Z",
    collectorVersion: "test",
    sourceVersion: "codex-test",
    accounts: [{
      accountKey: "a".repeat(64),
      maskedLabel: "tea****r@example.com",
      planLabel: "Team",
      health,
      windows: [{
        id: "five-hour",
        label: "5 hours",
        status: "ok",
        usedRatio,
        resetsAt: "2026-08-02T02:00:00.000Z",
      }],
    }],
  };
}

function clientFor(
  read: () => Promise<RuntimeAccountUsageReadResult>,
  refresh: () => Promise<RuntimeAccountUsageRefreshResult>,
) {
  return new RuntimeAccountUsageClient(async () => read(), async () => refresh());
}

test("standard badge appearance survives usage gating and provider availability", async () => {
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => ({ accepted: true, state: "requested" }),
  );
  for (const scenario of [
    { enabled: false, serverId: "server-1", runtimeId: "codex", tag: "SPAN" },
    { enabled: true, serverId: null, runtimeId: "codex", tag: "SPAN" },
    { enabled: true, serverId: "server-1", runtimeId: "unsupported", tag: "SPAN" },
    { enabled: true, serverId: "server-1", runtimeId: "codex", tag: "BUTTON" },
  ]) {
    const view = render(
      <RuntimeAccountUsageGateChip
        enabled={scenario.enabled}
        serverId={scenario.serverId}
        runtimeId={scenario.runtimeId}
        machineId="machine-1"
        appearance="outline"
        variant="information"
        client={client}
      >
        Runtime label
      </RuntimeAccountUsageGateChip>,
    );
    const badge = screen.getByText("Runtime label");
    assert.equal(badge.tagName, scenario.tag);
    assert.equal(badge.getAttribute("data-slot"), "badge");
    assert.equal(badge.getAttribute("data-appearance"), "outline");
    assert.equal(badge.getAttribute("data-variant"), "information");
    await act(async () => {});
    view.unmount();
  }
});

test("ineligible or serverless runtime chips remain inert RUI badges with zero usage requests", () => {
  let reads = 0;
  let refreshes = 0;
  const client = clientFor(
    async () => { reads += 1; return { state: "fresh", snapshot: snapshot() }; },
    async () => { refreshes += 1; return { accepted: true, state: "requested" }; },
  );

  const view = render(
    <RuntimeAccountUsageGateChip
      enabled={false}
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageGateChip>,
  );

  const chip = screen.getByText("Codex");
  fireEvent.mouseEnter(chip);
  fireEvent.focus(chip);
  assert.equal(chip.tagName, "SPAN");
  assert.equal(chip.getAttribute("data-slot"), "badge", "inert runtime chips use the RUI Badge primitive");
  assert.equal(reads, 0);
  assert.equal(refreshes, 0);

  view.rerender(
    <RuntimeAccountUsageGateChip
      enabled
      runtimeId="codex"
      serverId={null}
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageGateChip>,
  );
  assert.equal(screen.getByText("Codex").tagName, "SPAN");
  assert.equal(reads, 0);
});

test("runtime usage health indicator uses the RUI Status primitive with a circular, centered dot", async () => {
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  await waitFor(() => assert.ok(screen.getByLabelText("Usage healthy")));
  const trigger = screen.getByRole("button", { name: "Codex" });
  const indicator = screen.getByTestId("runtime-usage-health-codex");
  assert.equal(trigger.getAttribute("data-slot"), "badge", "interactive runtime chips use the RUI Badge primitive");
  assert.equal(indicator.getAttribute("data-slot"), "status", "usage health uses the RUI Status primitive");
  assert.equal(indicator.getAttribute("data-size"), "sm", "usage health owns the RUI Status size prop");
  assert.match(indicator.className, /rounded-full/, "the usage dot is circular");
  assert.match(indicator.className, /size-2/, "the usage dot uses the larger size");
  assert.match(trigger.className, /items-center/, "the badge aligns its text and dot on the cross axis");
  assert.match(indicator.className, /items-center|inline-block/, "the status indicator stays inline with the badge label");
});

test("eligible runtime chips load usage without a feature-flag evaluation", async () => {
  let reads = 0;
  let refreshes = 0;
  api.post = (async () => new Promise<never>(() => undefined)) as typeof api.post;
  useServerStore.setState({
    current: { id: "server-1", slug: "acme", name: "Acme", role: "admin" },
  } as never);
  const client = clientFor(
    async () => { reads += 1; return { state: "fresh", snapshot: snapshot() }; },
    async () => { refreshes += 1; return { accepted: true, state: "requested" }; },
  );

  const view = render(
    <RuntimeAccountUsageGateChip
      enabled
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageGateChip>,
  );

  const enabledChip = await screen.findByRole("button", { name: "Codex" });
  await waitFor(() => assert.equal(reads, 1));
  fireEvent.focus(enabledChip);
  await waitFor(() => assert.ok(screen.getByRole("dialog", { name: "Codex runtime account usage" })));
  assert.equal(refreshes, 0);

  view.unmount();
});

test("focus opens a cache-only usage surface and repeated opens share the read cache", async () => {
  let reads = 0;
  const client = clientFor(
    async () => { reads += 1; return { state: "fresh", snapshot: snapshot() }; },
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  const trigger = screen.getByRole("button", { name: "Codex" });
  fireEvent.focus(trigger);
  await waitFor(() => assert.ok(screen.getByText("Team")));
  assert.ok(screen.getByText("tea****r@example.com"), "the sanitized account label is visible in the mounted usage surface");
  assert.ok(screen.getByText(/75% used/));
  assert.ok(screen.getByLabelText("Usage healthy"));
  assert.equal(reads, 1);
  assert.doesNotMatch(document.body.textContent ?? "", /a{64}/, "opaque account keys never render");

  fireEvent.focus(trigger);
  await waitFor(() => assert.equal(reads, 1));
});

test("Codex, Claude, and Kimi usage surfaces show their current runtime version", async () => {
  const cases = [
    { runtimeId: "codex", label: "Codex", version: "0.75.1", provider: "codex" },
    { runtimeId: "claude", label: "Claude", version: "1.0.83", provider: "claude" },
    { runtimeId: "kimi-sdk", label: "Kimi", version: "0.34.0-botiverse.0", provider: "kimi" },
  ] as const;

  for (const runtime of cases) {
    const client = clientFor(
      async () => ({ state: "fresh", snapshot: snapshot() }),
      async () => { throw new Error("refresh should not run for a fresh snapshot"); },
    );
    const view = render(
      <RuntimeAccountUsageChip
        runtimeId={runtime.runtimeId}
        runtimeVersion={runtime.version}
        serverId="server-1"
        machineId="machine-1"
        className="runtime-chip"
        client={client}
      >
        {runtime.label}
      </RuntimeAccountUsageChip>,
    );

    fireEvent.focus(screen.getByRole("button", { name: runtime.label }));
    await waitFor(() => assert.equal(
      screen.getByTestId(`runtime-version-${runtime.provider}`).textContent,
      `Version ${runtime.version}`,
    ));
    view.unmount();
  }
});

test("runtime usage surface says when the runtime version is unavailable", async () => {
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );
  render(
    <RuntimeAccountUsageChip
      runtimeId="claude"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Claude
    </RuntimeAccountUsageChip>,
  );

  fireEvent.focus(screen.getByRole("button", { name: "Claude" }));
  await waitFor(() => assert.equal(screen.getByTestId("runtime-version-claude").textContent, "Version unavailable"));
});

test("an account without a masked email is identified by its display name", async () => {
  const phone = snapshot();
  delete phone.accounts[0]!.maskedLabel;
  phone.accounts[0]!.displayName = "登月者8387";
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: phone }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip runtimeId="claude" serverId="server-1" machineId="machine-1" className="runtime-chip" client={client}>
      Claude
    </RuntimeAccountUsageChip>,
  );

  fireEvent.focus(screen.getByRole("button", { name: "Claude" }));
  const label = await screen.findByTestId("runtime-account-masked-label");
  assert.equal(label.textContent, "登月者8387");
});

test("a masked email wins over a display name", async () => {
  const both = snapshot();
  both.accounts[0]!.displayName = "登月者8387";
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: both }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip runtimeId="claude" serverId="server-1" machineId="machine-1" className="runtime-chip" client={client}>
      Claude
    </RuntimeAccountUsageChip>,
  );

  fireEvent.focus(screen.getByRole("button", { name: "Claude" }));
  const label = await screen.findByTestId("runtime-account-masked-label");
  assert.equal(label.textContent, "tea****r@example.com");
});

test("a usable percent remains visible when only reset metadata is unavailable", async () => {
  const partial = snapshot();
  delete partial.accounts[0]!.windows[0]!.resetsAt;
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: partial }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="claude"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Claude
    </RuntimeAccountUsageChip>,
  );

  fireEvent.focus(screen.getByRole("button", { name: "Claude" }));
  await waitFor(() => assert.ok(screen.getByText("75% used · reset time unavailable")));
  assert.ok(screen.queryByText("Usage format unavailable") === null);
  assert.ok(document.querySelector('[role="progressbar"][aria-valuenow="75"]'));
});

test("mount silently refreshes a missing snapshot and follows through until the result is visible", async () => {
  let reads = 0;
  let refreshes = 0;
  const client = clientFor(
    async () => {
      reads += 1;
      return reads === 1
        ? { state: "missing", snapshot: null }
        : { state: "fresh", snapshot: snapshot() };
    },
    async () => { refreshes += 1; return { accepted: true, state: "requested" }; },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  await waitFor(() => assert.equal(refreshes, 1));
  await waitFor(() => assert.ok(screen.getByLabelText("Usage healthy")), { timeout: 3_000 });
  assert.equal(reads, 2);
  assert.ok(screen.queryByText("No snapshot yet") === null);
  assert.ok(screen.queryByLabelText("Usage needs attention") === null);
});

test("poll exhaustion is explicit instead of impersonating a server cooldown", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let reads = 0;
  let refreshes = 0;
  const client = clientFor(
    async () => { reads += 1; return { state: "missing", snapshot: null }; },
    async () => { refreshes += 1; return { accepted: true, state: "requested" }; },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Codex" }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(refreshes, 1);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1_200);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  assert.equal(reads, 9);
  assert.ok(screen.getByText("Refresh sent, but no update was observed"));
  assert.ok(screen.queryByText("Refresh cooling down") === null);
});

test("a server cooldown still follows an earlier in-flight refresh to fresh", async () => {
  let reads = 0;
  const client = clientFor(
    async () => {
      reads += 1;
      return reads === 1
        ? { state: "missing", snapshot: null }
        : { state: "fresh", snapshot: snapshot() };
    },
    async () => ({ accepted: false, state: "cooldown" }),
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  await waitFor(() => assert.ok(screen.getByLabelText("Usage healthy")), { timeout: 3_000 });
  assert.equal(reads, 2);
});

test("click pins the desktop usage surface until explicit close or outside click", async () => {
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  const trigger = screen.getByRole("button", { name: "Codex" });
  fireEvent.click(trigger);
  await waitFor(() => assert.ok(screen.getByRole("dialog", { name: "Codex runtime account usage" })));

  fireEvent.mouseLeave(trigger);
  fireEvent.blur(trigger);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  assert.ok(screen.getByRole("dialog", { name: "Codex runtime account usage" }));

  fireEvent.pointerDown(document.body);
  await waitFor(() => assert.ok(screen.queryByRole("dialog", { name: "Codex runtime account usage" }) === null));
});

test("the usage surface declares itself a dismiss layer only while pinned (hover/focus-open opts out despite role=dialog)", async () => {
  // Cross-end contract: the desktop shell suspends its title-bar drag region
  // while any dismiss-on-outside layer is open. A hover / focus-opened card is
  // not one (it closes on mouse-out) but keeps role="dialog", so it must carry
  // the explicit opt-out; pinning it turns it into a real outside-press layer.
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );
  render(
    <RuntimeAccountUsageChip runtimeId="codex" serverId="server-1" machineId="machine-1" className="runtime-chip" client={client}>
      Codex
    </RuntimeAccountUsageChip>,
  );
  const trigger = screen.getByRole("button", { name: "Codex" });
  fireEvent.focus(trigger);
  const hoverCard = await waitFor(() => screen.getByRole("dialog", { name: "Codex runtime account usage" }));
  assert.ok(hoverCard.getAttribute("data-dismiss-layer") === "false", "focus-open: explicit opt-out");

  fireEvent.click(trigger);
  await waitFor(() => assert.ok(screen.getByRole("dialog", { name: "Codex runtime account usage" }).getAttribute("data-dismiss-layer") === "", "pinned: declared dismiss layer"));

  fireEvent.pointerDown(document.body);
  await waitFor(() => assert.ok(screen.queryByRole("dialog", { name: "Codex runtime account usage" }) === null));
});

// Rerender-safe mount: the intl context goes in as RTL's `wrapper` so a later
// `rerender()` keeps the exact same tree shape (a wrapper element inside the
// rendered `ui` would change depth on rerender and REMOUNT the chip, silently
// wiping the state these tests are about).
function chip(props: { machineId?: string; client: ReturnType<typeof clientFor> }) {
  return (
    <RuntimeAccountUsageChip runtimeId="codex" serverId="server-1" machineId={props.machineId ?? "machine-1"} className="runtime-chip" client={props.client}>
      Codex
    </RuntimeAccountUsageChip>
  );
}
function mountChip(props: { machineId?: string; client: ReturnType<typeof clientFor> }) {
  return renderBare(chip(props), { wrapper: TestIntlProvider });
}

const dialogMarker = () => screen.getByRole("dialog", { name: "Codex runtime account usage" }).getAttribute("data-dismiss-layer");

async function expectUnpinnedCloseOnLeave(trigger: HTMLElement) {
  // An unpinned card is hover-governed: leaving closes it after the delay.
  fireEvent.mouseLeave(trigger);
  fireEvent.blur(trigger);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  assert.ok(screen.queryByRole("dialog", { name: "Codex runtime account usage" }) === null, "unpinned card closed on leave");
}

test("a pin is invalidated by a subject change and does not come back when the subject returns (A → B → A)", async () => {
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );
  const view = mountChip({ client });
  const trigger = screen.getByRole("button", { name: "Codex" });
  fireEvent.click(trigger);
  await waitFor(() => assert.ok(dialogMarker() === "", "pinned on A"));

  // The card stays open across a subject change (open state is not the pin);
  // the pin itself is invalid the moment the subject differs.
  view.rerender(chip({ client, machineId: "machine-2" }));
  await waitFor(() => assert.ok(dialogMarker() === "false", "subject B: the A pin is invalid"));

  view.rerender(chip({ client, machineId: "machine-1" }));
  await waitFor(() => assert.ok(dialogMarker() === "false", "back on A: the old pin must not resurrect"));
  await expectUnpinnedCloseOnLeave(trigger);
});

test("swapping the client instance alone invalidates the pin, matching the effect that re-keys the subject", async () => {
  const mk = () => clientFor(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );
  const view = mountChip({ client: mk() });
  const trigger = screen.getByRole("button", { name: "Codex" });
  fireEvent.click(trigger);
  await waitFor(() => assert.ok(dialogMarker() === "", "pinned"));

  view.rerender(chip({ client: mk() }));
  await waitFor(() => assert.ok(dialogMarker() === "false", "new client: marker and ref agree — not pinned"));
  await expectUnpinnedCloseOnLeave(trigger);
});

test("mobile runtime usage chips ignore focus blur before the tap click opens the bottom sheet", async () => {
  setMobileViewport();
  let reads = 0;
  const client = clientFor(
    async () => { reads += 1; return { state: "fresh", snapshot: snapshot() }; },
    async () => { throw new Error("refresh should not run for a fresh snapshot"); },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  const trigger = screen.getByRole("button", { name: "Codex" });
  fireEvent.focus(trigger);
  assert.ok(screen.queryByTestId("runtime-usage-surface-codex") === null, "mobile focus must not open the sheet before the tap click");
  fireEvent.blur(trigger);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  assert.ok(screen.queryByTestId("runtime-usage-surface-codex") === null, "mobile focus/blur must not mount then auto-close the sheet before click");

  fireEvent.click(trigger);
  const surface = await screen.findByTestId("runtime-usage-surface-codex");
  await waitFor(() => assert.ok(screen.getByText("Team")));
  assert.equal(reads, 1);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  assert.ok(screen.getByTestId("runtime-usage-surface-codex"), "the old blur timer must not close the tapped-open mobile sheet");

  const backdrop = surface.parentElement?.parentElement;
  assert.ok(backdrop);
  fireEvent.click(backdrop);
  await waitFor(() => assert.ok(screen.queryByTestId("runtime-usage-surface-codex") === null));
});

test("stale state downgrades the whole snapshot and reauth hides last-known percentages", async () => {
  const staleClient = clientFor(
    async () => ({ state: "stale", snapshot: snapshot() }),
    async () => ({ accepted: false, state: "cooldown" }),
  );
  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={staleClient}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );
  fireEvent.focus(screen.getByRole("button", { name: "Codex" }));
  await waitFor(() => assert.ok(screen.getByText(/Stale snapshot/)));
  const staleIndicator = screen.getByTestId("runtime-usage-health-codex");
  assert.ok(screen.getByLabelText("Usage needs attention"));
  assert.equal(staleIndicator.getAttribute("data-variant"), "warning");
  assert.notEqual(staleIndicator.getAttribute("data-variant"), "success");

  cleanup();
  const reauthClient = clientFor(
    async () => ({ state: "fresh", snapshot: snapshot("reauth_required") }),
    async () => ({ accepted: false, state: "cooldown" }),
  );
  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={reauthClient}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );
  fireEvent.focus(screen.getByRole("button", { name: "Codex" }));
  await waitFor(() => assert.ok(screen.getByText(/Sign in again/)));
  const reauthIndicator = screen.getByTestId("runtime-usage-health-codex");
  assert.ok(screen.getByLabelText("Usage needs attention"));
  assert.equal(reauthIndicator.getAttribute("data-variant"), "warning");
  assert.notEqual(reauthIndicator.getAttribute("data-variant"), "success");
  assert.ok(screen.queryByText(/75% used/) === null);
});

for (const { provider, label } of [
  { provider: "codex" as const, label: "Codex" },
  { provider: "claude" as const, label: "Claude" },
  { provider: "kimi" as const, label: "Kimi" },
  { provider: "grok" as const, label: "Grok" },
]) {
  test(`${label} unsupported OAR readings do not claim an API endpoint or healthy usage`, async () => {
    const endpointSnapshot: RuntimeAccountUsageSnapshot = {
      protocolVersion: 2,
      provider,
      collectedAt: "2026-08-10T06:30:00.000Z",
      staleAfter: "2026-08-10T06:35:00.000Z",
      collectorVersion: "test",
      accounts: [{
        accountKey: "c".repeat(64),
        health: "unsupported",
        windows: [],
      }],
    };
    const client = clientFor(
      async () => ({ state: "fresh", snapshot: endpointSnapshot }),
      async () => ({ accepted: false, state: "cooldown" }),
    );

    render(
      <RuntimeAccountUsageChip
        runtimeId={provider}
        serverId="server-1"
        machineId="machine-1"
        className="runtime-chip"
        client={client}
      >
        {label}
      </RuntimeAccountUsageChip>,
    );

    await waitFor(() => assert.ok(screen.getByLabelText("Usage needs attention")));
    assert.ok(screen.queryByLabelText("Usage healthy") === null);
    fireEvent.focus(screen.getByRole("button", { name: label }));
    await waitFor(() => assert.ok(screen.getByText("unsupported")));
    assert.ok(screen.getByText("Account usage is unavailable for this runtime or sign-in method."));
    assert.ok(screen.queryByText("api endpoint") === null);
  });
}

test("Kimi OAR failures remain visible errors", async () => {
  const kimiSnapshot: RuntimeAccountUsageSnapshot = {
    protocolVersion: 2,
    provider: "kimi",
    collectedAt: "2026-08-10T06:30:00.000Z",
    staleAfter: "2026-08-10T06:35:00.000Z",
    collectorVersion: "test",
    accounts: [{
      accountKey: "b".repeat(64),
      health: "error",
      windows: [],
    }],
  };
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: kimiSnapshot }),
    async () => ({ accepted: false, state: "cooldown" }),
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="kimi"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Kimi
    </RuntimeAccountUsageChip>,
  );

  await waitFor(() => assert.ok(screen.getByLabelText("Usage needs attention")));
  assert.ok(screen.queryByLabelText("Usage healthy") === null);
  fireEvent.focus(screen.getByRole("button", { name: "Kimi" }));
  await waitFor(() => assert.ok(screen.getByText("error")));
  assert.ok(screen.queryByText("unable to detect") === null);
});

test("a consumed refresh window disables manual refresh and counts down (task #704)", async () => {
  let nowMs = 1_800_000_000_000;
  const client = new RuntimeAccountUsageClient(
    async () => ({ state: "fresh", snapshot: snapshot() }),
    async () => ({ accepted: true, state: "requested" }),
    () => nowMs,
  );
  // The panel's own auto-refresh (or a recent click) already consumed the
  // two-minute window before the user gets here.
  await client.refresh("server-1", "machine-1", "codex", "stale_or_missing");

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Codex" }));
  const refreshButton = await screen.findByRole("button", { name: "Refresh" });
  assert.equal(
    refreshButton.disabled,
    true,
    "a consumed window disables the button instead of refusing the click",
  );
  assert.ok(
    screen.getByText("Refresh again in ~120s"),
    "the footer explains the wait instead of the refused-click copy",
  );

  // The window drains: the next tick re-enables the button.
  nowMs += 120_000;
  await waitFor(() => assert.equal(refreshButton.disabled, false), { timeout: 3_000 });
  assert.ok(screen.queryByText("Refresh again in ~120s") === null, "the countdown disappears once the window drains");
});

test("a manual refresh that returns a fresh snapshot renders it in place without follow-up polling", async () => {
  let reads = 0;
  const refreshReasons: string[] = [];
  const initial = snapshot("ok", 0.75);
  delete initial.accounts[0]!.windows[0]!.resetsAt;
  const updated = snapshot("ok", 0.42);
  delete updated.accounts[0]!.windows[0]!.resetsAt;
  const client = new RuntimeAccountUsageClient(
    async () => {
      reads += 1;
      return { state: "fresh", snapshot: initial };
    },
    async (_url, body) => {
      refreshReasons.push((body as { reason?: string } | undefined)?.reason ?? "unknown");
      return { accepted: true, state: "fresh", snapshot: updated };
    },
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );
  fireEvent.focus(screen.getByRole("button", { name: "Codex" }));
  await waitFor(() => assert.ok(screen.getByText("75% used · reset time unavailable")));

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => assert.ok(screen.getByText("42% used · reset time unavailable")));
  assert.deepEqual(refreshReasons, ["manual"]);
  // The snapshot came back inline with the refresh response: no GET polling.
  assert.equal(reads, 1);
});

test("a timed-out manual refresh is explicit instead of looking unchanged", async () => {
  const initial = snapshot();
  delete initial.accounts[0]!.windows[0]!.resetsAt;
  const client = clientFor(
    async () => ({ state: "fresh", snapshot: initial }),
    async () => ({ accepted: true, state: "timeout" }),
  );

  render(
    <RuntimeAccountUsageChip
      runtimeId="codex"
      serverId="server-1"
      machineId="machine-1"
      className="runtime-chip"
      client={client}
    >
      Codex
    </RuntimeAccountUsageChip>,
  );
  fireEvent.focus(screen.getByRole("button", { name: "Codex" }));
  await waitFor(() => assert.ok(screen.getByText("75% used · reset time unavailable")));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    assert.ok(screen.getByText("Refresh timed out — the computer did not return usage in time")),
  );
  assert.ok(screen.queryByText("Refresh cooling down") === null);
});
