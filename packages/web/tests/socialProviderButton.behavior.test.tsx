import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import SocialProviderButton from "../src/components/auth/SocialProviderButton";
import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: TestIntlProvider, ...options });

afterEach(() => {
  cleanup();
});

test("social provider buttons center their icon and label together", () => {
  render(
    <>
      <SocialProviderButton providerId="google" label="Google" onClick={() => {}} />
      <SocialProviderButton providerId="github" label="GitHub" onClick={() => {}} />
      <SocialProviderButton providerId="apple" label="Apple" onClick={() => {}} />
    </>,
  );

  for (const label of ["Google", "GitHub", "Apple"]) {
    const button = screen.getByRole("button", { name: `Continue with ${label}` });
    // The RUI Button owns the chrome; its content slot is what carries the
    // icon+label pair and the centering contract.
    assert.equal(button.getAttribute("data-slot"), "button");
    const content = button.querySelector('[data-slot="button-content"]');
    assert.ok(content, "social buttons must render the RUI button content slot");
    assert.ok(content.classList.contains("justify-center"));
    assert.equal(content.children.length, 2);
    assert.ok(content.firstElementChild instanceof HTMLImageElement);
    assert.equal(content.lastElementChild?.textContent, `Continue with ${label}`);
  }
});
