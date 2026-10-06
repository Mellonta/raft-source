import assert from "node:assert/strict";
import "./helpers/domSetup";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import { DeclaredScopesPicker } from "../src/components/settings/SettingsPanel";
import api from "../src/api/client";
import { DeveloperAppPermissions, InstalledAppNotifications } from "../src/components/settings/AppNotificationsControls";
import type { AppNotificationSelection } from "../src/components/settings/AppNotificationsControls";
import RequestedScopeConsent from "../src/components/oauth/RequestedScopeConsent";
import { hasAgentInboundOAuthScope, normalizeDeclaredOAuthScopes } from "../src/lib/oauthScopePresentation";
import type { RaftOAuthScopeId } from "../src/lib/oauthScopePresentation";

const originalGet = api.get;
afterEach(() => { cleanup(); api.get = originalGet; });

for (const locale of ["en", "zh-cn"] as const) {
  test(`App Agent read is selectable without login or webhook in ${locale}`, () => {
    let saved: AppNotificationSelection = { groups: [], events: [] };
    function Editor() {
      const [permissions, setPermissions] = useState<AppNotificationSelection>(saved);
      return <DeveloperAppPermissions clientId={null} state={null} loading={false} value={permissions} onChange={(value) => { saved = value; setPermissions(value); }} />;
    }
    render(<TestIntlProvider locale={locale}><MemoryRouter><Editor /></MemoryRouter></TestIntlProvider>);
    const table = screen.getByRole("table", { name: locale === "en" ? "App permissions" : "应用权限" });
    const headers = within(table).getAllByRole("columnheader");
    assert.equal(headers.length, 2);
    assert.ok(headers.every((header) => header.getAttribute("scope") === "col"));
    const access = within(table).getByRole("combobox", { name: locale === "en" ? "Agent · read" : "Agent · 只读" });
    assert.equal(access.hasAttribute("disabled"), false);
    fireEvent.click(access);
    fireEvent.pointerDown(screen.getByRole("option", { name: locale === "en" ? "Read-only" : "只读" }), { pointerType: "mouse" });
    fireEvent.click(screen.getByRole("option", { name: locale === "en" ? "Read-only" : "只读" }));
    assert.deepEqual(saved, { groups: ["agent"], events: [] });
    assert.ok(screen.queryByRole("switch") === null, "no webhook prerequisite");
    fireEvent.click(access);
    fireEvent.pointerDown(screen.getByRole("option", { name: locale === "en" ? "No access" : "无权限" }), { pointerType: "mouse" });
    fireEvent.click(screen.getByRole("option", { name: locale === "en" ? "No access" : "无权限" }));
    assert.deepEqual(saved, { groups: [], events: [] });
  });

  test(`legacy login scope stays compatible without being the App permission control in ${locale}`, () => {
    let saved: RaftOAuthScopeId[] = [];
    render(<TestIntlProvider locale={locale}><MemoryRouter><DeclaredScopesPicker value={["openid", "profile", "identity", "agent:read"]} onChange={(value) => { saved = value; }} /></MemoryRouter></TestIntlProvider>);
    assert.ok(screen.getByTestId("legacy-agent-login-scope"));
    const email = screen.getByRole("checkbox", { name: "email" });
    assert.equal(email.closest("details:not([open])"), null, "email must not be hidden behind a collapsed section");
    assert.ok(screen.queryByTestId("agent-directory-permission") === null);
    fireEvent.click(screen.getByText("agent:notification:write"));
    assert.ok(saved.includes("agent:read"), "editing other OAuth scopes must preserve legacy compatibility");
    assert.deepEqual(normalizeDeclaredOAuthScopes(saved), saved);
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

test("installed Agent read is shown as active with no event subscriptions", async () => {
  api.get = (async () => ({ data: {
    installation_id: "installation-1", status: "active", approved_request_revision_id: "revision-1",
    requested_groups: ["agent"], requested_events: [], approved_groups: ["agent"],
    subscribed_events: [], effective_groups: ["agent"], effective_events: [],
    grant_revision: 1, subscription_revision: 0, app_review_pending: false, approval_required: false,
  } })) as typeof api.get;
  render(<TestIntlProvider><InstalledAppNotifications clientId="app-1" canManage={true} onError={(message) => { throw new Error(message); }} /></TestIntlProvider>);
  assert.ok(await screen.findByText("App permissions"));
  assert.ok(screen.getByText("Agent · read"));
  assert.ok(screen.getByText("Enabled"));
  assert.ok(screen.getByText("No subscriptions"));
  assert.ok(screen.queryByRole("switch") === null);
});
