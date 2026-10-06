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

const originalApiPost = api.post;
const originalFetch = globalThis.fetch;
const consentLabel = enMessages["agent.reportIssue.consent"] as string;
const logTailDisclosureEn = enMessages["agent.reportIssue.machineLogTailDisclosure"] as string;
const logTailDisclosureZh = zhMessages["agent.reportIssue.machineLogTailDisclosure"] as string;


const agentBase: Agent = {
  id: "agent-1",
  serverId: "server-1",
  name: "helper",
  displayName: "Helper",
  avatarUrl: null,
  description: "A test agent",
  status: "idle",
  model: "test-model",
  runtime: "codex",
  serverRole: "member",
  reasoningEffort: null,
  executionMode: "byoc",
  envVars: null,
  machineId: null,
  creatorType: "user",
  creatorId: "user-1",
  creator: null,
  createdAgents: [],
  deletedAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
};

const machine: Machine = {
  id: "machine-1",
  name: "Test computer",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: ["codex"],
  hostname: "test.local",
  os: "darwin",
  daemonVersion: "1.0.16",
  lastHeartbeat: "2026-08-12T00:00:00.000Z",
  createdAt: "2026-08-12T00:00:00.000Z",
};

type ReportPayload = {
  title: string;
  metadata: {
    includes: Record<string, boolean>;
    transcript?: {
      requested: boolean;
      requestable: boolean;
    };
  };
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

function seedStores(hasMachine: boolean, machines: Machine[] = hasMachine ? [machine] : []) {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "reporter@example.test",
      name: "reporter",
      displayName: "Reporter",
    },
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Test server",
      slug: "test-server",
    },
  } as never);
  useMachineStore.setState({ machines } as never);
  useAgentStore.setState({
    getActivityLog: () => [{ id: "activity-1" }],
    getTrajectoryLog: () => [{ id: "trajectory-1" }],
  } as never);
}

