#!/usr/bin/env node

// Browser executor + externally collected evidence validator + cleanup
// coordinator. It does not collect privileged lifecycle database evidence;
// the --post-upgrade file must be produced independently and is validated
// against the browser operation, ordered timestamps, process identities, and
// target versions before pass can become true.

import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let subprocessesStarted = 0;

function failUsage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 2) {
    result[argv[index]] = argv[index + 1];
  }
  return result;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function pathExists(path) {
  return await access(path).then(() => true, () => false);
}

async function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function waitForJson(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(path)) return await readJson(path);
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  throw new Error("post_upgrade_evidence_timeout");
}

async function run(command, args, options = {}) {
  subprocessesStarted += 1;
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}

function validateIdentityBinding(attachment, preUpgrade) {
  return preUpgrade?.schema === "raft.task809.pre-upgrade.v1"
    && attachment?.serverId === preUpgrade?.server?.id
    && attachment?.serverSlug === preUpgrade?.server?.slug
    && attachment?.machineId === preUpgrade?.machine?.id
    && attachment?.serverMachineId === preUpgrade?.linkedComputer?.id
    && UUID_RE.test(attachment.serverId)
    && UUID_RE.test(attachment.machineId)
    && UUID_RE.test(attachment.serverMachineId);
}

function validateExecutionBinding(preUpgrade, binding) {
  return preUpgrade?.execution?.bedId === binding.bedId
    && String(preUpgrade?.execution?.bedRevision) === binding.bedRevision
    && preUpgrade?.execution?.sshHost === binding.sshHost
    && preUpgrade?.execution?.remoteRoot === binding.remoteRoot
    && preUpgrade?.execution?.secretDir === binding.secretDir;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validatePostUpgrade(postUpgrade, preUpgrade, attachment, browserReceipt, evidenceRequestId, targetVersion) {
  const lifecycle = postUpgrade?.lifecycle;
  const timestamps = [
    browserReceipt?.actionStartedAt,
    lifecycle?.shutdownAckAt,
    lifecycle?.disconnectedAt,
    lifecycle?.readyAckAt,
    lifecycle?.terminalAt,
  ];
  const timestampOrderValid = timestamps.every(validTimestamp)
    && timestamps.every((value, index) => index === 0 || Date.parse(timestamps[index - 1]) <= Date.parse(value));
  const processesReplaced = Number.isInteger(preUpgrade?.processes?.servicePid)
    && Number.isInteger(preUpgrade?.processes?.runnerPid)
    && Number.isInteger(postUpgrade?.processes?.servicePid)
    && Number.isInteger(postUpgrade?.processes?.runnerPid)
    && preUpgrade.processes.servicePid !== postUpgrade.processes.servicePid
    && preUpgrade.processes.runnerPid !== postUpgrade.processes.runnerPid;
  return postUpgrade?.schema === "raft.task809.post-upgrade.v1"
    && postUpgrade?.evidenceContract === "externally-collected-bound-readbacks.v1"
    && postUpgrade?.evidenceRequestId === evidenceRequestId
    && postUpgrade.serverId === attachment.serverId
    && postUpgrade.machineId === attachment.machineId
    && postUpgrade.serverMachineId === attachment.serverMachineId
    && postUpgrade.targetVersion === targetVersion
    && postUpgrade.machineStatus === "online"
    && postUpgrade.serverComputerVersion === targetVersion
    && postUpgrade.vmBinaryVersion === targetVersion
    && processesReplaced
    && /^[0-9a-f]{64}$/i.test(postUpgrade.vmBinarySha256 ?? "")
    && lifecycle?.operationId === browserReceipt?.action?.operationId
    && lifecycle?.targetVersion === targetVersion
    && lifecycle?.loadedComputerVersion === targetVersion
    && lifecycle?.terminalStatus === "succeeded"
    && timestampOrderValid;
}

const opts = parseArgs(process.argv);
const required = [
  "--qa-account",
  "--session",
  "--attachment",
  "--pre-upgrade",
  "--post-upgrade",
  "--bed-id",
  "--bed-revision",
  "--ssh-host",
  "--ssh-key",
  "--known-hosts",
  "--remote-root",
  "--playwright-root",
  "--target-version",
  "--secret-dir",
  "--out-dir",
];
for (const key of required) {
  if (!opts[key]) failUsage(`missing required argument ${key}`);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const qaAccountPath = resolve(opts["--qa-account"]);
const sessionPath = resolve(opts["--session"]);
const attachmentPath = resolve(opts["--attachment"]);
const preUpgradePath = resolve(opts["--pre-upgrade"]);
const postUpgradePath = resolve(opts["--post-upgrade"]);
const secretDir = resolve(opts["--secret-dir"]);
const outDir = resolve(opts["--out-dir"]);
const playwrightRoot = resolve(opts["--playwright-root"]);
const sshKeyPath = resolve(opts["--ssh-key"]);
const knownHostsPath = resolve(opts["--known-hosts"]);
const bedId = opts["--bed-id"];
const bedRevision = opts["--bed-revision"];
const sshHost = opts["--ssh-host"];
const remoteRoot = opts["--remote-root"];
const targetVersion = opts["--target-version"];
const postUpgradeTimeoutMs = Number(opts["--post-upgrade-timeout-ms"] ?? 300_000);
const validateOnly = opts["--validate-only"] === "true";
const cleanupOnly = opts["--cleanup-only"] === "true";

if (dirname(secretDir) !== "/tmp" || !basename(secretDir).startsWith("task809.")) {
  failUsage("secret-dir must be an exact /tmp/task809.* run directory");
}
const outDirRelativeToSecrets = relative(secretDir, outDir);
if (outDirRelativeToSecrets === "" || (!outDirRelativeToSecrets.startsWith("..") && !outDirRelativeToSecrets.startsWith("/"))) {
  failUsage("out-dir must be outside secret-dir so cleanup evidence survives secret deletion");
}
if (!UUID_RE.test(bedId) || !/^\d+$/.test(bedRevision)
  || !/^raft-tb-[0-9a-f]+\.exe\.xyz$/.test(sshHost)
  || !/^\/home\/exedev\/task809-[0-9a-f]{8}$/.test(remoteRoot)
  || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(targetVersion)
  || !Number.isInteger(postUpgradeTimeoutMs) || postUpgradeTimeoutMs < 1 || postUpgradeTimeoutMs > 900_000) {
  failUsage("bed, host, remote-root, revision, or target-version contract is invalid");
}

if (validateOnly) {
  const attachment = await readJson(attachmentPath);
  const preUpgrade = await readJson(preUpgradePath);
  if (!validateIdentityBinding(attachment, preUpgrade)
    || !validateExecutionBinding(preUpgrade, { bedId, bedRevision, sshHost, remoteRoot, secretDir })) {
    process.stderr.write("resource_binding_invalid\n");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, identityBinding: true, executionBinding: true, networkUsed: false })}\n`);
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
const finalReceiptPath = resolve(outDir, "run-receipt.json");
const finalReceipt = {
  schema: "raft.task809.evidence-validation-and-cleanup.v1",
  startedAt: new Date().toISOString(),
  targetVersion,
  pass: false,
  execution: {
    browserExitCode: null,
    browserReceiptAccepted: false,
    evidenceRequestWritten: false,
    postUpgradeEvidenceAccepted: false,
    subprocessesStarted: 0,
  },
  cleanup: {
    serviceStop: false,
    machineDeleted: false,
    machineAbsent: false,
    preExistingMachinesPreserved: false,
    computerCredentialRevoked: false,
    bedTombstoned: false,
    zeroResidue: false,
    localSecretDirRemoved: false,
  },
  failureCategory: null,
  secretsIncluded: false,
};

let attachment = null;
let preUpgrade = null;
let browserReceipt = null;
let cleanupAuthorized = false;

try {
  attachment = await readJson(attachmentPath);
  preUpgrade = await readJson(preUpgradePath);
  if (!validateIdentityBinding(attachment, preUpgrade)) {
    throw new Error("identity_binding_invalid");
  }
  if (!validateExecutionBinding(preUpgrade, { bedId, bedRevision, sshHost, remoteRoot, secretDir })) {
    throw new Error("resource_binding_invalid");
  }
  cleanupAuthorized = true;
  finalReceipt.serverId = attachment.serverId;
  finalReceipt.machineId = attachment.machineId;
  finalReceipt.serverMachineId = attachment.serverMachineId;

  if (cleanupOnly) throw new Error("cleanup_only_no_upgrade");

  if (await pathExists(postUpgradePath)) throw new Error("post_upgrade_evidence_preexisting");

  const browserDriver = process.env.NODE_ENV === "test" && process.env.TASK809_BROWSER_DRIVER_FOR_TESTS
    ? resolve(process.env.TASK809_BROWSER_DRIVER_FOR_TESTS)
    : resolve(scriptDir, "browser-upgrade.mjs");
  const browserRun = await run(process.execPath, [
    browserDriver,
    "--session", sessionPath,
    "--server-slug", attachment.serverSlug,
    "--machine-id", attachment.machineId,
    "--target-version", targetVersion,
    "--mode", "upgrade",
    "--out-dir", outDir,
  ], {
    env: { ...process.env, TASK809_PLAYWRIGHT_ROOT: playwrightRoot },
  });
  finalReceipt.execution.browserExitCode = browserRun.code;
  browserReceipt = await readJson(resolve(outDir, "receipt-upgrade.json"));
  const browserReceiptAccepted = browserRun.code === 0
    && browserReceipt?.failure === null
    && browserReceipt?.setupGate?.visible === false
    && browserReceipt?.action?.status >= 200
    && browserReceipt?.action?.status < 300
    && UUID_RE.test(browserReceipt?.action?.operationId ?? "")
    && typeof browserReceipt?.action?.requestId === "string"
    && browserReceipt?.action?.targetVersion === targetVersion
    && browserReceipt?.action?.expectedTargetVersion === targetVersion
    && typeof browserReceipt?.successText === "string";
  finalReceipt.execution.browserReceiptAccepted = browserReceiptAccepted;
  if (!browserReceiptAccepted) throw new Error("browser_receipt_invalid");

  const evidenceRequestId = randomUUID();
  const evidenceRequestPath = resolve(outDir, "post-upgrade-evidence-request.json");
  const evidenceRequestedAt = new Date();
  await writeJsonAtomically(evidenceRequestPath, {
    schema: "raft.task809.post-upgrade-request.v1",
    evidenceContract: "externally-collected-bound-readbacks.v1",
    evidenceRequestId,
    operationId: browserReceipt.action.operationId,
    targetVersion,
    serverId: attachment.serverId,
    machineId: attachment.machineId,
    serverMachineId: attachment.serverMachineId,
    postUpgradePath,
    requestedAt: evidenceRequestedAt.toISOString(),
    deadlineAt: new Date(evidenceRequestedAt.getTime() + postUpgradeTimeoutMs).toISOString(),
  });
  finalReceipt.execution.evidenceRequestWritten = true;
  finalReceipt.execution.evidenceRequestId = evidenceRequestId;
  finalReceipt.execution.evidenceRequestPath = evidenceRequestPath;

  let postUpgrade;
  try {
    postUpgrade = await waitForJson(postUpgradePath, postUpgradeTimeoutMs);
  } catch (error) {
    if (error instanceof Error && error.message === "post_upgrade_evidence_timeout") throw error;
    throw new Error("post_upgrade_evidence_invalid");
  }
  const postUpgradeAccepted = validatePostUpgrade(
    postUpgrade,
    preUpgrade,
    attachment,
    browserReceipt,
    evidenceRequestId,
    targetVersion,
  );
  finalReceipt.execution.postUpgradeEvidenceAccepted = postUpgradeAccepted;
  if (!postUpgradeAccepted) throw new Error("post_upgrade_evidence_invalid");

  finalReceipt.pass = true;
} catch (error) {
  finalReceipt.failureCategory = error instanceof Error
    && [
      "identity_binding_invalid",
      "resource_binding_invalid",
      "browser_receipt_invalid",
      "post_upgrade_evidence_preexisting",
      "post_upgrade_evidence_timeout",
      "post_upgrade_evidence_invalid",
      "cleanup_only_no_upgrade",
    ].includes(error.message)
    ? error.message
    : "execution_failed";
} finally {
  if (cleanupAuthorized && attachment && validateIdentityBinding(attachment, preUpgrade)) {
    const stop = await run("ssh", [
      "-i", sshKeyPath,
      "-o", `UserKnownHostsFile=${knownHostsPath}`,
      "-o", "StrictHostKeyChecking=yes",
      `exedev@${sshHost}`,
      `RAFT_HOME=${remoteRoot}/state timeout 60 ${remoteRoot}/bin/raft-computer stop`,
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    finalReceipt.cleanup.serviceStop = stop.code === 0;

    const cleanupSession = resolve(secretDir, "staging-session-cleanup.json");
    const stagingApiDriver = process.env.NODE_ENV === "test" && process.env.TASK809_STAGING_API_DRIVER_FOR_TESTS
      ? resolve(process.env.TASK809_STAGING_API_DRIVER_FOR_TESTS)
      : resolve(scriptDir, "staging-api.mjs");
    const login = await run(process.execPath, [
      stagingApiDriver,
      "login", qaAccountPath, cleanupSession,
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (login.code === 0) {
      const deletion = await run(process.execPath, [
        stagingApiDriver,
        "delete-machine", cleanupSession, attachmentPath, preUpgradePath,
      ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      finalReceipt.cleanup.machineDeleted = deletion.code === 0;
      if (deletion.code === 0) {
        const afterDeletePath = resolve(secretDir, "machines-after-delete.json");
        const afterDelete = await run(process.execPath, [
          stagingApiDriver,
          "get", cleanupSession,
          `/api/servers/${attachment.serverId}/machines`,
          afterDeletePath,
          attachment.serverId,
        ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
        if (afterDelete.code === 0) {
          try {
            const body = await readJson(afterDeletePath);
            const machines = Array.isArray(body)
              ? body
              : Array.isArray(body?.machines)
                ? body.machines
                : Array.isArray(body?.data)
                  ? body.data
                  : null;
            if (!machines) throw new Error("machine_list_shape_invalid");
            finalReceipt.cleanup.machineAbsent = machines.every((machine) => machine?.id !== attachment.machineId);
            const remainingIds = new Set(machines.map((machine) => machine?.id).filter(Boolean));
            finalReceipt.cleanup.preExistingMachinesPreserved = Array.isArray(preUpgrade?.preExistingMachineIds)
              && preUpgrade.preExistingMachineIds.every((id) => remainingIds.has(id));
          } catch {
            finalReceipt.cleanup.machineAbsent = false;
            finalReceipt.cleanup.preExistingMachinesPreserved = false;
          }
        }

        const revoked = await run(process.execPath, [
          stagingApiDriver,
          "probe-computer-revoked", attachmentPath,
        ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
        if (revoked.code === 0) {
          try {
            const body = JSON.parse(revoked.stdout);
            finalReceipt.cleanup.computerCredentialRevoked = body?.revoked === true && body?.status === 401;
          } catch {
            finalReceipt.cleanup.computerCredentialRevoked = false;
          }
        }
      }
    }
  }

  if (cleanupAuthorized) {
    const cleanup = await run("npx", [
      "-y", "@botiverse/testbed-cli",
      "bed", "cleanup", bedId,
      "--expected-revision", bedRevision,
      "--json",
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (cleanup.code === 0) {
      try {
        const cleanupBody = JSON.parse(cleanup.stdout);
        finalReceipt.cleanup.bedTombstoned = cleanupBody?.outcome?.outcome === "tombstoned";
      } catch {
        finalReceipt.cleanup.bedTombstoned = false;
      }
    }

    const residue = await run("npx", [
      "-y", "@botiverse/testbed-cli",
      "bed", "residue", bedId,
      "--json",
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (residue.code === 0) {
      try {
        const residueBody = JSON.parse(residue.stdout);
        finalReceipt.cleanup.zeroResidue = residueBody?.zero_residue === true;
        finalReceipt.cleanup.residueEvidenceSha256 = residueBody?.evidence_sha256 ?? null;
      } catch {
        finalReceipt.cleanup.zeroResidue = false;
      }
    }
  }

  const externalCleanupProved = finalReceipt.cleanup.machineDeleted
    && finalReceipt.cleanup.machineAbsent
    && finalReceipt.cleanup.preExistingMachinesPreserved
    && finalReceipt.cleanup.computerCredentialRevoked
    && finalReceipt.cleanup.bedTombstoned
    && finalReceipt.cleanup.zeroResidue;
  if (externalCleanupProved) {
    try {
      await rm(secretDir, { recursive: true, force: false });
      await access(secretDir).then(
        () => { finalReceipt.cleanup.localSecretDirRemoved = false; },
        () => { finalReceipt.cleanup.localSecretDirRemoved = true; },
      );
    } catch {
      finalReceipt.cleanup.localSecretDirRemoved = false;
    }
  }
  finalReceipt.execution.subprocessesStarted = subprocessesStarted;
  finalReceipt.completedAt = new Date().toISOString();
  finalReceipt.cleanupComplete = Object.values(finalReceipt.cleanup)
    .filter((value) => typeof value === "boolean")
    .every(Boolean);
  await writeFile(finalReceiptPath, `${JSON.stringify(finalReceipt, null, 2)}\n`);
}

if (!finalReceipt.pass || !finalReceipt.cleanupComplete) {
  process.stderr.write(`task809 run did not pass: ${finalReceipt.failureCategory ?? "cleanup_incomplete"}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, receipt: finalReceiptPath })}\n`);
}
