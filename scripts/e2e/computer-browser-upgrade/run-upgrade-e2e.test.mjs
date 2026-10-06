import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const runner = resolve(scriptDir, "run-upgrade-e2e.mjs");

const identity = {
  serverId: "11111111-1111-4111-8111-111111111111",
  serverSlug: "fixture-server",
  serverMachineId: "22222222-2222-4222-8222-222222222222",
  machineId: "33333333-3333-4333-8333-333333333333",
};

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function runNormalModeMismatch(kind) {
  const root = await mkdtemp(join(tmpdir(), `computer-browser-upgrade-${kind}-`));
  const secretDir = await mkdtemp("/tmp/task809.");
  const outDir = join(root, "out");
  await mkdir(outDir);
  const sentinel = join(secretDir, "must-survive.txt");
  await writeFile(sentinel, "preserve on binding failure\n", { mode: 0o600 });

  const attachmentPath = join(root, "attachment.json");
  const preUpgradePath = join(root, "pre-upgrade.json");
  await writeJson(attachmentPath, {
    ...identity,
    apiKey: "sk_computer_fixture-not-a-real-secret",
  });

  const preUpgrade = {
    schema: "raft.task809.pre-upgrade.v1",
    server: { id: identity.serverId, slug: identity.serverSlug },
    machine: {
      id: kind === "identity" ? "44444444-4444-4444-8444-444444444444" : identity.machineId,
    },
    linkedComputer: { id: identity.serverMachineId },
    preExistingMachineIds: [],
    processes: { servicePid: 10, runnerPid: 11 },
    execution: {
      bedId: "55555555-5555-4555-8555-555555555555",
      bedRevision: kind === "resource" ? 99 : 2,
      sshHost: "raft-tb-abcdef.exe.xyz",
      remoteRoot: "/home/exedev/task809-aaaaaaaa",
      secretDir,
    },
  };
  await writeJson(preUpgradePath, preUpgrade);

  const result = spawnSync(process.execPath, [
    runner,
    "--qa-account", join(root, "unused-qa.json"),
    "--session", join(root, "unused-session.json"),
    "--attachment", attachmentPath,
    "--pre-upgrade", preUpgradePath,
    "--post-upgrade", join(root, "unused-post-upgrade.json"),
    "--bed-id", "55555555-5555-4555-8555-555555555555",
    "--bed-revision", "2",
    "--ssh-host", "raft-tb-abcdef.exe.xyz",
    "--ssh-key", join(root, "unused-ssh-key"),
    "--known-hosts", join(root, "unused-known-hosts"),
    "--remote-root", "/home/exedev/task809-aaaaaaaa",
    "--playwright-root", root,
    "--target-version", "1.0.32",
    "--secret-dir", secretDir,
    "--out-dir", outDir,
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/nonexistent" },
  });

  try {
    assert.equal(result.status, 1, result.stderr);
    const receipt = JSON.parse(await readFile(join(outDir, "run-receipt.json"), "utf8"));
    assert.equal(
      receipt.failureCategory,
      kind === "identity" ? "identity_binding_invalid" : "resource_binding_invalid",
    );
    assert.equal(receipt.pass, false);
    assert.equal(receipt.execution.subprocessesStarted, 0);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(receipt.cleanup).filter(([, value]) => typeof value === "boolean"),
      ),
      {
        serviceStop: false,
        machineDeleted: false,
        machineAbsent: false,
        preExistingMachinesPreserved: false,
        computerCredentialRevoked: false,
        bedTombstoned: false,
        zeroResidue: false,
        localSecretDirRemoved: false,
      },
    );
    assert.equal(await readFile(sentinel, "utf8"), "preserve on binding failure\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(secretDir, { recursive: true, force: true });
  }
}

test("normal mode rejects an attachment/pre-upgrade identity mismatch before any subprocess or cleanup", async () => {
  await runNormalModeMismatch("identity");
});

