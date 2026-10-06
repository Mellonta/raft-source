import "./helpers/domSetup";

import assert from "node:assert/strict";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AGENT_MIGRATION_FEATURE_FLAG_KEY, AGENT_MIGRATION_STATES } from "@botiverse/raft-shared";
import api from "../src/api/client";
import { REGISTERED_SERVER_FEATURE_FLAG_KEYS } from "../src/store/serverFeatureFlags";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import {
  renderPanel,
  resetAgentDetailPanelState,
  seedPanelState,
  stubAgentDetailApi,
  stubMigrationFeatureFlag,
} from "./helpers/agentDetailPanelHarness";

afterEach(resetAgentDetailPanelState);

test("migration profile entry is absent from the DOM while the migration flag is off", async () => {
  const agent = seedPanelState("server-flag-off");
  let evaluateCalls = 0;
  stubAgentDetailApi();
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      evaluateCalls += 1;
      assert.deepEqual(body, {
        serverId: "server-flag-off",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await waitFor(() => assert.equal(evaluateCalls, 1));
  assert.equal(
    screen.queryByRole("button", { name: "Move to another computer" }),
    null,
    "flag-off profile must not render the migration entry",
  );
});

test("migration profile entry has no progress when no migration exists", async () => {
  const agent = seedPanelState("server-idle-migration");
  stubAgentDetailApi();
  stubMigrationFeatureFlag("server-idle-migration");

  renderPanel(agent);

  await screen.findByRole("button", { name: "Move to another computer" });
  assert.equal(screen.queryByRole("progressbar"), null);
});

test("post-trial Free projection gates only the new migration entry and routes to billing", async () => {
  const agent = seedPanelState("server-free-migration");
  const posts: string[] = [];
  stubAgentDetailApi(null, "free");
  api.post = async (url: string) => {
    posts.push(url);
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await waitFor(() => assert.equal(useServerStore.getState().billing?.plan, "free"));
  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));

  assert.ok(screen.getByRole("heading", { name: "Move agents with Pro" }));
  assert.ok(screen.getByText(
    "Upgrade this server to Pro to move the agent and its workspace to another Computer.",
  ));
  assert.ok(screen.getByText(
    "Existing migration status, cancellation, cleanup, and recovery stay available.",
  ));
  assert.equal(
    screen.queryByRole("heading", { name: "Move to another computer" }),
    null,
  );
  assert.equal(posts.includes("/agents/agent-1/migrate"), false);

  fireEvent.click(screen.getByRole("button", { name: "View Plan & Billing" }));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/botiverse/settings/billing");
  });
});

test("post-trial Free projection renders the migration upgrade prompt in zh-CN", async () => {
  const agent = seedPanelState("server-free-migration-zh");
  stubAgentDetailApi(null, "free");
  stubMigrationFeatureFlag("server-free-migration-zh");

  renderPanel(agent, "zh-cn");

  await waitFor(() => assert.equal(useServerStore.getState().billing?.plan, "free"));
  fireEvent.click(await screen.findByRole("button", { name: "迁移到另一台计算机" }));

  assert.ok(screen.getByRole("heading", { name: "使用 Pro 迁移 Agent" }));
  assert.ok(screen.getByText(
    "将此服务器升级到 Pro，即可把 Agent 及其工作区迁移到另一台 Computer。",
  ));
  assert.ok(screen.getByText(
    "现有迁移的状态、取消、清理和恢复功能仍然可用。",
  ));
  assert.ok(screen.getByRole("button", { name: "查看套餐与账单" }));
  assert.equal(screen.queryByText("Move agents with Pro"), null);
});

test("typed backend plan denial replaces the start dialog with the same upgrade prompt", async () => {
  const agent = seedPanelState("server-stale-projection");
  let startCalls = 0;
  stubAgentDetailApi(null, "pro");
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      startCalls += 1;
      const error = new Error("upgrade required") as Error & {
        response?: { status?: number; data?: { code?: string; error?: string } };
      };
      error.response = {
        status: 403,
        data: {
          code: "MIGRATION_PRO_PLAN_REQUIRED",
          error: "Upgrade required",
        },
      };
      throw error;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await waitFor(() => assert.equal(useServerStore.getState().billing?.plan, "pro"));
  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  assert.ok(await screen.findByRole("heading", { name: "Move agents with Pro" }));
  assert.equal(startCalls, 1);
  assert.equal(
    screen.queryByRole("heading", { name: "Move to another computer" }),
    null,
  );
  assert.equal(screen.queryByText("MIGRATION_PRO_PLAN_REQUIRED"), null);
  assert.equal(screen.queryByText("Upgrade required"), null);
});