function renderDialog(hasMachine: boolean, locale = "en", machines?: Machine[]) {
  seedStores(hasMachine, machines);
  const agent = { ...agentBase, machineId: hasMachine ? machine.id : null };
  render(
    <TestIntlProvider locale={locale}>
      <MemoryRouter>
        <ReportIssueDialog
          agent={agent}
          onClose={() => undefined}
          feedbackExportUrl="https://feedback.example.test"
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("runner log-tail disclosure keeps the consent facts in both locales", () => {
  for (const fact of ["free text", "other agents", "including agents", "floor, not a guarantee", "transcript"]) {
    assert.ok(logTailDisclosureEn.includes(fact), `en disclosure lost: ${fact}`);
  }
  for (const fact of ["自由文本", "其他 Agent", "含 Agent", "下限不是保证", "会话记录"]) {
    assert.ok(logTailDisclosureZh.includes(fact), `zh disclosure lost: ${fact}`);
  }
});

test("the mounted dialog sends its formatted agent title under zh-cn", async () => {
  const mocks = installSubmitMocks();
  renderDialog(false, "zh-cn");

  fireEvent.click(screen.getByRole("checkbox", {
    name: (zhMessages as Record<string, string>)["agent.reportIssue.consent"],
  }));
  fireEvent.click(screen.getByRole("button", {
    name: (zhMessages as Record<string, string>)["agent.reportIssue.title"],
  }));

  await screen.findByText((zhMessages as Record<string, string>)["agent.reportIssue.submittedTitle"]);
  assert.equal(mocks.getCreatePayload()?.title, "针对 Helper 的问题报告");
});

// RUI Checkbox is a Base UI span[role=checkbox] + hidden native input, so
// getByLabelText would double-match; query the span by role and read state
// from aria-checked / data-disabled instead of native input properties.
function checkbox(label: string) {
  return screen.getByRole("checkbox", { name: label });
}

function consentCheckbox() {
  return screen.getByRole("checkbox", { name: consentLabel });
}

function isChecked(element: HTMLElement) {
  return element.getAttribute("aria-checked") === "true";
}

function installSubmitMocks(options: { ticketFailures?: number } = {}) {
  let createPayload: ReportPayload | null = null;
  let ticketForm: FormData | null = null;
  const ticketForms: FormData[] = [];
  let uploadBody: Blob | null = null;
  let ticketFailuresLeft = options.ticketFailures ?? 0;
  const apiCalls: string[] = [];

  api.post = (async (url: string, body?: unknown) => {
    apiCalls.push(url);
    if (url === "/servers/server-1/scope-attestation") {
      return {
        data: {
          attestation: "attestation-1",
          scope: "feedback-report:create",
          expiresAt: "2026-08-12T01:00:00.000Z",
        },
      };
    }
    if (url === "/product-feedback") {
      ticketForm = body as FormData;
      ticketForms.push(ticketForm);
      if (ticketFailuresLeft > 0) {
        ticketFailuresLeft -= 1;
        throw new Error("Hands unavailable");
      }
      return { data: { id: "ticket-1" } };
    }
    throw new Error(`Unexpected API call: ${url}`);
  }) as typeof api.post;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://feedback.example.test/api/reports") {
      createPayload = JSON.parse(String(init?.body)) as ReportPayload;
      return new Response(JSON.stringify({
        id: "report-1",
        artifactId: "artifact-1",
        upload: { method: "PUT", url: "https://upload.example.test/report-1", headers: {} },
        completeToken: "complete-1",
        expiresAt: "2026-08-12T01:00:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://upload.example.test/report-1") {
      uploadBody = init?.body as Blob;
      return new Response(null, { status: 200 });
    }
    if (url === "https://feedback.example.test/api/reports/report-1/complete") {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  return {
    apiCalls,
    getCreatePayload: () => createPayload,
    getTicketForm: () => ticketForm,
    getUploadedBundle: async () => {
      assert.ok(uploadBody, "the bundle must be uploaded");
      return JSON.parse(await uploadBody.text()) as {
        daemonVersion: string | null;
        agent: Record<string, unknown>;
      };
    },
    ticketForms,
  };
}

test("assigned-machine defaults are individually on while consent starts off", () => {
  renderDialog(true);

  assert.ok(screen.getByText("These are included by default — untick anything you don't want to send."));
  assert.equal(isChecked(checkbox("Recent DM messages with this agent")), true);
  assert.equal(isChecked(checkbox("Recent live agent activity")), true);
  assert.equal(isChecked(checkbox("Activity tab history")), true);
  assert.equal(isChecked(checkbox("Runtime session transcript")), true);
  assert.equal(isChecked(consentCheckbox()), false);
});

test("without an assigned machine transcript is unavailable, off, and omitted from the request", async () => {
  const mocks = installSubmitMocks();
  renderDialog(false);

  assert.equal(isChecked(checkbox("Recent DM messages with this agent")), true);
  assert.equal(isChecked(checkbox("Recent live agent activity")), true);
  assert.equal(isChecked(checkbox("Activity tab history")), true);
  const transcript = checkbox("Runtime session transcript");
  assert.equal(isChecked(transcript), false);
  assert.equal(transcript.hasAttribute("data-disabled"), true);
  assert.ok(screen.getByText("Runtime transcript upload is unavailable until the agent is assigned to a machine."));
  const consent = consentCheckbox();
  assert.equal(isChecked(consent), false);

  fireEvent.click(consent);
  fireEvent.click(screen.getByRole("button", { name: "Report Issue" }));

  await screen.findByText("Report Submitted");
  const payload = mocks.getCreatePayload();
  assert.ok(payload);
  assert.equal(Object.hasOwn(payload.metadata.includes, "runtimeSessionTranscript"), false);
  assert.equal(Object.hasOwn(payload.metadata, "transcript"), false);
  assert.equal(mocks.apiCalls.some((url) => url.includes("/transcript")), false);
});

test("each user untick stays equal between the final DOM and the request payload", async () => {
  const mocks = installSubmitMocks();
  renderDialog(true);

  const rows = [
    ["Recent DM messages with this agent", "recentMessages"],
    ["Recent live agent activity", "activityLog"],
    ["Activity tab history", "trajectoryLog"],
    ["Runtime session transcript", "runtimeSessionTranscript"],
  ] as const;

  for (const [label] of rows) {
    const input = checkbox(label);
    assert.equal(isChecked(input), true, `${label} must start on`);
    fireEvent.click(input);
    assert.equal(isChecked(input), false, `${label} must end off after its own untick`);
  }
  const finalDomState = Object.fromEntries(
    rows.map(([label, payloadKey]) => [payloadKey, isChecked(checkbox(label))]),
  ) as Record<(typeof rows)[number][1], boolean>;

  const consent = consentCheckbox();
  assert.equal(isChecked(consent), false);
  fireEvent.click(consent);
  fireEvent.click(screen.getByRole("button", { name: "Report Issue" }));

  await screen.findByText("Report Submitted");
  const payload = mocks.getCreatePayload();
  assert.ok(payload);
  for (const [, payloadKey] of rows) {
    assert.equal(payload.metadata.includes[payloadKey], finalDomState[payloadKey], payloadKey);
  }
  assert.equal(payload.metadata.transcript?.requested, finalDomState.runtimeSessionTranscript);
  assert.equal(payload.metadata.transcript?.requestable, true);
});

test("a submitted report files a Hands ticket that carries only the report id and the user's words", async () => {
  const mocks = installSubmitMocks();
  renderDialog(false);

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "It stopped replying" } });
  fireEvent.click(consentCheckbox());
  fireEvent.click(screen.getByRole("button", { name: "Report Issue" }));

  await screen.findByText(enMessages["agent.reportIssue.ticketFiled"] as string);
  const form = mocks.getTicketForm();
  assert.ok(form);
  assert.equal(form.get("type"), "problem");
  assert.equal(form.get("feedback_report_id"), "report-1");
  assert.equal(form.get("message"), "Issue report for Helper\n\nIt stopped replying");
  assert.equal(form.getAll("attachments").length, 0, "debug evidence must never be attached to the ticket");
  assert.equal(mocks.apiCalls.some((url) => url.includes("/receipt")), false);
  assert.ok(screen.getByRole("button", { name: "View ticket" }));
  assert.ok(screen.queryByText("Report ID") === null);
});

test("when the ticket cannot be filed the uploaded report still surfaces its reference", async () => {
  installSubmitMocks({ ticketFailures: Infinity });
  renderDialog(false);

  fireEvent.click(consentCheckbox());
  fireEvent.click(screen.getByRole("button", { name: "Report Issue" }));

  await screen.findByText(enMessages["agent.reportIssue.ticketFailed"] as string);
  assert.ok(screen.getByText("report-1"));
  assert.ok(screen.queryByRole("button", { name: "View ticket" }) === null);
});

test("a failed ticket can be retried with the same submission id", async () => {
  const mocks = installSubmitMocks({ ticketFailures: 1 });
  renderDialog(false);

  fireEvent.click(consentCheckbox());
  fireEvent.click(screen.getByRole("button", { name: "Report Issue" }));

  await screen.findByText(enMessages["agent.reportIssue.ticketFailed"] as string);
  fireEvent.click(screen.getByRole("button", { name: enMessages["agent.reportIssue.retryTicket"] as string }));

  await screen.findByRole("button", { name: "View ticket" });
  assert.equal(mocks.ticketForms.length, 2);
  assert.equal(mocks.ticketForms[1]!.get("feedback_report_id"), "report-1");
  assert.equal(
    mocks.ticketForms[1]!.get("submission_id"),
    mocks.ticketForms[0]!.get("submission_id"),
    "a retry must reuse the submission id so Hands can dedupe it",
  );
  assert.ok(screen.queryByText(enMessages["agent.reportIssue.ticketFailed"] as string) === null);
});

async function submitDefault() {
  fireEvent.click(consentCheckbox());
  fireEvent.click(screen.getByRole("button", { name: "Report Issue" }));
  await screen.findByText(enMessages["agent.reportIssue.ticketFiled"] as string);
}

test("the uploaded bundle snapshots OS, Computer version and heartbeat of the agent's own machine", async () => {
  const mocks = installSubmitMocks();
  const otherMachine: Machine = {
    ...machine,
    id: "machine-other",
    os: "win32",
    computerVersion: "9.9.9",
    lastHeartbeat: "2026-08-01T00:00:00.000Z",
  };
  renderDialog(true, "en", [otherMachine, { ...machine, os: "linux", computerVersion: "1.0.40" }]);

  await submitDefault();
  const bundle = await mocks.getUploadedBundle();
  assert.equal(bundle.agent.machineId, "machine-1");
  assert.equal(bundle.agent.machineOs, "linux");
  assert.equal(bundle.agent.machineComputerVersion, "1.0.40");
  assert.equal(bundle.agent.machineLastHeartbeat, "2026-08-12T00:00:00.000Z");
  assert.equal(bundle.agent.machineStatus, "online");
  assert.equal(bundle.daemonVersion, "1.0.16");
});

test("unknown machine facts are explicit nulls, never the reporting client's platform", async () => {
  const cases: Array<{ name: string; hasMachine: boolean; machines?: Machine[]; os: string | null }> = [
    // A raw daemon / older server: no computerVersion reported.
    { name: "no computerVersion", hasMachine: true, machines: [machine], os: "darwin" },
    // Blank reported values are unknown, not a value.
    { name: "blank values", hasMachine: true, machines: [{ ...machine, os: " ", computerVersion: "", lastHeartbeat: null }], os: null },
    // Assigned machine not (yet) in the store.
    { name: "machine not loaded", hasMachine: true, machines: [], os: null },
    { name: "no assigned machine", hasMachine: false, os: null },
  ];
  for (const testCase of cases) {
    const mocks = installSubmitMocks();
    renderDialog(testCase.hasMachine, "en", testCase.machines);
    await submitDefault();
    const bundle = await mocks.getUploadedBundle();
    for (const key of ["machineOs", "machineComputerVersion", "machineLastHeartbeat"]) {
      assert.ok(Object.hasOwn(bundle.agent, key), `${testCase.name}: ${key} must be present`);
    }
    assert.equal(bundle.agent.machineOs, testCase.os, testCase.name);
    assert.equal(bundle.agent.machineComputerVersion, null, testCase.name);
    if (testCase.name !== "no computerVersion") {
      assert.equal(bundle.agent.machineLastHeartbeat, null, testCase.name);
    }
    cleanup();
  }
});

test("the Hands ticket carries the active UI locale as metadata without touching the message", async () => {
  for (const locale of ["en", "zh-cn"]) {
    const mocks = installSubmitMocks();
    renderDialog(false, locale);
    const messages = (locale === "en" ? enMessages : zhMessages) as Record<string, string>;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "It stopped replying" } });
    fireEvent.click(screen.getByRole("checkbox", { name: messages["agent.reportIssue.consent"] }));
    fireEvent.click(screen.getByRole("button", { name: messages["agent.reportIssue.title"] }));
    await screen.findByText(messages["agent.reportIssue.ticketFiled"]!);

    const form = mocks.getTicketForm();
    assert.ok(form);
    const rawMetadata = form.get("metadata");
    assert.equal(typeof rawMetadata, "string", `${locale}: ticket must send a metadata field`);
    assert.deepEqual(JSON.parse(rawMetadata as string), { locale }, locale);
    assert.ok(String(form.get("message")).endsWith("\n\nIt stopped replying"), `${locale}: description untouched`);
    cleanup();
  }
});
