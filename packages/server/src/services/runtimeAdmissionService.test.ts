import assert from "node:assert/strict";
import { RUNTIMES } from "@botiverse/raft-shared";
import {
  projectExistingAgentRuntimeOptions,
  projectNewAgentRuntimeOptions,
  projectSetupRuntimeOptions,
} from "./runtimeAdmissionService";
import { KIMI_SDK_FORM_DEFINITION_REF } from "./runtimeFormDefinitionService";
import { removeRuntimeFormV2EntryForTests } from "./runtimeFormV2Registry";

test("new-agent runtime options keep capability separate from admission", () => {
  const disabled = projectNewAgentRuntimeOptions(["codex", "grok"], {
    grokRuntimeEnabled: false,
  });
  assert.equal(disabled.some((option) => option.runtimeId === "grok"), false);
  assert.deepEqual(disabled.find((option) => option.runtimeId === "codex"), {
    runtimeId: "codex",
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: true,
    // Additive (batch 3a): Codex has a v2 form.
    runtimeFormV2: { protocolVersion: 2 },
  });

  const enabled = projectNewAgentRuntimeOptions(["codex", "grok"], {
    grokRuntimeEnabled: true,
  });
  assert.deepEqual(enabled.find((option) => option.runtimeId === "grok"), {
    runtimeId: "grok",
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: true,
    // Additive (batch 3a): Grok has a v2 form; the row, and so the marker, follows the grok flag.
    runtimeFormV2: { protocolVersion: 2 },
  });
});

test("new-agent runtime options distinguish local install from computer update", () => {
  const options = projectNewAgentRuntimeOptions([], { grokRuntimeEnabled: false });
  assert.equal(options.find((option) => option.runtimeId === "claude")?.capabilityStatus, "not_installed");
  assert.equal(options.find((option) => option.runtimeId === "builtin")?.capabilityStatus, "update_required");
  assert.equal(options.find((option) => option.runtimeId === "claude")?.canSelectInThisContext, false);
  assert.equal(options.find((option) => option.runtimeId === "builtin")?.canSelectInThisContext, false);
});

test("Kimi runtime options advertise the versioned schema form for create and edit", () => {
  const createOption = projectNewAgentRuntimeOptions(["kimi-sdk"], {
    grokRuntimeEnabled: false,
  }).find((option) => option.runtimeId === "kimi-sdk");
  assert.deepEqual(createOption?.formDefinitionRef, KIMI_SDK_FORM_DEFINITION_REF);

  const editOption = projectExistingAgentRuntimeOptions(["kimi-sdk"], "kimi-sdk", {
    grokRuntimeEnabled: false,
  }).find((option) => option.runtimeId === "kimi-sdk");
  assert.deepEqual(editOption?.formDefinitionRef, KIMI_SDK_FORM_DEFINITION_REF);
});

test("current-only Kimi keeps the registered schema ref for resume/edit", () => {
  const kimiRuntime = RUNTIMES.find((runtime) => runtime.id === "kimi-sdk");
  assert.ok(kimiRuntime);
  const wasDeprecated = kimiRuntime.deprecated;
  kimiRuntime.deprecated = true;
  try {
    const currentOnlyOption = projectExistingAgentRuntimeOptions(["kimi-sdk"], "kimi-sdk", {
      grokRuntimeEnabled: false,
    }).find((option) => option.runtimeId === "kimi-sdk");

    assert.equal(currentOnlyOption?.availableForNew, false);
    assert.equal(currentOnlyOption?.manageableForCurrentAgent, true);
    assert.deepEqual(currentOnlyOption?.formDefinitionRef, KIMI_SDK_FORM_DEFINITION_REF);
  } finally {
    kimiRuntime.deprecated = wasDeprecated;
  }
});

test("existing Grok is grandfathered while new transitions remain absent", () => {
  const existingGrok = projectExistingAgentRuntimeOptions(["codex", "grok"], "grok", {
    grokRuntimeEnabled: false,
  });
  assert.deepEqual(existingGrok.find((option) => option.runtimeId === "grok"), {
    runtimeId: "grok",
    capabilityStatus: "available",
    admissionStatus: "grandfathered_current",
    admissionReason: "feature_flag_off",
    current: true,
    availableForNew: false,
    manageableForCurrentAgent: true,
    canSelectInThisContext: true,
    // Batch 3a: an existing Grok agent stays editable with its v2 form while the flag is off.
    runtimeFormV2: { protocolVersion: 2 },
  });

  const unavailableCurrentGrok = projectExistingAgentRuntimeOptions(["codex"], "grok", {
    grokRuntimeEnabled: false,
  });
  assert.deepEqual(unavailableCurrentGrok.find((option) => option.runtimeId === "grok"), {
    runtimeId: "grok",
    capabilityStatus: "not_installed",
    admissionStatus: "grandfathered_current",
    admissionReason: "feature_flag_off",
    current: true,
    availableForNew: false,
    manageableForCurrentAgent: false,
    canSelectInThisContext: false,
    runtimeFormV2: { protocolVersion: 2 },
  });

  const existingCodex = projectExistingAgentRuntimeOptions(["codex", "grok"], "codex", {
    grokRuntimeEnabled: false,
  });
  assert.equal(existingCodex.some((option) => option.runtimeId === "grok"), false);
});