test("Free projection preserves the current active migration status", async () => {
  const agent = seedPanelState("server-free-active-migration");
  const activeMigration = {
    agentId: "agent-1",
    migrationRef: "mig_abcdefghijklmnopqrstuv",
    state: "in_transit",
    revision: 1,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:01:00.000Z",
  };
  stubAgentDetailApi(activeMigration, "free");
  stubMigrationFeatureFlag("server-free-active-migration");

  renderPanel(agent);

  await waitFor(() => assert.equal(useServerStore.getState().billing?.plan, "free"));
  assert.ok(screen.getByText("Transferring workspace to Target Computer."));
  assert.equal(
    (screen.getByRole("button", { name: "Migration in progress" }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(screen.queryByRole("heading", { name: "Move agents with Pro" }), null);
});

test("migration profile entry starts migration directly without preparing an action card", async () => {
  const agent = seedPanelState("server-flag-on");
  let evaluateCalls = 0;
  let migrationStatusCalls = 0;
  const posts: Array<{ url: string; body: unknown }> = [];
  stubAgentDetailApi();
  const fallbackGet = api.get;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      migrationStatusCalls += 1;
      const migration = migrationStatusCalls === 1
        ? null
        : {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "provisioning",
            revision: 1,
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
          };
      return { data: { migration } } as never;
    }
    return fallbackGet(url);
  };
  api.post = async (url: string, body?: unknown) => {
    posts.push({ url, body });
    if (url === "/feature-flags/evaluate") {
      evaluateCalls += 1;
      assert.deepEqual(body, {
        serverId: "server-flag-on",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      return {
        data: {
          migrationRef: "mig_abcdefghijklmnopqrstuv",
          state: "provisioning",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
          deadlines: {
            prepDeadlineAt: "2026-07-09T01:00:00.000Z",
          },
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await waitFor(() => assert.equal(evaluateCalls, 1));
  const entry = await screen.findByRole("button", { name: "Move to another computer" });
  fireEvent.click(entry);

  assert.ok(screen.getByRole("heading", { name: "Move to another computer" }));
  assert.ok(screen.getByText("Migration mode: stop before export"));
  assert.ok(screen.getByText(/Migration resets the current session/));
  assert.ok(screen.getByText(/workspace files, including MEMORY.md and notes when present/));
  assert.ok(screen.getByText(/conversation context reset/));
  const targetComputerSelect = screen.getByRole("combobox", { name: "Target computer" });
  assert.equal(targetComputerSelect.textContent?.trim(), "Target Computer");
  assert.equal(targetComputerSelect.tagName, "BUTTON");
  assert.ok(targetComputerSelect.querySelector('[data-slot="select-trigger-content"]'));

  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  await waitFor(() => {
    const start = posts.find((post) => post.url === "/agents/agent-1/migrate");
    assert.ok(start, "clicking the dialog submit should call the direct migration route");
    assert.deepEqual(start.body, {
      targetComputer: "target-machine",
    });
  });
  assert.equal(
    posts.some((post) => post.url.startsWith("/actions/")),
    false,
    "profile migration must not prepare or execute an action card",
  );
  assert.ok(screen.getByText("Stopping the agent on Source Computer so its workspace can be packed."));
  const progress = screen.getByRole("progressbar", { name: "Migration progress to Target Computer" });
  assert.equal(progress.getAttribute("aria-valuenow"), "13");
  assert.ok(screen.getByText("Stop agent"));
  assert.ok(screen.getByText("Pack workspace"));
  assert.ok(screen.getByText("Transfer files"));
  assert.ok(screen.getByText("Start on new computer"));
  assert.equal(
    (screen.getByRole("button", { name: "Migration in progress" }) as HTMLButtonElement).disabled,
    true,
  );
});

test("migration start consumes the canonical support ref and refreshes Cancel capability", async () => {
  const agent = seedPanelState("server-start-canonical-ref");
  const migrationRef = "mig_abcdefghijklmnopqrstuv";
  const canonical = {
    agentId: "agent-1",
    migrationRef,
    state: "provisioning",
    revision: 1,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    updatedAt: "2026-08-04T02:00:00.000Z",
  };
  let statusCalls = 0;
  let resolveRefresh!: (value: { data: unknown }) => void;
  const refreshResponse = new Promise<{ data: unknown }>((resolve) => {
    resolveRefresh = resolve;
  });
  stubAgentDetailApi();
  const fallbackGet = api.get;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      statusCalls += 1;
      return statusCalls === 1
        ? { data: { migration: null } } as never
        : refreshResponse as never;
    }
    return fallbackGet(url);
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      return {
        data: {
          migrationRef,
          state: "provisioning",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  const clipboardWrites: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { clipboardWrites.push(value); } },
  });

  renderPanel(agent);
  await waitFor(() => assert.equal(statusCalls, 1));
  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  await waitFor(() => assert.equal(statusCalls, 2));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(screen.queryByText(migrationRef), null, "the POST response must not seed visible migration state");
  assert.equal(screen.queryByRole("progressbar"), null);
  resolveRefresh({ data: { migration: canonical } });
  await screen.findByRole("button", { name: "Cancel migration" });
  fireEvent.click(screen.getByRole("button", { name: `Copy migration reference ${migrationRef}` }));
  await waitFor(() => assert.deepEqual(clipboardWrites, [migrationRef]));
  fireEvent.click(screen.getByRole("button", { name: "Cancel migration" }));
  const cancelDialog = screen.getByRole("dialog", { name: "Cancel migration?" });
  assert.ok(within(cancelDialog).getByText(migrationRef));
});

test("migration target uses the shared selector and submits the selected computer", async () => {
  const agent = seedPanelState("server-selector");
  const machines = useMachineStore.getState().machines;
  const target = machines.find((machine) => machine.id === "target-machine");
  assert.ok(target);
  useMachineStore.setState({
    machines: [
      ...machines,
      {
        ...target,
        id: "backup-machine",
        name: "Backup Computer",
      },
    ],
  });
  const posts: Array<{ url: string; body: unknown }> = [];
  stubAgentDetailApi();
  api.post = async (url: string, body?: unknown) => {
    posts.push({ url, body });
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      return {
        data: {
          migrationRef: "mig_abcdefghijklmnopqrstuv",
          state: "provisioning",
          sourceMachineId: "source-machine",
          targetMachineId: "backup-machine",
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  const selector = screen.getByRole("combobox", { name: "Target computer" });
  assert.equal(selector.tagName, "BUTTON");
  assert.ok(selector.querySelector('[data-slot="select-trigger-content"]'));
  selector.focus();
  fireEvent.keyDown(selector, { key: "ArrowDown" });
  const listbox = await screen.findByRole("listbox");
  assert.match(listbox.className, /max-h-64/);
  assert.deepEqual(
    within(listbox).getAllByRole("option").map((option) => option.textContent?.trim()),
    ["Target Computer", "Backup Computer"],
  );
  const backupOption = within(listbox).getByRole("option", { name: "Backup Computer" });
  fireEvent.pointerDown(backupOption, { pointerType: "mouse" });
  fireEvent.click(backupOption);
  await waitFor(() => assert.equal(selector.textContent?.trim(), "Backup Computer"));

  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));
  await waitFor(() => {
    assert.deepEqual(
      posts.find((post) => post.url === "/agents/agent-1/migrate")?.body,
      { targetComputer: "backup-machine" },
    );
  });
});

test("migration target selector shows a disabled empty state when no destination exists", async () => {
  const agent = seedPanelState("server-selector-empty");
  useMachineStore.setState((state) => ({
    machines: state.machines.filter((machine) => machine.id === "source-machine"),
  }));
  stubAgentDetailApi();
  stubMigrationFeatureFlag("server-selector-empty");

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  const selector = screen.getByRole("combobox", { name: "Target computer" });
  assert.equal(selector.textContent?.trim(), "No other attached computer");
  assert.equal((selector as HTMLButtonElement).disabled, true);
  assert.equal(
    (screen.getByRole("button", { name: "Start Migration" }) as HTMLButtonElement).disabled,
    true,
  );
});

test("migration profile entry keeps the latest completed migration visible at 100%", async () => {
  const agent = seedPanelState("server-migration-complete");
  let migrationStatusCalls = 0;
  stubAgentDetailApi();
  const fallbackGet = api.get;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      migrationStatusCalls += 1;
      const migration = migrationStatusCalls === 1
        ? null
          : {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "completed",
            revision: 1,
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            completedAt: "2026-07-14T06:00:00.000Z",
          };
      return { data: { migration } } as never;
    }
    return fallbackGet(url);
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-migration-complete",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      return {
        data: {
          migrationRef: "mig_abcdefghijklmnopqrstuv",
          state: "completed",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  await screen.findByText(/Agent moved to Target Computer and started successfully/);
  assert.equal(
    screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }).getAttribute("aria-valuenow"),
    "100",
  );
  assert.ok(screen.getByText("Complete"));
  assert.ok(screen.getByText("Moved from Source Computer to Target Computer"));
  assert.ok(screen.getByText(/Migration resets the current session/));
  assert.ok(screen.getByRole("button", { name: "Move to another computer" }));
});

test("migration profile entry shows typed transport failures inline", async () => {
  const agent = seedPanelState("server-typed-error");
  const transportFailures = [
    {
      error: "Migration transport is not provisioned",
      code: "MIGRATION_TRANSPORT_NOT_PROVISIONED",
      expected: "Raft could not prepare a secure transfer between these computers. Make sure both computers are online and up to date, then try again.",
    },
    {
      error: "Migration transport provisioning failed",
      code: "MIGRATION_TRANSPORT_PROVISION_FAILED",
      expected: "Raft could not prepare the transfer. Make sure both computers are online, then try again.",
    },
    {
      error: "Migration transport was lost",
      code: "MIGRATION_TRANSPORT_LOST",
      expected: "The connection between the two computers dropped during the transfer. Make sure both computers are online, then try again.",
    },
  ];
  stubAgentDetailApi();
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-typed-error",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      const failure = transportFailures.shift();
      assert.ok(failure, "test should only submit configured transport failure cases");
      const error = new Error(failure.error) as Error & {
        response?: { data?: { error?: string; code?: string } };
      };
      error.response = {
        data: failure,
      };
      throw error;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));

  for (const { code, expected } of [
    {
      code: "MIGRATION_TRANSPORT_NOT_PROVISIONED",
      expected: "Raft could not prepare a secure transfer between these computers. Make sure both computers are online and up to date, then try again.",
    },
    {
      code: "MIGRATION_TRANSPORT_PROVISION_FAILED",
      expected: "Raft could not prepare the transfer. Make sure both computers are online, then try again.",
    },
    {
      code: "MIGRATION_TRANSPORT_LOST",
      expected: "The connection between the two computers dropped during the transfer. Make sure both computers are online, then try again.",
    },
  ]) {
    fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));
    await screen.findByText(expected);
    assert.ok(screen.getByText(code));
  }
});

