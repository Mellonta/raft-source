import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { ServerModelLabelCatalog } from "@botiverse/raft-shared";
import api from "../src/api/client";
import {
  catalogModelLabel,
  modelLabelFromCatalog,
  useModelLabelCatalogStore,
} from "../src/store/modelLabelCatalogStore";
import { useServerStore } from "../src/store/serverStore";
import { agentModelLabel } from "../src/utils/agentModelName";
import { projectRuntimeModelLabelPresentation } from "../src/hooks/useRuntimeModels";

const CATALOG: ServerModelLabelCatalog = {
  machines: {
    "machine-1": {
      runtimes: {
        codex: {
          models: [
            { id: "gpt-6-astra", label: "GPT-6-Astra" },
            { id: "kimi-code/k3-256k", label: "K3-256k" },
          ],
          updatedAt: "2026-09-29T09:00:00.000Z",
        },
      },
    },
  },
};

function setCatalog(catalog: ServerModelLabelCatalog | undefined) {
  useServerStore.setState({ current: { id: "server-1" } as never });
  useModelLabelCatalogStore.setState({
    byServer: catalog
      ? { "server-1": { catalog, fetchedAt: Date.now() } }
      : {},
    inflight: {},
  });
}

afterEach(() => {
  useServerStore.setState({ current: null });
  useModelLabelCatalogStore.setState({ byServer: {}, inflight: {}, lastAttemptAt: {} });
});

test("modelLabelFromCatalog resolves (machine, runtime, id) and misses cleanly", () => {
  assert.equal(modelLabelFromCatalog(CATALOG, "machine-1", "codex", "kimi-code/k3-256k"), "K3-256k");
  assert.equal(modelLabelFromCatalog(CATALOG, "machine-1", "codex", "unknown"), null);
  assert.equal(modelLabelFromCatalog(CATALOG, "machine-2", "codex", "gpt-6-astra"), null);
  assert.equal(modelLabelFromCatalog(undefined, "machine-1", "codex", "gpt-6-astra"), null);
});

test("the store loads a server catalog once and serves it synchronously", async () => {
  const originalGet = api.get;
  let calls = 0;
  const catalog: ServerModelLabelCatalog = { machines: { "machine-1": { runtimes: { claude: { models: [{ id: "opus", label: "Claude Opus" }], updatedAt: "t" } } } } };
  api.get = (async () => {
    calls += 1;
    return { data: catalog };
  }) as typeof api.get;
  try {
    useModelLabelCatalogStore.getState().load("server-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    assert.equal(catalogModelLabel("server-1", "machine-1", "claude", "opus"), "Claude Opus");
    // A cached catalog is not re-fetched inside the cache window.
    useModelLabelCatalogStore.getState().load("server-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);
  } finally {
    api.get = originalGet;
  }
});

test("agent model labels prefer the shared catalog and fall back to the bundled table", () => {
  setCatalog(CATALOG);
  assert.equal(
    agentModelLabel({ runtime: "codex", model: "kimi-code/k3-256k", machineId: "machine-1" }),
    "K3-256k",
    "the daemon-reported name wins over the local fallback",
  );
  setCatalog(undefined);
  assert.equal(
    agentModelLabel({ runtime: "codex", model: "kimi-code/k3-256k", machineId: "machine-1" }),
    "kimi-code/k3-256k",
    "without a catalog the bundled fallback chain still answers",
  );
});

test("the panel/profile presentation is catalog-first", () => {
  const runtimeModels = { models: [], source: { kind: "idle" } as const };
  setCatalog(CATALOG);
  assert.deepEqual(
    projectRuntimeModelLabelPresentation("codex", "kimi-code/k3-256k", runtimeModels, "machine-1"),
    { kind: "resolved", label: "K3-256k" },
  );
  setCatalog(undefined);
  assert.deepEqual(
    projectRuntimeModelLabelPresentation("codex", "gpt-6-astra", runtimeModels, "machine-1"),
    { kind: "resolved", label: "GPT-6-Astra" },
    "without a catalog the configured/table fallback still answers",
  );
});