test("deprecated current runtimes use the same explicit grandfathered contract", () => {
  for (const runtime of ["kimi", "antigravity"]) {
    const options = projectExistingAgentRuntimeOptions([runtime], runtime, {
      grokRuntimeEnabled: false,
    });
    assert.deepEqual(options.find((option) => option.runtimeId === runtime), {
      runtimeId: runtime,
      capabilityStatus: "available",
      admissionStatus: "grandfathered_current",
      admissionReason: "deprecated",
      current: true,
      availableForNew: false,
      manageableForCurrentAgent: true,
      canSelectInThisContext: true,
      // Additive (batch 2): the current deprecated runtime is editable with its v2 form.
      runtimeFormV2: { protocolVersion: 2 },
    });
    assert.equal(projectNewAgentRuntimeOptions([runtime], { grokRuntimeEnabled: false }).some((option) => option.runtimeId === runtime), false);
  }
});

test("setup options reuse new-admission policy and exclude built-in", () => {
  const disabled = projectSetupRuntimeOptions(["grok"], { grokRuntimeEnabled: false });
  assert.equal(disabled.some((option) => option.runtimeId === "grok"), false);
  assert.equal(disabled.some((option) => option.runtimeId === "builtin"), false);
  assert.equal(disabled.some((option) => option.canSelectInThisContext), false);

  const enabled = projectSetupRuntimeOptions(["grok"], { grokRuntimeEnabled: true });
  assert.equal(enabled.find((option) => option.runtimeId === "grok")?.canSelectInThisContext, true);
});

test("the runtimeFormV2 marker is on exactly the runtimes with a v2 form, independent of the v1 ref", () => {
  const everyRuntime = RUNTIMES.map((runtime) => runtime.id);
  const withMarker = (options: ReturnType<typeof projectNewAgentRuntimeOptions>) =>
    options.filter((option) => option.runtimeFormV2 !== undefined).map((option) => option.runtimeId).sort();
  const created = projectNewAgentRuntimeOptions(everyRuntime, { grokRuntimeEnabled: true });
  // Deprecated runtimes with a v2 form (kimi, gemini, antigravity) are not offered for new agents.
  assert.deepEqual(withMarker(created), ["builtin", "claude", "codex", "copilot", "cursor", "grok", "kimi-sdk", "opencode", "pi"]);
  // Grok's row, and with it the marker, exists only while the grok runtime flag is on.
  assert.deepEqual(
    withMarker(projectNewAgentRuntimeOptions(everyRuntime, { grokRuntimeEnabled: false })),
    ["builtin", "claude", "codex", "copilot", "cursor", "kimi-sdk", "opencode", "pi"],
  );
  for (const option of created.filter((candidate) => candidate.runtimeFormV2)) {
    assert.deepEqual(option.runtimeFormV2, { protocolVersion: 2 });
  }
  assert.deepEqual(withMarker(projectSetupRuntimeOptions(everyRuntime, { grokRuntimeEnabled: true })), ["claude", "codex", "copilot", "cursor", "grok", "kimi-sdk", "opencode", "pi"]);
  assert.deepEqual(
    withMarker(projectExistingAgentRuntimeOptions(everyRuntime, "kimi-sdk", { grokRuntimeEnabled: true })),
    ["builtin", "claude", "codex", "copilot", "cursor", "grok", "kimi-sdk", "opencode", "pi"],
  );
  // ...and appear, with the marker, only as an edited agent's current runtime.
  for (const deprecated of ["kimi", "gemini", "antigravity"]) {
    const options = projectExistingAgentRuntimeOptions(everyRuntime, deprecated, { grokRuntimeEnabled: true });
    assert.deepEqual(withMarker(options), ["builtin", "claude", "codex", "copilot", "cursor", deprecated, "grok", "kimi-sdk", "opencode", "pi"].sort(), deprecated);
    const current = options.find((option) => option.runtimeId === deprecated);
    assert.equal(current?.current, true, deprecated);
    assert.equal(current?.admissionReason, "deprecated", deprecated);
    assert.equal(current && "formDefinitionRef" in current, false, `${deprecated} has no v1 form`);
  }
  for (const runtimeId of ["opencode", "codex", "grok", "claude", "cursor", "copilot", "pi"]) {
    const option = created.find((candidate) => candidate.runtimeId === runtimeId);
    assert.equal(option && "formDefinitionRef" in option, false, `${runtimeId} has no v1 form`);
  }

  // Pi (batch 4) has only a v2 form: the marker, and no v1 ref for v1 clients.
  const pi = projectNewAgentRuntimeOptions(["pi"], { grokRuntimeEnabled: false })
    .find((option) => option.runtimeId === "pi");
  assert.deepEqual(pi?.runtimeFormV2, { protocolVersion: 2 });
  assert.equal(pi && "formDefinitionRef" in pi, false);
  // The marker follows the registry: every catalog runtime has a v2 form now,
  // so take Pi out of the registry to see a runtime without one.
  const restore = removeRuntimeFormV2EntryForTests("pi");
  try {
    const piWithout = projectNewAgentRuntimeOptions(["pi"], { grokRuntimeEnabled: false })
      .find((option) => option.runtimeId === "pi");
    assert.ok(piWithout, "the runtime is still offered");
    assert.equal("runtimeFormV2" in piWithout, false);
  } finally {
    restore();
  }
  assert.deepEqual(
    projectNewAgentRuntimeOptions(["pi"], { grokRuntimeEnabled: false }).find((option) => option.runtimeId === "pi")?.runtimeFormV2,
    { protocolVersion: 2 },
  );
});