test("resumable capability error names the Computer and exposes recovery actions", async () => {
  const agent = seedPanelState("server-resumable-error");
  let startCalls = 0;
  stubAgentDetailApi();
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      startCalls += 1;
      const error = new Error("raw backend transport detail") as Error & {
        response?: { data?: { error?: string; code?: string; details?: unknown } };
      };
      error.response = {
        data: {
          error: "raw backend transport detail",
          code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
          details: {
            side: "target",
            reason: "capability_missing",
            capabilities: ["must-not-render"],
          },
        },
      };
      throw error;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  assert.ok(await screen.findByText(
    "Target Computer needs a Raft Computer update before it can move agents. Update Raft Computer on Target Computer to the latest version, restart it, wait for it to reconnect, then try again.",
  ));
  assert.equal(screen.queryByText("raw backend transport detail"), null);
  assert.equal(screen.queryByText("must-not-render"), null);
  const technicalCode = screen.getByText("MIGRATION_RESUMABLE_CAPABILITY_REQUIRED");
  const technicalDetails = technicalCode.closest("details");
  assert.ok(technicalDetails);
  assert.equal(technicalDetails.open, false);
  assert.ok(within(technicalDetails).getByText("Technical details"));

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => assert.equal(startCalls, 2));

  fireEvent.click(screen.getByRole("button", { name: "Open Computers" }));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/botiverse/computer/target-machine",
      "an online Computer without an upgrade badge must remain directly reachable from the failure",
    );
    assert.equal(screen.getByTestId("location-search").textContent, "");
  });
});