test("normal mode rejects an execution-resource mismatch before any subprocess or cleanup", async () => {
  await runNormalModeMismatch("resource");
});

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function runChild(args, env) {
  return await new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", rejectChild);
    child.on("close", (code) => resolveChild({ status: code, stdout, stderr }));
  });
}

async function makeSuccessfulRunFixture() {
  const root = await mkdtemp(join(tmpdir(), "computer-browser-upgrade-evidence-"));
  const secretDir = await mkdtemp("/tmp/task809.");
  const outDir = join(root, "out");
  const binDir = join(root, "bin");
  await mkdir(outDir);
  await mkdir(binDir);

  const attachmentPath = join(root, "attachment.json");
  const preUpgradePath = join(root, "pre-upgrade.json");
  const postUpgradePath = join(root, "post-upgrade.json");
  await writeJson(attachmentPath, {
    ...identity,
    apiKey: "sk_computer_fixture-not-a-real-secret",
  });
  await writeJson(preUpgradePath, {
    schema: "raft.task809.pre-upgrade.v1",
    server: { id: identity.serverId, slug: identity.serverSlug },
    machine: { id: identity.machineId },
    linkedComputer: { id: identity.serverMachineId },
    preExistingMachineIds: [],
    processes: { servicePid: 10, runnerPid: 11 },
    execution: {
      bedId: "55555555-5555-4555-8555-555555555555",
      bedRevision: 2,
      sshHost: "raft-tb-abcdef.exe.xyz",
      remoteRoot: "/home/exedev/task809-aaaaaaaa",
      secretDir,
    },
  });

  const browserDriver = join(root, "browser-driver.mjs");
  await writeFile(browserDriver, `
import { mkdir, writeFile } from "node:fs/promises";
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (index % 2 === 0) pairs.push([value, values[index + 1]]);
  return pairs;
}, []));
await mkdir(args["--out-dir"], { recursive: true });
await writeFile(args["--out-dir"] + "/receipt-upgrade.json", JSON.stringify({
  actionStartedAt: "2026-09-17T12:00:00.000Z",
  failure: null,
  setupGate: { visible: false },
  action: {
    status: 202,
    operationId: "66666666-6666-4666-8666-666666666666",
    requestId: "fixture-request",
    targetVersion: "1.0.32",
    expectedTargetVersion: "1.0.32"
  },
  successText: "Upgrade started"
}, null, 2) + "\\n");
`);

  const stagingApiDriver = join(root, "staging-api-driver.mjs");
  await writeFile(stagingApiDriver, `
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const command = process.argv[2];
if (command === "login") {
  await mkdir(dirname(process.argv[4]), { recursive: true });
  await writeFile(process.argv[4], "{}\\n");
} else if (command === "get") {
  await writeFile(process.argv[5], "[]\\n");
} else if (command === "probe-computer-revoked") {
  process.stdout.write(JSON.stringify({ revoked: true, status: 401 }) + "\\n");
}
`);

  const commandStub = `#!/usr/bin/env node
import { basename } from "node:path";
const command = basename(process.argv[1]);
if (command === "npx" && process.argv.includes("cleanup")) {
  process.stdout.write(JSON.stringify({ outcome: { outcome: "tombstoned" } }) + "\\n");
} else if (command === "npx" && process.argv.includes("residue")) {
  process.stdout.write(JSON.stringify({ zero_residue: true, evidence_sha256: "${"a".repeat(64)}" }) + "\\n");
}
`;
  for (const name of ["ssh", "npx"]) {
    const path = join(binDir, name);
    await writeFile(path, commandStub);
    await chmod(path, 0o755);
  }

  const args = [
    runner,
    "--qa-account", join(root, "qa-account.json"),
    "--session", join(root, "session.json"),
    "--attachment", attachmentPath,
    "--pre-upgrade", preUpgradePath,
    "--post-upgrade", postUpgradePath,
    "--bed-id", "55555555-5555-4555-8555-555555555555",
    "--bed-revision", "2",
    "--ssh-host", "raft-tb-abcdef.exe.xyz",
    "--ssh-key", join(root, "ssh-key"),
    "--known-hosts", join(root, "known-hosts"),
    "--remote-root", "/home/exedev/task809-aaaaaaaa",
    "--playwright-root", root,
    "--target-version", "1.0.32",
    "--secret-dir", secretDir,
    "--out-dir", outDir,
  ];
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PATH: `${binDir}:${process.env.PATH}`,
    TASK809_BROWSER_DRIVER_FOR_TESTS: browserDriver,
    TASK809_STAGING_API_DRIVER_FOR_TESTS: stagingApiDriver,
  };
  return { root, secretDir, outDir, postUpgradePath, args, env };
}

