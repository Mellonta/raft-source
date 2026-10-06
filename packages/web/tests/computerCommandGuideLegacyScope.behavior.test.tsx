import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import ComputerCommandGuide from "../src/components/machine/ComputerCommandGuide";
import { TestIntlProvider } from "./helpers/intl";

/**
 * `ComputerCommandGuide` is SHARED by AddMachineDialog, MachineDetailPanel and the onboarding
 * setup step. It used to carry a "Daemon / Legacy" path (`npx @botiverse/raft-daemon`) that
 * task #197 hid from onboarding only. The standalone daemon is now retired altogether: it is no
 * longer published and ships only inside Raft Computer, carrying the Computer version
 * (docs/operations/computer-release-version.md). The guide therefore offers Computer on every
 * surface and has no legacy affordance, no credential to mask, and no key to mint.
 */

afterEach(() => cleanup());

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

function renderGuide() {
  return render(
    <ComputerCommandGuide
      computerCommand="raft-computer setup /launch"
      computerInstallCommand="curl -fsSL https://downloads.raft.build/computer/install.sh | sh"
      windowsComputerCommand="raft-computer setup /launch"
      windowsComputerInstallCommand="irm https://cdn.raft.build/computer/install.ps1 | iex"
    />,
  );
}

test("Windows offers Raft Computer only: no Legacy block, no daemon command, no mint request", () => {
  renderGuide();
  fireEvent.click(screen.getByRole("radio", { name: "Windows x64" }));

  assert.ok(screen.getByText("Raft Computer · Windows x64"));
  assert.ok(screen.getByText("irm https://cdn.raft.build/computer/install.ps1 | iex"));
  assert.ok(screen.getByText("raft-computer setup /launch"));

  assert.equal(screen.queryByTestId("windows-daemon-command-block"), null);
  assert.equal(screen.queryByTestId("computer-windows-daemon-request"), null);
  assert.equal(screen.queryByText("Daemon / Legacy"), null);
  assert.equal(document.body.innerHTML.includes("raft-daemon"), false);
});

test("macOS / Linux offers Raft Computer only", () => {
  renderGuide();
  fireEvent.click(screen.getByRole("radio", { name: "macOS / Linux" }));

  assert.ok(screen.getByText("curl -fsSL https://downloads.raft.build/computer/install.sh | sh"));
  assert.ok(screen.getByText("raft-computer setup /launch"));
  assert.equal(document.body.innerHTML.includes("raft-daemon"), false);
});