test("computer capability error renders every structured failure as a readable list", async () => {
  const agent = seedPanelState("server-capability-error");
  stubAgentDetailApi();
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      const error = new Error("raw aggregate error must not render") as Error & {
        response?: { data?: { error?: string; code?: string; details?: unknown } };
      };
      error.response = {
        data: {
          error: "raw aggregate error must not render",
          code: "COMPUTER_CAPABILITY_INSUFFICIENT",
          details: {
            failures: [
              { side: "source", reason: "runtime_unconfirmed", runtime: "codex" },
              { side: "target", reason: "runtime_missing", runtime: "codex" },
            ],
          },
        },
      };
      throw error;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  assert.ok(await screen.findByText("Fix these computer requirements before starting the migration:"));
  const sourceIssue = screen.getByText(
    "Source Computer has not reported whether Codex CLI is available. Start or restart Raft Computer and wait for runtime detection, or choose another computer.",
  );
  const targetIssue = screen.getByText(
    "Target Computer does not support Codex CLI. Install or enable that runtime on this computer, or choose another computer.",
  );
  assert.equal(sourceIssue.closest("li")?.parentElement?.tagName, "UL");
  assert.equal(targetIssue.closest("li")?.parentElement?.tagName, "UL");
  assert.equal(screen.queryByText("raw aggregate error must not render"), null);
  assert.ok(screen.getByRole("button", { name: "Open Computers" }));
});

test("resumable capability recovery copy and actions render in zh-CN", async () => {
  const agent = seedPanelState("server-resumable-error-zh");
  stubAgentDetailApi();
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      const error = new Error("raw backend transport detail") as Error & {
        response?: { data?: { error?: string; code?: string; details?: unknown } };
      };
      error.response = {
        data: {
          error: "raw backend transport detail",
          code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
          details: {
            side: "source",
            reason: "capability_missing",
          },
        },
      };
      throw error;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent, "zh-cn");
  fireEvent.click(await screen.findByRole("button", { name: "迁移到另一台计算机" }));
  fireEvent.click(screen.getByRole("button", { name: "开始迁移" }));

  assert.ok(await screen.findByText(
    "Source Computer 需要先更新 Raft Computer 才能迁移 Agent。请将 Source Computer 上的 Raft Computer 更新到最新版本，重启并等待重新连接后再试。",
  ));
  assert.ok(screen.getByRole("button", { name: "打开 Computer 列表" }));
  assert.ok(screen.getByRole("button", { name: "重试" }));
  assert.ok(screen.getByText("技术详情"));
  assert.equal(screen.queryByText("raw backend transport detail"), null);
});

test("migration profile entry restores persisted migration status after refresh", async () => {
  const agent = seedPanelState("server-persisted-status");
  let statusCalls = 0;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      statusCalls += 1;
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "in_transit",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-persisted-status",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await waitFor(() => assert.equal(statusCalls, 1));
  assert.ok(screen.getByText("Transferring workspace to Target Computer."));
  assert.equal(
    screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }).getAttribute("aria-valuenow"),
    "63",
  );
});

