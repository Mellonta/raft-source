import assert from "node:assert/strict";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ThemeProvider, toast } from "raft-ui";
import LocalizedToastProvider from "../src/components/LocalizedToastProvider";
import { TestIntlProvider } from "./helpers/intl";

// raft-ui ThemeProvider reads matchMedia on mount; jsdom does not implement it.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
});

test("brutal default toast status icon renders icon-only and keeps the caller content class", async () => {
  render(
    <ThemeProvider defaultTheme="brutal" defaultMode="light">
      <TestIntlProvider>
        <LocalizedToastProvider>
          <div />
        </LocalizedToastProvider>
      </TestIntlProvider>
    </ThemeProvider>,
  );

  act(() => {
    toast.success("Removed", {
      action: { label: "Undo", onClick: () => {} },
      contentClassName: "caller-toast-content",
    });
  });

  const icon = await screen.findByTestId("localized-toast-icon");
  const iconClasses = [...icon.classList];
  for (const chrome of ["border-2", "bg-layer-panel", "p-1", "p-1.5", "shadow-[2px_2px_0_0_black]", "size-7", "size-8"]) {
    assert.ok(!iconClasses.includes(chrome), `status icon must not carry button chrome class ${chrome}`);
  }
  for (const reset of ["size-5", "border-0", "bg-transparent", "p-0", "shadow-none"]) {
    assert.ok(iconClasses.includes(reset), `status icon must render icon-only (${reset})`);
  }

  assert.ok(
    screen.getByTestId("localized-toast-content-row").classList.contains("caller-toast-content"),
    "contentClassName passed to toast.* must reach the rendered toast content",
  );
});
