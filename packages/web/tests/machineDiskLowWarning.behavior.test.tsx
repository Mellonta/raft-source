import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ServerRole } from "@botiverse/raft-shared";

import { useSystemNotifications } from "../src/components/layout/useSystemNotifications";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { machineDiskLowPresentation } from "../src/utils/machineDiskPresentation";
import { TestIntlProvider } from "./helpers/intl";

const GIB = 1024 ** 3;

function makeServer(role: ServerRole): Server {
  return {
    id: "server-1",
    name: "Server One",
    avatarUrl: null,
    slug: "server-one",
    ownerId: "owner-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role,
    createdAt: new Date(0).toISOString(),
  };
}

function computer(overrides: Partial<Machine>): Machine {
  return {
    id: "computer-1",
    name: "Studio Mac",
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: null,
    os: "darwin",
    daemonVersion: "1.0.0",
    lastHeartbeat: null,
    createdAt: new Date(0).toISOString(),
    isComputer: true,
    computerAttachedByCurrentUser: true,
    diskStatus: { availableBytes: 8 * GIB, totalBytes: 100 * GIB },
    ...overrides,
  };
}

function seed(machines: Machine[]): void {
  useServerStore.setState({ current: makeServer("member"), members: [] });
  useMachineStore.setState({ machines, latestComputerVersion: null, loading: false });
  useAgentStore.setState({ agents: [], loading: false });
}

function renderNotifications(locale?: "zh-cn") {
  return renderHook(() => useSystemNotifications(), {
    wrapper({ children }) {
      return (
        <TestIntlProvider {...(locale ? { locale } : {})}>
          <MemoryRouter>{children}</MemoryRouter>
        </TestIntlProvider>
      );
    },
  });
}

afterEach(() => {
  cleanup();
  useServerStore.getState().clearCurrent();
  useMachineStore.setState({ machines: [], loading: true });
  useAgentStore.setState({ agents: [], loading: true });
});

const format = ((descriptor: { id: string }, values?: Record<string, unknown>) =>
  `${descriptor.id}:${JSON.stringify(values ?? {})}`) as never;

test("the low-disk presentation needs an online machine under 10% free and bands the severity", () => {
  assert.equal(machineDiskLowPresentation(computer({ diskStatus: { availableBytes: 10 * GIB, totalBytes: 100 * GIB } }), format), null);
  assert.equal(machineDiskLowPresentation(computer({ status: "offline" }), format), null);
  assert.equal(machineDiskLowPresentation(computer({ diskStatus: null }), format), null);
  assert.equal(machineDiskLowPresentation(computer({}), format)?.band, "under10");
  assert.equal(machineDiskLowPresentation(computer({ diskStatus: { availableBytes: 4 * GIB, totalBytes: 100 * GIB } }), format)?.band, "under5");
  assert.equal(machineDiskLowPresentation(computer({ diskStatus: { availableBytes: GIB / 2, totalBytes: 100 * GIB } }), format)?.band, "under1");
  assert.equal(machineDiskLowPresentation(computer({}), format)?.freePercent, 8);
});

test("only the person who added the Computer is notified, without naming it", () => {
  seed([computer({}), computer({ id: "computer-2", name: "Lab Box", computerAttachedByCurrentUser: false })]);

  const { result } = renderNotifications();

  const entry = result.current.find((notification) => notification.id === "machine-disk-low");
  assert.ok(entry);
  assert.equal(entry.kind, "warning");
  assert.equal(entry.title, "A computer you added is low on disk space");
  assert.equal(entry.dismissalKey, "machine-disk-low:computer-1=under10");
  assert.ok(!entry.title.includes("Studio Mac") && !entry.title.includes("Lab Box"));
});

test("no disk notification for other people's Computers, offline ones, or enough space", () => {
  seed([
    computer({ computerAttachedByCurrentUser: false }),
    computer({ id: "computer-2", status: "offline" }),
    computer({ id: "computer-3", diskStatus: { availableBytes: 50 * GIB, totalBytes: 100 * GIB } }),
  ]);

  const { result } = renderNotifications();

  assert.ok(!result.current.some((notification) => notification.id === "machine-disk-low"));
});

test("a dismissed disk notification returns only when free space falls into a worse band", () => {
  seed([computer({})]);
  const before = renderNotifications().result.current.find((n) => n.id === "machine-disk-low")?.dismissalKey;
  cleanup();
  seed([computer({ diskStatus: { availableBytes: 7 * GIB, totalBytes: 100 * GIB } })]);
  const same = renderNotifications().result.current.find((n) => n.id === "machine-disk-low")?.dismissalKey;
  cleanup();
  seed([computer({ diskStatus: { availableBytes: 3 * GIB, totalBytes: 100 * GIB } })]);
  const worse = renderNotifications().result.current.find((n) => n.id === "machine-disk-low")?.dismissalKey;

  assert.equal(before, same);
  assert.notEqual(before, worse);
});

test("the disk notification follows the app locale", () => {
  seed([computer({})]);

  const { result } = renderNotifications("zh-cn");

  const entry = result.current.find((notification) => notification.id === "machine-disk-low");
  assert.equal(entry?.title, "你添加的 1 台计算机磁盘空间不足");
});