for (const { state, extra, expectedProgress, expectedMessage } of ([
  { state: "provisioning", expectedProgress: "13", expectedMessage: "Stopping the agent on Source Computer so its workspace can be packed." },
  {
    state: "provisioning",
    extra: { sourceQuiescedAt: new Date().toISOString() },
    expectedProgress: "38",
    expectedMessage: "Packing the workspace on Source Computer. Large workspaces can take up to 30 minutes.",
  },
  {
    state: "provisioning",
    extra: { sourceQuiescedAt: new Date(Date.now() - 5 * 60_000 - 1_000).toISOString() },
    expectedProgress: "38",
    expectedMessage: "Packing the workspace on Source Computer (5 minutes so far). Large workspaces can take up to 30 minutes.",
  },
  {
    state: "provisioning",
    extra: {
      sourceQuiescedAt: new Date().toISOString(),
      sourceBuildProgress: { phase: "packing", files: 41_000, bytes: 2.3 * 1024 ** 3, reportedAt: new Date().toISOString() },
    },
    expectedProgress: "38",
    expectedMessage: "Packing the workspace on Source Computer: 41,000 files, 2.3 GB so far.",
  },
  {
    state: "provisioning",
    extra: { sourceQuiescedAt: new Date().toISOString(), transportControlRegisteredAt: new Date().toISOString() },
    expectedProgress: "63",
    expectedMessage: "Uploading the workspace from Source Computer for Target Computer.",
  },
  // Legacy enum value that is never written; presented as packing.
  { state: "prep", expectedProgress: "38", expectedMessage: "Packing the workspace on Source Computer. Large workspaces can take up to 30 minutes." },
  { state: "ready", expectedProgress: "63", expectedMessage: "Workspace bundle is ready. Starting transfer to Target Computer." },
  { state: "in_transit", expectedProgress: "63", expectedMessage: "Transferring workspace to Target Computer." },
  { state: "arriving", expectedProgress: "88", expectedMessage: "Starting the agent on Target Computer." },
  { state: "starting", expectedProgress: "88", expectedMessage: "Starting the agent on Target Computer." },
] as Array<{ state: string; extra?: Record<string, unknown>; expectedProgress: string; expectedMessage: string }>)) {
  test(`migration profile entry renders persisted ${state} progress: ${expectedMessage}`, async () => {
    const serverId = `server-active-${state}-${expectedProgress}-${expectedMessage.length}`;
    const agent = seedPanelState(serverId);
    const migration = {
      agentId: "agent-1",
      migrationRef: "mig_abcdefghijklmnopqrstuv",
      state,
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      updatedAt: "2026-07-14T06:00:00.000Z",
      ...extra,
    };
    stubAgentDetailApi(migration);
    stubMigrationFeatureFlag(serverId);

    renderPanel(agent);

    await screen.findByText(expectedMessage);
    assert.equal(
      screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }).getAttribute("aria-valuenow"),
      expectedProgress,
    );
    assert.equal(
      screen.getByLabelText("Migration to Target Computer").querySelectorAll('[data-slot="progress"][data-variant="accent"], [class~="theme-brutal:bg-brutal-pink"]').length,
      2,
      "active fill and current-step marker must share the migration pink intent",
    );
    assert.equal(
      (screen.getByRole("button", { name: "Migration in progress" }) as HTMLButtonElement).disabled,
      true,
    );
  });
}

test("migration profile entry keeps prior progress across a temporary poll failure", async () => {
  const agent = seedPanelState("server-poll-failure");
  let statusCalls = 0;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      statusCalls += 1;
      if (statusCalls > 1) throw new Error("temporary status outage");
      const migration = {
        agentId: "agent-1",
        migrationRef: "mig_abcdefghijklmnopqrstuv",
        state: "in_transit",
        sourceMachineId: "source-machine",
        targetMachineId: "target-machine",
      };
      return { data: { migration } } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  stubMigrationFeatureFlag("server-poll-failure");

  renderPanel(agent);

  await screen.findByText("Transferring workspace to Target Computer.");
  await waitFor(() => assert.equal(statusCalls, 2), { timeout: 3_500 });
  assert.equal(
    screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }).getAttribute("aria-valuenow"),
    "63",
  );
  assert.ok(screen.getByText("Migration status unavailable"));
});

test("migration profile entry polls active progress until the persisted terminal state", async () => {
  const agent = seedPanelState("server-polling-progress");
  let statusCalls = 0;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      statusCalls += 1;
      const migration = statusCalls === 1
        ? null
        : statusCalls === 2
          ? {
              agentId: "agent-1",
              migrationRef: "mig_abcdefghijklmnopqrstuv",
              state: "provisioning",
              revision: 1,
              sourceMachineId: "source-machine",
              targetMachineId: "target-machine",
            }
          : {
              agentId: "agent-1",
              migrationRef: "mig_abcdefghijklmnopqrstuv",
              state: "completed",
              revision: 2,
              sourceMachineId: "source-machine",
              targetMachineId: "target-machine",
              completedAt: "2026-07-14T06:00:00.000Z",
            };
      return {
        data: {
          migration,
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-polling-progress",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      return {
        data: {
          migrationRef: "mig_abcdefghijklmnopqrstuv",
          state: "provisioning",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));
  await screen.findByText("Stopping the agent on Source Computer so its workspace can be packed.");
  assert.equal(statusCalls, 2);

  await waitFor(() => {
    assert.equal(statusCalls, 3);
    assert.ok(screen.getAllByText(/Agent moved to Target Computer and started successfully/).length >= 1);
  }, { timeout: 3_500 });
  assert.equal(
    screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }).getAttribute("aria-valuenow"),
    "100",
  );
  assert.ok(screen.getByText(/Migration resets the current session/));
  assert.ok(screen.getByRole("button", { name: "Move to another computer" }));
});

