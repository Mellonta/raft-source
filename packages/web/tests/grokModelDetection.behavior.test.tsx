import "./helpers/domSetup";
import assert from "node:assert/strict";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import RuntimeConfigFields from "../src/components/agent/RuntimeConfigFields";
import { useRuntimeModels } from "../src/hooks/useRuntimeModels";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get;
afterEach(() => {
  api.get = originalGet;
  cleanup();
  useServerStore.getState().clearCurrent();
});

function Fields() {
  const models = useRuntimeModels("machine-grok", "grok");
  const [model, setModel] = useState("grok-4.5");
  const noop = () => undefined;
  return <RuntimeConfigFields
    runtime="grok" onRuntimeChange={noop} runtimeOptions={[{ value: "grok", label: "Grok" }]}
    model={model} onModelChange={setModel} customModelMode={false} onCustomModelModeChange={noop}
    modelOptions={models.models.map((m) => ({ value: m.id, label: m.label }))} runtimeModels={models}
    providerMode="default" onProviderModeChange={noop} providerApiUrl="" onProviderApiUrlChange={noop}
    providerApiKey="" onProviderApiKeyChange={noop} builtInProviderMode="deepseek" onBuiltInProviderModeChange={noop}
    piProviderMode="configured" onPiProviderModeChange={noop} piProviderApiKey="" onPiProviderApiKeyChange={noop}
    fastMode={false} onFastModeChange={noop} command="" onCommandChange={noop}
    reasoningEffort={null} onReasoningEffortChange={noop} envVarEntries={[]} onEnvVarEntriesChange={noop}
  />;
}

test("Grok failure shows recovery, selectable fallback and successful retry", async () => {
  useServerStore.setState({ current: { id: "server-grok" } as Server });
  let calls = 0;
  api.get = (async () => ({
    data: ++calls === 1
      ? { kind: "error", retryable: true, code: "runtime_not_authenticated" }
      : { kind: "live", value: { models: [{ id: "grok-4.6", label: "Grok 4.6" }, { id: "grok-4.5", label: "Grok 4.5" }] } },
  })) as typeof api.get;
  render(<TestIntlProvider locale="en"><Fields /></TestIntlProvider>);
  await waitFor(() => assert.ok(screen.getByText(/grok login/)));
  assert.ok(screen.getByText(/not been verified/));
  const modelSelect = screen.getAllByRole("combobox").find((element) => element.textContent?.includes("Grok 4.5"));
  assert.ok(modelSelect);
  fireEvent.click(modelSelect);
  const option = await screen.findByRole("option", { name: "Grok 4.6" });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
  await waitFor(() => assert.match(modelSelect.textContent ?? "", /Grok 4.6/));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  // The login prompt clears as soon as the retry starts loading, before the
  // live catalog (and so the "Grok 4.6" label) arrives; wait for the settled state.
  await waitFor(() => {
    assert.equal(screen.queryByText(/grok login/), null);
    assert.equal(screen.queryByText(/not been verified/), null);
    assert.match(modelSelect.textContent ?? "", /Grok 4.6/);
  });
  assert.equal(calls, 2);
});
