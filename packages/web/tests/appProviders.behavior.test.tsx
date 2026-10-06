import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { useIntl } from "react-intl";
import { useTheme } from "raft-ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProviders } from "../src/AppProviders";
import { useAppTheme } from "../src/hooks/useAppTheme";
import { showToast } from "../src/components/toastBridge";

// AppProviders is the single root composition every host (web entry, desktop
// shell, tests) mounts the app through. This test is the CONTRACT: one probe per
// context a screen may rely on. Adding a provider to AppProviders without a
// probe here, or a host re-listing providers by hand, is how desktop 0.1.29
// shipped crashing (missing AppThemeProvider, 2026-09-24).

function Probe() {
  const theme = useAppTheme();
  const rui = useTheme();
  const { formatMessage } = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="probe">
        {theme.preset}|{rui.theme}|{formatMessage({ id: "common.close" })}|{location.pathname}
      </output>
      <button type="button" data-testid="probe-navigate" onClick={() => navigate("/s/demo/channel/c1")}>go</button>
    </>
  );
}

afterEach(() => cleanup());

test("AppProviders supplies every root context the app relies on: app theme, raft-ui theme, intl, localized toast bridge, router", async () => {
  render(
    <AppProviders router={MemoryRouter}>
      <Probe />
    </AppProviders>,
  );
  const probe = screen.getByTestId("probe");
  const [preset, ruiTheme, closeLabel, pathname] = (probe.textContent ?? "").split("|");
  assert.equal(pathname, "/", "router context resolves (the injected router wraps the app)");
  assert.ok(preset, "useAppTheme resolves (AppThemeProvider present)");
  assert.ok(["brutal", "elegant"].includes(ruiTheme), `raft-ui theme resolves (got ${ruiTheme})`);
  assert.ok(closeLabel && closeLabel !== "common.close", "intl resolves a real message (Locale + Intl providers present)");

  // Imperative toasts from non-React code go through the bridge that
  // LocalizedToastProvider installs; a host without it drops them silently.
  showToast({ title: "Contract toast", type: "success" });
  await waitFor(() => {
    assert.ok(screen.getByTestId("localized-toast-row"));
  });
  assert.match(document.body.textContent ?? "", /Contract toast/);

  // Navigation through the injected router reaches the app (not a detached router).
  fireEvent.click(screen.getByTestId("probe-navigate"));
  await waitFor(() => {
    assert.match(screen.getByTestId("probe").textContent ?? "", /\|\/s\/demo\/channel\/c1$/);
  });
});

test("the web entry mounts the app through AppProviders and does not re-list root providers", () => {
  const entry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(entry, /<AppProviders[\s>]/, "web entry renders <AppProviders>");
  for (const name of ["AppThemeProvider", "TooltipProvider", "LocalizedToastProvider", "ForwardToastProvider", "BrowserRouter"]) {
    assert.doesNotMatch(entry, new RegExp(`<${name}[\\s>]`), `${name} must come from AppProviders, not the entry`);
  }
});