test("completed migration renders localized route and continuity copy without transfer breakdown", async () => {
  const agent = seedPanelState("server-completed-summary-zh");
  const migration = {
    agentId: "agent-1",
    migrationRef: "mig_abcdefghijklmnopqrstuv",
    state: "completed",
    revision: 2,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    completedAt: "2026-07-14T06:00:00.000Z",
  };
  stubAgentDetailApi(migration);
  stubMigrationFeatureFlag("server-completed-summary-zh");

  renderPanel(agent, "zh-cn");

  assert.equal(
    (await screen.findByRole("progressbar", { name: "迁移到 Target Computer 的进度" }))
      .getAttribute("aria-valuenow"),
    "100",
  );
  const summary = screen.getByTestId("migration-completion-summary");
  assert.ok(within(summary).getByText("已从 Source Computer 迁移至 Target Computer"));
  assert.ok(within(summary).getByText(/目标工作区已提交/));
  assert.ok(within(summary).getByText(/MEMORY.md 和 notes/));
  assert.equal(within(summary).queryByText(/sha256|workspacePathRef|\/Users\//i), null);
});

test("prep deadline abort copy is source-specific instead of blaming both computers", async () => {
  const agent = seedPanelState("server-aborted-prep");
  const migration = {
    agentId: "agent-1",
    migrationRef: "mig_abcdefghijklmnopqrstuv",
    state: "aborted",
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    abortReason: "prep-deadline",
    abortedAt: "2026-07-14T06:00:00.000Z",
  };
  stubAgentDetailApi(migration);
  stubMigrationFeatureFlag("server-aborted-prep");

  renderPanel(agent);

  // Task #229 rewrote this sentence. The property the test protects is
  // unchanged — the copy names the source Computer and never tells the user to
  // check "both Computers" — but it must no longer assert workspace size as the
  // cause, and with no prepDeadlineAt on the notice (the realtime shape carries
  // none) it must fall back to the variant that states no time at all.
  assert.ok(await screen.findByText(
    "Preparing the workspace on Source Computer stopped making progress before the deadline. "
    + "Source Computer may have gone offline, or packing stalled. Make sure Source Computer is "
    + "online, then try again.",
  ));
  assert.equal(screen.queryByText(/both Computers.*online/i), null);
  assert.equal(screen.queryByText(/Large workspaces/i), null);
  // Before the flip the agent never left: that is said first, on its own line.
  assert.ok(screen.getByText("The agent is still on Source Computer and works as usual."));
});

test("prep deadline abort copy shows the real deadline when the REST snapshot carries one", async () => {
  // prepDeadlineAt reaches the client only over REST; this proves the dated
  // variant is selected and rendered end-to-end, not just unit-selected.
  const agent = seedPanelState("server-aborted-prep-dated");
  stubAgentDetailApi({
    agentId: "agent-1",
    migrationRef: "mig_abcdefghijklmnopqrstuv",
    state: "aborted",
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    abortReason: "prep-deadline",
    abortedAt: "2026-07-14T06:00:00.000Z",
    prepDeadlineAt: "2026-07-14T05:50:00.000Z",
  });
  stubMigrationFeatureFlag("server-aborted-prep-dated");

  renderPanel(agent);

  assert.ok(await screen.findByText(/stopped making progress before the deadline \(/));
  assert.equal(screen.queryByText(/Large workspaces/i), null);
});

test("migration profile entry shows persisted typed transport failure after refresh", async () => {
  const agent = seedPanelState("server-persisted-failure");
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, status: "online", lastHeartbeat: "2026-07-10T07:59:00.000Z" }
      : { ...machine, status: "offline", lastHeartbeat: "2026-07-10T07:57:59.999Z" }),
  }));
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "failed",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            failureReason: "transport_lost",
            abortReason: null,
            transportErrorCode: "MIGRATION_TRANSPORT_LOST",
            transportErrorMessage: "Target transfer object did not appear before deadline",
            transportLostAt: "2026-07-10T08:00:00.000Z",
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-persisted-failure",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await screen.findByText("Migration failed");
  assert.ok(screen.getByText("The agent is still on Source Computer and works as usual."));
  assert.ok(screen.getByText(/^The connection between the two computers dropped at .*, during the transfer\. Bring Target Computer online, then try again\.$/));
  assert.ok(screen.queryByText(/heartbeat/) === null);
  assert.ok(screen.getByText("MIGRATION_TRANSPORT_LOST"));
  assert.equal(screen.queryByText(/Target transfer object did not appear before deadline/), null);
  assert.ok(screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }));
  assert.ok(screen.getByRole("button", { name: "Try migration again" }));
});

