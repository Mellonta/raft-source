import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, render } from "@testing-library/react";

import { AuthBrandTopBar } from "../src/components/brand/AuthBrandShell";
import { OnboardingBrandBar } from "../src/components/auth/OnboardingCreateShell";
import { TestIntlProvider } from "./helpers/intl";

// task #85: in the desktop shell the window's own top strip carries the RAFT logo, so
// the auth pages must NOT render their own brand bar (that produced two stacked bars).
// On Web the brand bar renders as before.
type DesktopWindow = { raftDesktop?: { isDesktop?: boolean } };
const original = (window as DesktopWindow).raftDesktop;
afterEach(() => {
  cleanup();
  if (original === undefined) delete (window as DesktopWindow).raftDesktop;
  else (window as DesktopWindow).raftDesktop = original;
});

test("Web renders the auth brand bar", () => {
  delete (window as DesktopWindow).raftDesktop;
  const { container } = render(<TestIntlProvider><AuthBrandTopBar /></TestIntlProvider>);
  assert.notEqual(container.firstChild, null, "brand bar renders on Web (not suppressed)");
});

test("desktop shell suppresses the auth brand bar (single top strip)", () => {
  (window as DesktopWindow).raftDesktop = { isDesktop: true };
  const { container } = render(<AuthBrandTopBar />);
  assert.equal(container.firstChild, null, "no brand bar in the desktop shell");
});

test("onboarding-create brand bar: rendered on Web, suppressed in the desktop shell", () => {
  delete (window as DesktopWindow).raftDesktop;
  const web = render(<TestIntlProvider><OnboardingBrandBar /></TestIntlProvider>);
  assert.notEqual(web.container.firstChild, null, "onboarding brand bar renders on Web");
  cleanup();
  (window as DesktopWindow).raftDesktop = { isDesktop: true };
  const desktop = render(<OnboardingBrandBar />);
  assert.equal(desktop.container.firstChild, null, "no onboarding brand bar in the desktop shell");
});