function validPostUpgradeEvidence(request) {
  return {
    schema: "raft.task809.post-upgrade.v1",
    evidenceContract: "externally-collected-bound-readbacks.v1",
    evidenceRequestId: request.evidenceRequestId,
    serverId: identity.serverId,
    machineId: identity.machineId,
    serverMachineId: identity.serverMachineId,
    targetVersion: "1.0.32",
    machineStatus: "online",
    serverComputerVersion: "1.0.32",
    vmBinaryVersion: "1.0.32",
    vmBinarySha256: "b".repeat(64),
    processes: { servicePid: 20, runnerPid: 21 },
    lifecycle: {
      operationId: request.operationId,
      targetVersion: "1.0.32",
      shutdownAckAt: "2026-09-17T12:00:01.000Z",
      disconnectedAt: "2026-09-17T12:00:02.000Z",
      readyAckAt: "2026-09-17T12:00:03.000Z",
      terminalAt: "2026-09-17T12:00:04.000Z",
      loadedComputerVersion: "1.0.32",
      terminalStatus: "succeeded",
    },
  };
}

test("normal mode waits for a late atomic post-upgrade evidence handoff before cleanup", async () => {
  const fixture = await makeSuccessfulRunFixture();
  fixture.args.push("--post-upgrade-timeout-ms", "5000");
  try {
    const childResult = runChild(fixture.args, fixture.env);
    const request = await waitForFile(join(fixture.outDir, "post-upgrade-evidence-request.json"));
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    const temporaryPath = `${fixture.postUpgradePath}.tmp`;
    await writeJson(temporaryPath, validPostUpgradeEvidence(request));
    await rename(temporaryPath, fixture.postUpgradePath);

    const result = await childResult;
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(await readFile(join(fixture.outDir, "run-receipt.json"), "utf8"));
    assert.equal(receipt.pass, true);
    assert.equal(receipt.execution.evidenceRequestWritten, true);
    assert.equal(receipt.execution.postUpgradeEvidenceAccepted, true);
    assert.equal(receipt.cleanupComplete, true);
    await assert.rejects(readFile(fixture.secretDir), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.secretDir, { recursive: true, force: true });
  }
});

test("normal mode times out waiting for post-upgrade evidence and still completes cleanup", async () => {
  const fixture = await makeSuccessfulRunFixture();
  fixture.args.push("--post-upgrade-timeout-ms", "80");
  try {
    const result = await runChild(fixture.args, fixture.env);
    assert.equal(result.status, 1, result.stderr);
    const receipt = JSON.parse(await readFile(join(fixture.outDir, "run-receipt.json"), "utf8"));
    assert.equal(receipt.pass, false);
    assert.equal(receipt.failureCategory, "post_upgrade_evidence_timeout");
    assert.equal(receipt.execution.evidenceRequestWritten, true);
    assert.equal(receipt.execution.postUpgradeEvidenceAccepted, false);
    assert.equal(receipt.cleanupComplete, true);
    await assert.rejects(readFile(fixture.secretDir), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.secretDir, { recursive: true, force: true });
  }
});