test("the latest row shows the canonical migration reference and Copy preserves the exact value", async () => {
  const agent = seedPanelState("server-migration-refs");
  const activeRef = "mig_abcdefghijklmnopqrstuv";
  const active = {
    agentId: "agent-1",
    migrationRef: activeRef,
    state: "in_transit",
    revision: 4,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    updatedAt: "2026-07-20T08:00:00.000Z",
  };
  const clipboardWrites: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { clipboardWrites.push(value); } },
  });
  stubAgentDetailApi(active);
  stubMigrationFeatureFlag("server-migration-refs");

  renderPanel(agent);

  await screen.findByText(activeRef);
  fireEvent.click(screen.getByRole("button", { name: `Copy migration reference ${activeRef}` }));
  await waitFor(() => assert.deepEqual(clipboardWrites, [activeRef]));
  assert.ok(screen.getByRole("button", { name: "Migration reference copied" }));
});

test("Cancel uses one safe dialog without client-side phase guessing", async () => {
  const agent = seedPanelState("server-migration-cancel");
  const migrationRef = "mig_abcdefghijklmnopqrstuv";
  const active = {
    agentId: "agent-1",
    migrationRef,
    state: "provisioning",
    revision: 3,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    updatedAt: "2026-07-20T08:00:00.000Z",
  };
  stubAgentDetailApi(active);
  stubMigrationFeatureFlag("server-migration-cancel");

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Cancel migration" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel migration?" });
  assert.ok(within(dialog).getByText("Safe cancellation"));
  assert.ok(within(dialog).getByText(/preserve the authoritative Computer/));
  assert.ok(within(dialog).getByText(migrationRef));
  assert.equal(within(dialog).queryByText("Before computer switch"), null);
  assert.equal(within(dialog).queryByText("After computer switch"), null);
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep migration" }));
  await waitFor(() => assert.equal(document.querySelector('[role="dialog"]'), null));
});

test("successful Cancel discards its POST representation and refetches authoritative status", async () => {
  const agent = seedPanelState("server-migration-cancel-refresh");
  const migrationRef = "mig_abcdefghijklmnopqrstuv";
  const active = {
    agentId: "agent-1",
    migrationRef,
    state: "provisioning",
    revision: 3,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    updatedAt: "2026-07-20T08:00:00.000Z",
  };
  let statusCalls = 0;
  stubAgentDetailApi(active);
  const statusGet = api.get;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      statusCalls += 1;
      return { data: { migration: statusCalls === 1 ? active : null } } as never;
    }
    return statusGet(url);
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migration/cancel") {
      return {
        data: {
          ...active,
          state: "canceled_pre_flip",
          revision: 4,
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel migration" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel migration?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel migration" }));

  await waitFor(() => assert.equal(statusCalls, 2));
  assert.equal(
    screen.queryByText(/migration was canceled before the computer switch/i),
    null,
    "the cancel POST response must not project terminal state",
  );
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Cancel migration?" }), null));
  assert.ok(screen.getByRole("button", { name: "Move to another computer" }));
});

for (const [state, message] of [
  ["canceled_pre_flip", "The migration was canceled before the computer switch. The agent remains on the source computer."],
  ["canceled_post_flip", "The migration was canceled after the computer switch. The migrated agent was stopped and cleanup was confirmed."],
] as const) {
  test(`${state} renders as a terminal canceled outcome`, async () => {
    const serverId = `server-${state}`;
    const agent = seedPanelState(serverId);
    stubAgentDetailApi({
      agentId: "agent-1",
      migrationRef: "mig_abcdefghijklmnopqrstuv",
      state,
      revision: 9,
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      canceledAt: "2026-07-20T08:02:00.000Z",
    });
    stubMigrationFeatureFlag(serverId);

    renderPanel(agent);

    assert.ok(await screen.findByText(message));
    assert.ok(screen.getByText("Migration to Target Computer canceled"));
    assert.equal(screen.queryByText("Moving to Target Computer"), null);
    assert.ok(screen.getByText("Canceled"));
    assert.equal(screen.queryByText("In progress"), null);
    assert.equal(screen.queryByRole("button", { name: "Migration in progress" }), null);
    assert.ok(screen.getByRole("button", { name: "Move to another computer" }));
  });
}

const MOVING_MIGRATION_STATES = new Set([
  "provisioning",
  "prep",
  "ready",
  "in_transit",
  "arriving",
  "starting",
]);

for (const state of AGENT_MIGRATION_STATES.filter((candidate) => !MOVING_MIGRATION_STATES.has(candidate))) {
  test(`${state} never uses the active moving header`, async () => {
    const serverId = `server-migration-header-${state}`;
    const agent = seedPanelState(serverId);
    stubAgentDetailApi({
      agentId: "agent-1",
      migrationRef: "mig_abcdefghijklmnopqrstuv",
      state,
      revision: 9,
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      updatedAt: "2026-07-20T08:02:00.000Z",
    });
    stubMigrationFeatureFlag(serverId);

    renderPanel(agent);

    await screen.findByText("mig_abcdefghijklmnopqrstuv");
    assert.equal(screen.queryByText("Moving to Target Computer"), null);
  });
}

