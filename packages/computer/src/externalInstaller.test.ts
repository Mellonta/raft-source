import { vi } from "vitest";
vi.mock("@botiverse/raft-shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@botiverse/raft-shared")>(),
  DISTRIBUTION_POLICY: { managedMcp: false, diagnosticUploads: false, forkReleases: false },
}));
import assert from "node:assert/strict";
import * as externalInstaller from "./externalInstaller";
import { runService } from "./service";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { installerArgs, installerCommand, readInstallerUpgradeEvidence, readLastRemoteUpgradeReceipt, recordRemoteUpgradeLaunch } from "./externalInstaller";
import { createHash } from "node:crypto";
import { bindUpgradeReadyAcknowledgement } from "./residentLifecycleBridge";
import { COMPUTER_VERSION } from "./version";
import type { MachineServiceAttestation } from "./lib/types";
import type { Channel } from "./lib/channelState";

test("installerArgs: latest maps to the installer's main channel", () => {
  assert.deepEqual(installerArgs({ channel: "latest" }), ["upgrade", "--channel", "main"]);
  assert.deepEqual(installerArgs({}), ["upgrade", "--channel", "main"]);
});

test("installerArgs: alpha and named feature channels are forwarded as their own slug", () => {
  assert.deepEqual(installerArgs({ channel: "alpha" }), ["upgrade", "--channel", "alpha"]);
  assert.deepEqual(
    installerArgs({ channel: "fresh-install-flow" as Channel }),
    ["upgrade", "--channel", "fresh-install-flow"],
  );
});

test("installerArgs: an exact version wins over the saved channel", () => {
  assert.deepEqual(installerArgs({ targetVersion: "1.0.33", channel: "alpha" }), ["upgrade", "--version", "1.0.33"]);
  assert.deepEqual(installerArgs({ channel: "pinned:1.0.31" }), ["upgrade", "--version", "1.0.31"]);
  assert.deepEqual(
    installerArgs({ targetVersion: "1.0.30", allowDowngrade: true }),
    ["upgrade", "--version", "1.0.30", "--allow-downgrade"],
  );
});


