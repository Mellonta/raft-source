import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  flushProductEvents,
  resetProductEventsForTest,
  setProductEventServerIdGetter,
  trackEvent,
} from "../src/analytics/track";
import { recordPwaInstallEvent } from "../src/utils/pwaInstall";
import { SETTINGS_PAGE_TABS } from "@botiverse/raft-shared";
import { pageRouteFor } from "../src/analytics/pageViews";
import { SETTINGS_TABS } from "../src/components/settings/settingsNavigation";
import {
  trackActivityOpen,
  trackActivityItemOpen,
  trackActivityMark,
} from "../src/analytics/activity";

type Call = { url: string; init?: RequestInit };

function fakeServer(clientEventsAllowed: boolean) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/product-events/config")) {
      return new Response(JSON.stringify({ clientEventsAllowed }), { status: 200 });
    }
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  };
  return { calls, fetchImpl };
}

function withToken<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "slock_access_token" ? "token-1" : null) },
  });
  return run().finally(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
}

function trackEverything(): void {
  trackActivityOpen("rail");
  trackActivityItemOpen("thread");
  trackActivityMark("done");
  trackEvent("community_cn_qr_page_view", { from: "direct" });
  recordPwaInstallEvent({
    event: "pwa_install_cta_clicked",
    platform: "ios_safari",
    surface: "settings",
    trigger: "settings",
    displayMode: "browser",
    sessionCountBucket: "1",
    cooldownState: "not_dismissed",
  });
}

test("events go out only after the server says this user may send them", () => withToken(async () => {
  const server = fakeServer(true);
  resetProductEventsForTest(server.fetchImpl);
  setProductEventServerIdGetter(() => "server-1");
  try {
    trackEverything();
    await flushProductEvents();
  } finally {
    resetProductEventsForTest();
    setProductEventServerIdGetter(() => undefined);
  }

  assert.deepEqual(server.calls.map((call) => call.url.replace(/^.*\/product-events\//, "")), ["config", "batch"]);
  const batch = server.calls[1]!;
  assert.equal((batch.init?.headers as Record<string, string>)["X-Server-Id"], "server-1");
  const body = JSON.parse(String(batch.init?.body)) as {
    source: string;
    events: Array<{ uuid: string; event: string; client_session_id: string; properties: Record<string, unknown> }>;
  };
  assert.equal(body.source, "web");
  assert.deepEqual(body.events.map((event) => event.event), [
    "activity_open",
    "activity_item_open",
    "activity_mark",
    "community_cn_qr_page_view",
    "pwa_install_cta_clicked",
  ]);
  assert.equal(new Set(body.events.map((event) => event.uuid)).size, body.events.length);
  assert.ok(body.events.every((event) => event.client_session_id.length > 0));
  assert.deepEqual(body.events[4]!.properties, {
    platform: "ios_safari",
    surface: "settings",
    trigger: "settings",
    display_mode: "browser",
    session_count_bucket: "1",
    cooldown_state: "not_dismissed",
  });
}));

test("events never leave the browser when the server says no", () => withToken(async () => {
  const server = fakeServer(false);
  resetProductEventsForTest(server.fetchImpl);
  setProductEventServerIdGetter(() => "server-1");
  try {
    trackEverything();
    await flushProductEvents();
    trackEverything();
    await flushProductEvents();
  } finally {
    resetProductEventsForTest();
    setProductEventServerIdGetter(() => undefined);
  }
  assert.deepEqual(server.calls.map((call) => call.url.replace(/^.*\/product-events\//, "")), ["config"]);
}));

test("nothing is sent outside a server or without a session", () => withToken(async () => {
  const server = fakeServer(true);
  resetProductEventsForTest(server.fetchImpl);
  try {
    trackEverything(); // no current server
    await flushProductEvents();
  } finally {
    resetProductEventsForTest();
  }
  assert.equal(server.calls.length, 0);
}));

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("only src/analytics/track.ts defines where product events go", () => {
  const offenders = listSourceFiles(join(__dirname, "../src")).filter((file) => {
    if (file.endsWith(join("analytics", "track.ts"))) return false;
    return /posthog|amplitude|mixpanel|segment\.com/i.test(readFileSync(file, "utf8"));
  });
  assert.deepEqual(offenders, []);
});

test("page_viewed carries only a route name for tracked in-server pages", () => {
  assert.deepEqual(pageRouteFor("/s/acme/channel/123e4567-e89b-42d3-a456-426614174000"), { route: "channel" });
  assert.deepEqual(pageRouteFor("/s/acme/machine/abc"), { route: "computer" });
  assert.deepEqual(pageRouteFor("/s/acme/members/graph"), { route: "members_graph" });
  assert.deepEqual(pageRouteFor("/s/acme/settings/administration"), { route: "settings", settingsTab: "administration" });
  assert.deepEqual(pageRouteFor("/s/acme/settings"), { route: "settings" });
  assert.deepEqual(pageRouteFor("/s/acme/settings/anything-typed-here"), { route: "settings" }, "unknown tabs are dropped");
  assert.equal(pageRouteFor("/s/acme/threads"), null, "legacy redirects are not pages");
  assert.equal(pageRouteFor("/s/acme/"), null);
  assert.equal(pageRouteFor("/login"), null);
  assert.equal(pageRouteFor("/s/acme/constructor"), null, "no prototype keys");
});

test("the registry's settings tabs match the settings navigation", () => {
  assert.deepEqual([...SETTINGS_PAGE_TABS].sort(), SETTINGS_TABS.map((tab) => tab.id).sort());
});
