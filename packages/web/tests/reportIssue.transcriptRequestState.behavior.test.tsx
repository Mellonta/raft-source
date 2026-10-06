import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ReportIssueDialog from "../src/components/agent/ReportIssueDialog";
import api from "../src/api/client";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// task #1228 ①: the Report Issue dialog never claims a session record was
// attached or uploaded. It only knows the HTTP result of its own request, and
// that request never blocks the report.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const originalApiPost = api.post;
const originalFetch = globalThis.fetch;

/** The ONLY transcript-state copy the dialog may show, and its exact text. */
const STATE_KEYS = [
  "agent.reportIssue.runtimeTranscriptRequestPending",
  "agent.reportIssue.runtimeTranscriptRequested",
  "agent.reportIssue.runtimeTranscriptRequestFailed",
  "agent.reportIssue.runtimeTranscriptRequestUnconfirmed",
  "agent.reportIssue.runtimeTranscriptHint",
] as const;

const agent: Agent = {
  id: "agent-1", serverId: "server-1", name: "helper", displayName: "Helper", avatarUrl: null, description: "A test agent",
  status: "idle", model: "test-model", runtime: "codex", serverRole: "member", reasoningEffort: null, executionMode: "byoc",
  envVars: null, machineId: "machine-1", creatorType: "user", creatorId: "user-1", creator: null, createdAgents: [], deletedAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
};
const machine: Machine = {
  id: "machine-1", name: "Test computer", description: null, status: "online", statusVersion: 1, apiKeyPrefix: null, runtimes: ["codex"],
  hostname: "test.local", os: "darwin", daemonVersion: "1.0.27", lastHeartbeat: "2026-08-12T00:00:00.000Z", createdAt: "2026-08-12T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  api.post = originalApiPost;
  globalThis.fetch = originalFetch;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

type TranscriptBehaviour = "accepted" | "http_500" | "network" | "hang";

function install(behaviour: TranscriptBehaviour) {
  const calls: string[] = [];
  api.post = (async (url: string) => {
    calls.push(url);
    if (url === "/servers/server-1/scope-attestation") {
      return { data: { attestation: "a", scope: "feedback-report:create", expiresAt: "2026-08-12T01:00:00.000Z" } };
    }
    if (url === "/product-feedback") return { data: { id: "ticket-1" } };
    if (url.endsWith("/transcript")) {
      if (behaviour === "accepted") return { status: 202, data: { accepted: true } };
      if (behaviour === "http_500") throw Object.assign(new Error("Request failed with status code 500"), { isAxiosError: true, response: { status: 500, data: { error: "boom" } } });
      if (behaviour === "network") throw Object.assign(new Error("Network Error"), { isAxiosError: true });
      return new Promise(() => {});
    }
    throw new Error(`Unexpected API call: ${url}`);
  }) as typeof api.post;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://feedback.example.test/api/reports") {
      return new Response(JSON.stringify({
        id: "report-1", artifactId: "artifact-1", upload: { method: "PUT", url: "https://upload.example.test/report-1", headers: {} },
        completeToken: "c", expiresAt: "2026-08-12T01:00:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return calls;
}

function renderAndSubmit(locale: "en" | "zh-cn" = "en") {
  useAuthStore.setState({ user: { id: "user-1", email: "r@example.test", name: "r", displayName: "R" } } as never);
  useServerStore.setState({ current: { id: "server-1", name: "S", slug: "s" } } as never);
  useMachineStore.setState({ machines: [machine] } as never);
  useAgentStore.setState({ getActivityLog: () => [], getTrajectoryLog: () => [] } as never);
  render(
    <TestIntlProvider locale={locale}>
      <MemoryRouter>
        <ReportIssueDialog agent={agent} onClose={() => undefined} feedbackExportUrl="https://feedback.example.test" />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  const messages = locale === "en" ? en : zh;
  fireEvent.click(screen.getByRole("checkbox", { name: messages["agent.reportIssue.consent"] }));
  fireEvent.click(screen.getByRole("button", { name: messages["agent.reportIssue.title"] }));
}

test("D1 POST accepted (2xx) → 'requested' copy only; no attached/uploaded claim anywhere on the success screen", async () => {
  install("accepted");
  renderAndSubmit();
  await screen.findByText(en["agent.reportIssue.submittedTitle"]!);
  await new Promise((r) => setTimeout(r, 20));
  const text = document.body.textContent ?? "";
  assert.ok(!/being uploaded|transcript (is|was) (attached|uploaded)|attached to this report/i.test(text), text);
  await screen.findByText(en["agent.reportIssue.runtimeTranscriptRequested"]!);
});

test("D2 POST non-2xx → exactly 'session record request failed' (en + zh); never 'the report doesn't include a transcript'", async () => {
  install("http_500");
  renderAndSubmit();
  await screen.findByText(en["agent.reportIssue.submittedTitle"]!);
  await screen.findByText("Session record request failed.");
  assert.ok(!/without it|doesn't include|does not include|不包含/.test(document.body.textContent ?? ""));
  cleanup();
  install("http_500");
  renderAndSubmit("zh-cn");
  await screen.findByText(zh["agent.reportIssue.submittedTitle"]!);
  await screen.findByText(/^会话记录请求失败/);
});

test("D3 POST network error → 'unconfirmed', and no unhandled promise rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    install("network");
    renderAndSubmit();
    await screen.findByText(en["agent.reportIssue.runtimeTranscriptRequestUnconfirmed"]!);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("D4 a hanging POST never blocks the report: the ticket is filed and the success screen shows 'pending'", async () => {
  const calls = install("hang");
  renderAndSubmit();
  await screen.findByText(en["agent.reportIssue.ticketFiled"]!);
  assert.ok(screen.getByText(en["agent.reportIssue.runtimeTranscriptRequestPending"]!));
  const transcriptIndex = calls.findIndex((u) => u.endsWith("/transcript"));
  const ticketIndex = calls.indexOf("/product-feedback");
  assert.ok(transcriptIndex >= 0 && transcriptIndex < ticketIndex, "the request starts BEFORE the ticket (runs in parallel)");
});

test("D5 copy sweep (exact allowlist): the transcript-state strings never say attached / uploaded, in en or zh; the queued line is retired", () => {
  for (const key of STATE_KEYS) {
    assert.equal(typeof en[key], "string", `${key} missing from en`);
    assert.equal(typeof zh[key], "string", `${key} missing from zh`);
    assert.ok(!/attach|upload/i.test(en[key]!), `${key} (en): ${en[key]}`);
    assert.ok(!/附加|附上|附带|上传|已附/.test(zh[key]!), `${key} (zh): ${zh[key]}`);
  }
  assert.equal(en["agent.reportIssue.runtimeTranscriptQueued"], undefined);
  assert.equal(zh["agent.reportIssue.runtimeTranscriptQueued"], undefined);
});

describe("transcript request timing (pure helper)", () => {
  const helper = () => import("../src/feedback/transcriptRequestState") as Promise<any>;

  test("T1 the 10 s cap is measured from the START of the request, and a late answer still updates the state", async () => {
    vi.useFakeTimers();
    try {
      const { startTranscriptRequest, TRANSCRIPT_REQUEST_CONFIRM_CAP_MS } = await helper();
      assert.equal(TRANSCRIPT_REQUEST_CONFIRM_CAP_MS, 10_000);
      let resolvePost!: (v: unknown) => void;
      const states: string[] = [];
      startTranscriptRequest(() => new Promise((r) => { resolvePost = r; }), (s: string) => states.push(s));
      assert.deepEqual(states, ["pending"]);
      await vi.advanceTimersByTimeAsync(9_999);
      assert.deepEqual(states, ["pending"]);
      await vi.advanceTimersByTimeAsync(1);
      assert.deepEqual(states, ["pending", "request_unconfirmed"]);
      resolvePost({ status: 202 });
      await vi.advanceTimersByTimeAsync(0);
      assert.deepEqual(states, ["pending", "request_unconfirmed", "requested"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("T2 classification: 2xx → requested; error with an HTTP status → request_failed; error without one → request_unconfirmed; the returned promise never rejects", async () => {
    const { startTranscriptRequest } = await helper();
    const run = async (send: () => Promise<unknown>) => {
      const states: string[] = [];
      await startTranscriptRequest(send, (s: string) => states.push(s)).settled;
      return states.at(-1);
    };
    assert.equal(await run(async () => ({ status: 202 })), "requested");
    assert.equal(await run(async () => { throw Object.assign(new Error("x"), { response: { status: 403 } }); }), "request_failed");
    assert.equal(await run(async () => { throw new Error("Network Error"); }), "request_unconfirmed");
    assert.equal(await run(() => { throw new Error("sync throw"); }), "request_unconfirmed");
  });
});