test("upgrade readiness requires the matching settled installer proof and a live successor", async () => {
  const home = mkdtempSync(join(tmpdir(), "installer-proof-"));
  try {
    const directory = join(home, "computer", "installer", "receipts");
    mkdirSync(directory, { recursive: true });
    const id = "request-a";
    const path = join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);
    const receipt = { protocol: "raft-computer-installer/v3", id, operation: "upgrade", outcome: "promoted", exitCode: 0,
      targetVersion: COMPUTER_VERSION, detail: { deadProcessIdentities: JSON.stringify(["pid:42:created:old"]) } };
    assert.equal(await readInstallerUpgradeEvidence(home, id), null);
    writeFileSync(path, JSON.stringify(receipt));
    const proof = await readInstallerUpgradeEvidence(home, id);
    assert.deepEqual(proof, { targetVersion: COMPUTER_VERSION, deadProcessIdentities: ["pid:42:created:old"] });
    const ack = { action: "upgrade" as const, phase: "ready" as const, operationId: id, loadedComputerVersion: COMPUTER_VERSION };
    const service = { computerVersion: COMPUTER_VERSION, servicePid: 99, serviceGeneration: "new", managedSetRevision: "set" } as MachineServiceAttestation;
    const bind = (actual: Awaited<ReturnType<typeof readInstallerUpgradeEvidence>> = proof, version = COMPUTER_VERSION, alive = true) => bindUpgradeReadyAcknowledgement({
      acknowledgement: { ...ack, loadedComputerVersion: version }, service, proof: actual, isAlive: () => alive,
    });
    assert.deepEqual(bind()?.deadProcessIdentities, ["pid:42:created:old"]);
    assert.equal(bind(null), null);
    assert.equal(bind({ targetVersion: COMPUTER_VERSION, deadProcessIdentities: [] }), null);
    writeFileSync(path, JSON.stringify({ ...receipt, detail: { deadProcessIdentities: "[]" } }));
    assert.equal(await readInstallerUpgradeEvidence(home, id), null);
    assert.equal(bind(proof, "0.0.1"), null);
    assert.equal(bind(proof, COMPUTER_VERSION, false), null);
    assert.equal(bind({ targetVersion: "0.0.1", deadProcessIdentities: ["old"] }), null);
    for (const patch of [{ id: "other" }, { outcome: "unresolved", exitCode: 3 }, { detail: {} }]) {
      writeFileSync(path, JSON.stringify({ ...receipt, ...patch }));
      assert.equal(await readInstallerUpgradeEvidence(home, id), null);
    }
    writeFileSync(path, "x".repeat(65_537));
    assert.equal(await readInstallerUpgradeEvidence(home, id), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("service upgrade mutation returns a channel selector without inventing a target version", async () => {
  const home = mkdtempSync(join(tmpdir(), "installer-service-mutation-"));
  const oldRaftHome = process.env.RAFT_HOME;
  const oldSlockHome = process.env.SLOCK_HOME;
  const launch = vi.spyOn(externalInstaller, "launchInstallerDetached").mockResolvedValue(4321);
  try {
    process.env.RAFT_HOME = home;
    process.env.SLOCK_HOME = home;
    mkdirSync(join(home, "computer"), { recursive: true });
    writeFileSync(join(home, "computer", "channel"), "alpha");
    let exercised = false;
    await runService({ stopAfterMutationsReady: true, onMutationsReady: async (mutations) => {
      const remote = { scope: "remote" as const, requestId: "channel-request", originServerId: "test-server", trigger: "web" as const };
      assert.deepEqual(await mutations.upgradeStart!(remote), { status: "started", upgradeId: remote.requestId, channel: "alpha" });
      assert.deepEqual(launch.mock.calls.at(-1), [home, ["upgrade", "--channel", "alpha"], remote.requestId]);
      const exact = { ...remote, requestId: "exact-request", targetVersion: "1.0.33" };
      assert.deepEqual(await mutations.upgradeStart!(exact), { status: "started", upgradeId: exact.requestId, targetVersion: "1.0.33" });
      assert.deepEqual(launch.mock.calls.at(-1), [home, ["upgrade", "--version", "1.0.33"], exact.requestId]);
      exercised = true;
    } });
    assert.equal(exercised, true);
  } finally {
    launch.mockRestore();
    if (oldRaftHome === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = oldRaftHome;
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME; else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(home, { recursive: true, force: true });
  }
});


test("native installer resolver freezes one release, checks bytes, caches and executes without a shell", async () => {
  const home = mkdtempSync(join(tmpdir(), "native-installer-"));
  const windows = process.platform === "win32";
  // System Mach-O executables can be killed by macOS after copying. Build a
  // controlled native fixture instead, so downloaded bytes remain executable
  // on both POSIX hosts and argument boundaries can be asserted exactly.
  const bytes = (() => {
    if (windows) return readFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"));
    const fixture = mkdtempSync(join(tmpdir(), "installer-native-fixture-"));
    try {
      const source = join(fixture, "args.c");
      const binary = join(fixture, "args");
      writeFileSync(source, '#include <stdio.h>\n#include <string.h>\n#include <stdlib.h>\nint main(int argc, char **argv) { if (argc == 3 && strcmp(argv[1], "--caller-env") == 0) { FILE *f = fopen(argv[2], "w"); if (!f) return 3; const char *v = getenv("RAFT_COMPUTER_INSTALLER_CALLER"); fputs(v ? v : "absent", f); fclose(f); return 17; } for (int i = 1; i < argc; ++i) { fwrite(argv[i], 1, strlen(argv[i]) + 1, stdout); } return ferror(stdout) ? 1 : 0; }\n');
      const compiled = spawnSync("cc", [source, "-o", binary], { encoding: "utf8" });
      assert.equal(compiled.status, 0, `native fixture compilation failed: ${compiled.error ?? compiled.stderr}`);
      return readFileSync(binary);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  })();
  const hash = createHash("sha256").update(bytes).digest("hex");
  const target = `${process.platform}-${process.arch}`;
  const name = `raft-computer-installer${windows ? ".exe" : ""}`;
  const requests: string[] = [];
  let mode = "good";
  const server = createServer((request, response) => {
    const url = request.url!;
    requests.push(url);
    if (url === `/dl/raft-computer-installer/main/${target}`) {
      response.writeHead(302, { location: mode === "mutable" ? `/dl/raft-computer-installer/alpha/${target}` : `/dl/raft-computer-installer/releases/frozen/${target}` });
      response.end();
    } else if (url.endsWith("?kind=sha256sums")) {
      response.end(`${hash}  native/${target}/${name}\n`.repeat(mode === "duplicate" ? 2 : 1));
    } else if (url === `/dl/raft-computer-installer/releases/frozen/${target}` || url === `/dl/raft-computer-installer/alpha/${target}`) {
      if (mode === "http-error") { response.writeHead(503); response.end("no"); }
      else response.end(mode === "tampered" ? Buffer.from("not an installer") : bytes);
    } else { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const env = { ...process.env, RAFT_HOME: home, RAFT_COMPUTER_INSTALLER_DL_BASE: `http://127.0.0.1:${(server.address() as { port: number }).port}/dl/raft-computer-installer` };
    const args = windows ? ["cmd.exe"] : ["name'with space", "$(must-not-run)", "", "line\nend", "semi;colon"];
    const invocation = await installerCommand(args, env);
    assert.deepEqual(invocation.args, args);
    assert.equal(invocation.command.endsWith(name), true);
    const executed = spawnSync(invocation.command, invocation.args, { env, encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
    if (windows) assert.match(executed.stdout, /cmd\.exe/i);
    else assert.deepEqual(executed.stdout.split("\0"), [...args, ""]);
    if (!windows) {
      const attendedOutput = join(home, "attended-caller");
      assert.equal(await externalInstaller.runInstallerAttended(["--caller-env", attendedOutput], env), 17);
      assert.equal(readFileSync(attendedOutput, "utf8"), "waiting-cli-v1");
      const remoteOutput = join(home, "remote-caller");
      await externalInstaller.launchInstallerDetached(home, ["--caller-env", remoteOutput], "caller-env-test",
        { ...env, RAFT_COMPUTER_INSTALLER_CALLER: "waiting-cli-v1" });
      for (let retry = 0; retry < 100; retry++) {
        try { if (readFileSync(remoteOutput, "utf8") === "absent") break; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(readFileSync(remoteOutput, "utf8"), "absent", "remote service must never inherit the waiting CLI exemption");
    }
    const binaryRequests = () => requests.filter((url) => url.endsWith(`/releases/frozen/${target}`)).length;
    const count = binaryRequests();
    assert.deepEqual(await installerCommand(args, env), invocation);
    assert.equal(binaryRequests(), count, "verified cached bytes should be reused");
    writeFileSync(invocation.command, "corrupted cache");
    assert.deepEqual(await installerCommand(args, env), invocation);
    assert.equal(binaryRequests(), count + 1, "corrupt cache must be downloaded and reverified");
    for (const bad of ["mutable", "duplicate", "tampered", "http-error"]) {
      mode = bad;
      rmSync(invocation.command, { force: true });
      await assert.rejects(installerCommand(args, env), /invalid_immutable|invalid_installer_checksum|installer_checksum_mismatch|installer_download_failed/);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote upgrade v2: the successor reads the launched request's receipt through the marker, never another request's", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru2-receipt-"));
  try {
    assert.equal(await readLastRemoteUpgradeReceipt(home), null, "no marker → nothing");
    await recordRemoteUpgradeLaunch(home, { requestId: "req-1", targetVersion: "1.0.40" });
    assert.equal(await readLastRemoteUpgradeReceipt(home), null, "marker without a receipt → nothing yet");
    const receipts = join(home, "computer", "installer", "receipts");
    mkdirSync(receipts, { recursive: true });
    const name = (id: string) => join(receipts, `${createHash("sha256").update(id).digest("hex")}.json`);
    writeFileSync(name("req-0"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-0", operation: "upgrade", outcome: "promoted", exitCode: 0, targetVersion: "1.0.39" }));
    assert.equal(await readLastRemoteUpgradeReceipt(home), null, "another request's receipt is not this launch's");
    writeFileSync(name("req-1"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-1", operation: "upgrade", outcome: "rolled_back", exitCode: 1, targetVersion: "1.0.40", reason: "download checksum mismatch" }));
    assert.deepEqual(await readLastRemoteUpgradeReceipt(home), { targetVersion: "1.0.40", outcome: "rolled_back", reason: "download checksum mismatch" });
    // The shape the installer actually writes: kebab-case outcome, reason under detail (rust/report.rs).
    writeFileSync(name("req-1"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-1", operation: "upgrade", outcome: "rolled-back", exitCode: 1, targetVersion: "1.0.40", detail: { reason: "candidate was not started successfully" } }));
    assert.deepEqual(await readLastRemoteUpgradeReceipt(home), { targetVersion: "1.0.40", outcome: "rolled_back", reason: "candidate was not started successfully" });
    writeFileSync(name("req-1"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-1", operation: "upgrade", outcome: "promoted", exitCode: 0, targetVersion: "1.0.40" }));
    assert.deepEqual(await readLastRemoteUpgradeReceipt(home), { targetVersion: "1.0.40", outcome: "promoted" });
    writeFileSync(name("req-1"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-1", operation: "upgrade", outcome: "held", exitCode: 2, targetVersion: "1.0.40", detail: { reason: "owned by another package manager" } }));
    assert.deepEqual(await readLastRemoteUpgradeReceipt(home), { targetVersion: "1.0.40", outcome: "held", reason: "owned by another package manager" });
    writeFileSync(name("req-1"), "{not json");
    assert.equal(await readLastRemoteUpgradeReceipt(home), null, "unparseable receipt → nothing, never a guess");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
