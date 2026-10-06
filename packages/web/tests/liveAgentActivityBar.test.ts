import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "raft-ui";
import type { AgentActivity } from "@botiverse/raft-shared";
import { LiveAgentActivityBarPresentation } from "../src/components/layout/LiveAgentActivityBar";
import { TestIntlProvider } from "./helpers/intl";
import type { LiveAgentActivityItem } from "../src/utils/liveAgentActivity";

function makeActivity(overrides: Partial<LiveAgentActivityItem>): LiveAgentActivityItem {
  return {
    id: "activity-1",
    kind: "activity",
    agentId: "agent-1",
    agentName: "Runner",
    agentAvatarUrl: null,
    text: "Running tests",
    context: null,
    activity: "working",
    createdAt: 123,
    ...overrides,
  };
}

function renderBar(item: LiveAgentActivityItem | null, theme?: "brutal" | "elegant", mode?: "light" | "dark") {
  const content = createElement(
    TestIntlProvider,
    null,
    createElement(LiveAgentActivityBarPresentation, { latest: item }),
  );
  return renderToStaticMarkup(
    theme ? createElement(ThemeProvider, { theme, defaultMode: mode ?? "light" }, content) : content,
  );
}

test("LiveAgentActivityBar renders the RUI parts with brutal parity typography and hides when inactive", () => {
  const inactive = renderBar(null);

  assert.equal(inactive, "");

  const active = renderBar(makeActivity({ activity: "working" }));

  // RUI compound parts own the structure (data-slot contract).
  assert.match(active, /data-slot="live-agent-activity-bar"/);
  assert.match(active, /data-slot="live-agent-activity-bar-row"/);
  assert.match(active, /data-slot="live-agent-activity-bar-content"/);
  assert.match(active, /data-slot="live-agent-activity-bar-text"/);
  assert.match(active, /data-slot="status"/);
  assert.match(active, /aria-live="polite"/);
  // Brutal production parity: cream bar (desktop), black-border top, mono black/60 text.
  assert.match(active, /border-t-2 border-black bg-white[^"]*md:bg-brutal-cream/);
  assert.match(active, /min-w-0 truncate text-sm font-mono text-black\/60/);
  assert.match(active, /flex min-h-8 items-center gap-2/);
  assert.match(active, /gap-1\.5/);
  // Brutal keeps production's px-3 despite the recipe's px-4.
  assert.match(active, /theme-brutal:px-3!/);
  assert.doesNotMatch(active, /transition-transform/);
  assert.match(active, /Running tests/);
  assert.doesNotMatch(active, /Agent activity will appear here/);
});

test("LiveAgentActivityBar formats stored descriptors with the active app locale", () => {
  const active = renderToStaticMarkup(
    createElement(TestIntlProvider, { locale: "zh-cn" },
      createElement(LiveAgentActivityBarPresentation, {
        latest: makeActivity({
          id: "activity-zh",
          text: "Thinking…",
          textDescriptor: { primary: { id: "activity.status.thinkingEllipsis" } },
          activity: "thinking",
        }),
      }),
    ),
  );

  assert.match(active, /思考中…/);
  assert.doesNotMatch(active, /Thinking…/);
});

test("LiveAgentActivityBar preserves all five activity status semantics, all static", () => {
  const cases: Array<{
    activity: AgentActivity;
    variant: string;
    pulse: boolean;
    brutalColor: string | null;
  }> = [
    { activity: "online", variant: "success", pulse: false, brutalColor: null },
    { activity: "thinking", variant: "warning", pulse: false, brutalColor: "var(--color-status-busy)" },
    { activity: "working", variant: "warning", pulse: false, brutalColor: "var(--color-status-busy)" },
    { activity: "error", variant: "danger", pulse: false, brutalColor: "var(--color-brutal-orange)" },
    { activity: "offline", variant: "default", pulse: false, brutalColor: null },
  ];

  for (const { activity, variant, pulse, brutalColor } of cases) {
    const markup = renderBar(makeActivity({ activity }));
    const status = markup.match(/<span data-slot="status"[^>]*>/);
    assert.ok(status, `${activity}: status part renders`);
    assert.match(status[0], new RegExp(`data-variant="${variant}"`), `${activity}: variant`);
    assert.match(status[0], new RegExp(`data-activity="${activity}"`), `${activity}: state hook`);
    // Task #136: no state pulses — an infinite pulse kept the compositor
    // producing frames at display refresh rate (144 fps / 80% GPU under a modal).
    assert.equal(pulse, false);
    assert.doesNotMatch(status[0], /data-pulse/, `${activity}: no pulse`);
    assert.doesNotMatch(status[0], /animate-pulse|raft-status-pulse/, `${activity}: no pulse animation`);
    if (brutalColor) {
      assert.ok(
        status[0].includes(`theme-brutal:[--status-color:${brutalColor}]`),
        `${activity}: brutal keeps its fixed status-light color`,
      );
    }
    // The brutal border stays black in every state (StatusDot parity).
    assert.match(status[0], /theme-brutal:border-black/, `${activity}: brutal border`);
  }
});

test("LiveAgentActivityBar follows the RUI recipe in elegant without brutal hardcodes", () => {
  const elegant = renderBar(makeActivity({ activity: "online" }), "elegant");

  // Elegant recipe: panel card with semantic tokens, not the cream bar.
  assert.match(elegant, /rounded-lg border border-line-muted bg-layer-panel shadow-raft-md/);
  assert.match(elegant, /text-foreground-muted/);
  // Elegant-dark intent rides the recipe's dark: variants.
  assert.match(elegant, /dark:border-transparent/);
  // No raw brutal hardcodes leak outside theme-brutal: overrides.
  assert.doesNotMatch(elegant, /text-black\/60/);
  assert.doesNotMatch(elegant, /bg-brutal-cream/);
  assert.doesNotMatch(elegant, /border-t-2/);
  // Brutal-only overrides stay variant-scoped.
  const overrides = elegant.match(/theme-brutal:[a-z0-9\-:[\]()/!.]+/gi) ?? [];
  assert.ok(overrides.length > 0, "brutal overrides exist for the brutal theme");
  for (const token of overrides) {
    assert.match(token, /^theme-brutal:/, `${token} is variant-scoped`);
  }
});
