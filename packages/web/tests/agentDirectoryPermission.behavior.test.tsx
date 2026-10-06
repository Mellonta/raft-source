import assert from "node:assert/strict";
import "./helpers/domSetup";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import { DeclaredScopesPicker } from "../src/components/settings/SettingsPanel";
import RequestedScopeConsent from "../src/components/oauth/RequestedScopeConsent";
import { hasAgentInboundOAuthScope, normalizeDeclaredOAuthScopes } from "../src/lib/oauthScopePresentation";
import type { RaftOAuthScopeId } from "../src/lib/oauthScopePresentation";

afterEach(cleanup);

for (const locale of ["en", "zh-cn"] as const) {
  test(`Agent directory can be enabled and removed independently in ${locale} App settings`, () => {
    let saved: RaftOAuthScopeId[] = [];
    function Editor() {
      const [scopes, setScopes] = useState<RaftOAuthScopeId[]>(["openid", "profile", "identity", "agent:notification:write"]);
      return <DeclaredScopesPicker value={scopes} onChange={(value) => { saved = value; setScopes(value); }} />;
    }
    render(<TestIntlProvider locale={locale}><MemoryRouter><Editor /></MemoryRouter></TestIntlProvider>);
    const checkbox = screen.getByRole("checkbox", { name: locale === "en" ? "Agent directory" : "Agent 列表" });
    assert.equal(checkbox.getAttribute("aria-checked"), "false");
    fireEvent.click(checkbox);
    assert.ok(saved.includes("agent:read"));
    assert.ok(saved.includes("agent:notification:write"), "existing messaging selection survives");
    assert.deepEqual(normalizeDeclaredOAuthScopes(saved), saved, "edit round trip retains the new scope");
    fireEvent.click(checkbox);
    assert.equal(saved.includes("agent:read"), false);
    assert.ok(saved.includes("agent:notification:write"), "removing list read does not remove messaging");
    const text = document.body.textContent ?? "";
    assert.ok(text.includes(locale === "en" ? "No webhook is required" : "不需要配置 webhook"));
  });

  test(`directory consent is visible and does not require Agent-only login in ${locale}`, () => {
    render(<TestIntlProvider locale={locale}><RequestedScopeConsent scopes={["openid", "profile", "agent:read"]} /></TestIntlProvider>);
    const row = document.querySelector('[data-oauth-scope-row="agent:read"]');
    assert.ok(row);
    assert.ok(row.closest("details")?.open);
    assert.ok(row.textContent?.includes(locale === "en" ? "does not allow sending messages" : "不允许发送消息"));
    assert.equal(hasAgentInboundOAuthScope(["agent:read"]), false);
    assert.equal(document.querySelectorAll('[data-oauth-scope-row="agent:notification:write"]').length, 0);
  });
}