for (const [state, extra] of [
  ["starting", { failureReason: "auto_start_failed" }],
  ["cancel_requested_pre_flip", { cancelNeedsAttention: true }],
  ["cancel_requested_post_flip", { cancelNeedsAttention: true }],
] as const) {
  test(`${state} needs-attention presentation never uses the active moving header`, async () => {
    const serverId = `server-migration-header-attention-${state}`;
    const agent = seedPanelState(serverId);
    stubAgentDetailApi({
      agentId: "agent-1",
      migrationRef: "mig_abcdefghijklmnopqrstuv",
      state,
      revision: 9,
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      updatedAt: "2026-07-20T08:02:00.000Z",
      ...extra,
    });
    stubMigrationFeatureFlag(serverId);

    renderPanel(agent);

    assert.ok(await screen.findByText("Migration to Target Computer needs attention"));
    assert.equal(screen.queryByText("Moving to Target Computer"), null);
  });
}

test("Cancel failure refreshes status and never presents terminal success", { timeout: 8_000 }, async () => {
  const agent = seedPanelState("server-migration-cancel-failure");
  const migrationRef = "mig_abcdefghijklmnopqrstuv";
  const active = {
    agentId: "agent-1",
    migrationRef,
    state: "arriving",
    revision: 7,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    flippedAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T08:01:00.000Z",
  };
  let statusCalls = 0;
  stubAgentDetailApi(active);
  const statusGet = api.get;
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") statusCalls += 1;
    return statusGet(url);
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migration/cancel") {
      throw { response: { data: { code: "MIGRATION_REVISION_STALE" } } };
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Cancel migration" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel migration?" });
  assert.ok(within(dialog).getByText("Safe cancellation"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel migration" }));
  await within(dialog).findByText(/migration changed before cancellation was submitted/i);
  await waitFor(() => assert.equal(statusCalls, 2));
  assert.equal(screen.queryByText("Migration canceled"), null);
  assert.ok(within(dialog).getByRole("button", { name: "Cancel migration" }));
});

test("migration profile entry shows a retryable automatic-start failure after arrival", async () => {
  const agent = seedPanelState("server-auto-start-failure");
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "starting",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            failureReason: "auto_start_failed",
            arrivedAt: "2026-07-14T06:00:00.000Z",
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-auto-start-failure",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await screen.findByText("Agent did not start");
  assert.ok(screen.getByText("The workspace moved to Target Computer, but the agent did not start automatically."));
  assert.ok(screen.getByText("auto_start_failed"));
  assert.equal(screen.getByRole("button", { name: "Migration in progress" }).hasAttribute("disabled"), true);
});

test("migration profile entry translates bundle-too-large wire payload without exposing it", async () => {
  const agent = seedPanelState("server-bundle-too-large");
  const wireMessage = "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=3690465725:maxBytes=3221225472:topEntries=.git%2F,2147483648;archive.tar,1073741824;media%2F,536870912";
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "failed",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            failureReason: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
            abortReason: null,
            transportErrorCode: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
            transportErrorMessage: wireMessage,
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-bundle-too-large",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await screen.findByText("Migration failed");
  assert.ok(screen.getByText("The workspace is too large to move: compressed, it is over the 3 GiB limit. Largest items: .git/ (2 GiB), archive.tar (1 GiB), media/ (0.5 GiB). Ask the agent to delete large files it no longer needs, or to list them in .raftmigrateignore, then try again."));
  assert.ok(screen.getByText("MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE"));
  assert.equal(screen.queryByText(wireMessage), null);
  assert.equal(document.body.textContent?.includes("actualBytes="), false);
  assert.equal(document.body.textContent?.includes("maxBytes="), false);
});

test("migration profile entry fails closed when a new wire error has no copy yet", async () => {
  const agent = seedPanelState("server-unknown-migration-error");
  const wireMessage = "MIGRATION_FUTURE_FAILURE:quotedTable=secrets:params=token";
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "failed",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            failureReason: "MIGRATION_FUTURE_FAILURE",
            abortReason: null,
            transportErrorCode: "MIGRATION_FUTURE_FAILURE",
            transportErrorMessage: wireMessage,
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-unknown-migration-error",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await screen.findByText("Something went wrong during the transfer. Try again.");
  assert.ok(screen.getByText("The agent is still on Source Computer and works as usual."));
  assert.ok(screen.getByText("MIGRATION_FUTURE_FAILURE"));
  assert.equal(screen.queryByText(wireMessage), null);
  assert.equal(document.body.textContent?.includes("quotedTable="), false);
  assert.equal(document.body.textContent?.includes("params="), false);
});

test("a migration that failed after the move says the agent is on the target, not the source", async () => {
  const agent = seedPanelState("server-failed-after-flip");
  api.get = async (url: string) => {
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } } as never;
    if (url === "/agents/agent-1/migration") {
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "failed",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            failureReason: "auto_start_failed",
            abortReason: null,
            flippedAt: "2026-07-10T08:00:00.000Z",
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  stubMigrationFeatureFlag("server-failed-after-flip");

  renderPanel(agent);

  await screen.findByText(
    "The agent moved to Target Computer but could not start there. Make sure Raft Computer is running on Target Computer, then start the agent.",
  );
  assert.ok(screen.queryByText(/still on Source Computer/) === null);
  assert.ok(screen.getByText("auto_start_failed"));
});
