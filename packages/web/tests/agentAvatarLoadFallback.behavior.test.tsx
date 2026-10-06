import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AgentAvatar } from "../src/components/agent/PixelAvatar";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

test("a failed custom agent avatar falls back to the canonical pixel avatar", () => {
  const { container, rerender } = render(
    <TestIntlProvider>
      <AgentAvatar avatarUrl="https://cdn.example.com/broken-agent.png" size={32} />
    </TestIntlProvider>,
  );

  const customAvatar = container.querySelector<HTMLImageElement>('img[src="https://cdn.example.com/broken-agent.png"]');
  assert.ok(customAvatar);
  assert.equal(container.querySelector("[data-cell-size]"), null);

  fireEvent.error(customAvatar);
  // The pixel fallback is itself one <img> (task #137), so assert on the
  // custom URL being gone rather than on "no <img>" at all.
  assert.equal(container.querySelector('img[src="https://cdn.example.com/broken-agent.png"]') === null, true);
  const pixel = container.querySelector<HTMLImageElement>('img[data-agent-pixel-avatar="true"]');
  assert.equal(pixel !== null, true, "the canonical pixel avatar renders");
  assert.equal(pixel!.getAttribute("src")!.startsWith("data:image/svg+xml"), true);

  rerender(
    <TestIntlProvider>
      <AgentAvatar avatarUrl="https://cdn.example.com/replacement-agent.png" size={32} />
    </TestIntlProvider>,
  );
  assert.ok(container.querySelector('img[src="https://cdn.example.com/replacement-agent.png"]'));
  assert.equal(container.querySelector("[data-cell-size]"), null);
});
