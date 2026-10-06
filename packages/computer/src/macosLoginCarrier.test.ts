import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  convergeAppHostLifecycle,
  convergeCliHostLifecycle,
  RAFT_COMPUTER_DISPATCHER_PATH_ENV_VAR,
  readHostLifecycleMarker,
  removeHostLifecycle,
  resolveStableDispatcherPath,
  retireCliLoginCarrier,
  retiredCliLoginCarrierPaths,
} from "./macosLoginCarrier";

async function withMacHome(
  fn: (paths: { root: string; userHome: string; slockHome: string; plist: string; label: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-macos-host-lifecycle-"));
  const userHome = path.join(root, "home");
  const slockHome = path.join(userHome, ".slock");
  const { label, definitionPath: plist } = retiredCliLoginCarrierPaths(slockHome, userHome);
  try {
    await fn({ root, userHome, slockHome, plist, label });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** A leftover from the retired CLI LaunchAgent, as older releases wrote it. */
async function writeLeftoverCarrier(slockHome: string, plist: string): Promise<string[]> {
  const state = [
    path.join(slockHome, "computer", "host-lifecycle-pending-replace.json"),
    path.join(slockHome, "computer", "proxy-env.json"),
  ];
  await mkdir(path.dirname(plist), { recursive: true });
  await writeFile(plist, "<plist/>\n");
  await mkdir(path.join(slockHome, "computer"), { recursive: true });
  for (const file of state) await writeFile(file, "{}\n");
  return state;
}

function loginItem(initial = false) {
  let openAtLogin = initial;
  return {
    setOpenAtLogin: (enabled: boolean) => { openAtLogin = enabled; },
    getOpenAtLogin: () => openAtLogin,
    get value() { return openAtLogin; },
  };
}

test("the retired CLI LaunchAgent path is per home and outside the retired supervisor label family", () => {
  const a = retiredCliLoginCarrierPaths("/Users/example/.slock", "/Users/example");
  const b = retiredCliLoginCarrierPaths("/Users/example/.slock-dev", "/Users/example");
  assert.match(a.label, /^build\.raft\.computer\.login\.[0-9a-f]{16}$/u);
  assert.doesNotMatch(a.label, /^build\.raft\.computer\.[0-9a-f]{16}$/u);
  assert.notEqual(a.label, b.label);
  assert.equal(a.definitionPath, `/Users/example/Library/LaunchAgents/${a.label}.plist`);
});

test("CLI start on macOS deletes a leftover LaunchAgent and its state, installs nothing, and records the CLI owner", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    const state = await writeLeftoverCarrier(slockHome, plist);
    const result = await convergeCliHostLifecycle(slockHome, "enabled", { platform: "darwin", userHome });
    assert.equal(result.status, "not-applicable");
    assert.equal(result.owner, "cli");
    assert.equal(result.enabled, true);
    assert.equal(await exists(plist), false);
    for (const file of state) assert.equal(await exists(file), false, file);
    assert.deepEqual(await readdirOrEmpty(path.dirname(plist)), []);
    assert.deepEqual(await readHostLifecycleMarker(slockHome), {
      formatVersion: 1,
      owner: "cli",
      enabled: true,
      dispatcherPath: null,
      label: null,
      definitionPath: null,
    });
  });
});

test("CLI stop on macOS records the disabled intent; a machine without a leftover is untouched", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    const result = await convergeCliHostLifecycle(slockHome, "disabled", { platform: "darwin", userHome });
    assert.equal(result.status, "not-applicable");
    assert.equal(await exists(plist), false);
    assert.equal((await readHostLifecycleMarker(slockHome))?.enabled, false);
  });
});

test("CLI converge off macOS touches nothing", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    await writeLeftoverCarrier(slockHome, plist);
    const result = await convergeCliHostLifecycle(slockHome, "enabled", { platform: "linux", userHome });
    assert.equal(result.status, "not-applicable");
    assert.equal(await exists(plist), true);
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  });
});

test("CLI converge keeps an App-owned record and only follows its enabled intent", async () => {
  await withMacHome(async ({ userHome, slockHome }) => {
    const item = loginItem();
    await convergeAppHostLifecycle(slockHome, true, { platform: "darwin", userHome, ...item });
    const result = await convergeCliHostLifecycle(slockHome, "disabled", { platform: "darwin", userHome });
    assert.equal(result.owner, "app");
    assert.equal((await readHostLifecycleMarker(slockHome))?.owner, "app");
    assert.equal((await readHostLifecycleMarker(slockHome))?.enabled, false);
    assert.equal(item.value, true, "the CLI never changes the App's Launch at login item");
  });
});

test("retiring the leftover LaunchAgent only removes this home's definition", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    const other = retiredCliLoginCarrierPaths(path.join(userHome, ".slock-other"), userHome).definitionPath;
    const unrelated = path.join(path.dirname(plist), "com.example.Drafts.plist");
    await writeLeftoverCarrier(slockHome, plist);
    await writeFile(other, "<plist/>\n");
    await writeFile(unrelated, "<plist/>\n");
    assert.equal((await retireCliLoginCarrier(slockHome, { platform: "darwin", userHome })).removed, true);
    assert.equal(await exists(plist), false);
    assert.equal(await exists(other), true);
    assert.equal(await exists(unrelated), true);
    assert.equal((await retireCliLoginCarrier(slockHome, { platform: "darwin", userHome })).removed, false);
  });
});

test("a cleanup that cannot delete the leftover reports it and never throws; Desktop Launch at login still works", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    // A directory where the plist should be: stat succeeds, rm without
    // `recursive` fails.
    await mkdir(path.join(plist, "blocker"), { recursive: true });
    const retired = await retireCliLoginCarrier(slockHome, { platform: "darwin", userHome });
    assert.equal(retired.removed, false);
    assert.ok(retired.error);

    const cli = await convergeCliHostLifecycle(slockHome, "enabled", { platform: "darwin", userHome });
    assert.equal(cli.owner, "cli");
    const item = loginItem();
    const app = await convergeAppHostLifecycle(slockHome, true, { platform: "darwin", userHome, ...item });
    assert.equal(app.status, "converged");
    assert.equal(item.value, true);
  });
});

test("Desktop claim removes a leftover CLI LaunchAgent, sets Launch at login, and records the App owner", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    await writeLeftoverCarrier(slockHome, plist);
    const item = loginItem();
    const result = await convergeAppHostLifecycle(slockHome, true, { platform: "darwin", userHome, ...item });
    assert.equal(result.status, "converged");
    assert.equal(result.owner, "app");
    assert.equal(item.value, true);
    assert.equal(await exists(plist), false);
    assert.equal((await readHostLifecycleMarker(slockHome))?.owner, "app");
  });
});

test("Desktop claim fails closed when the Launch at login readback disagrees", async () => {
  await withMacHome(async ({ userHome, slockHome }) => {
    await assert.rejects(
      convergeAppHostLifecycle(slockHome, true, {
        platform: "darwin",
        userHome,
        setOpenAtLogin: () => {},
        getOpenAtLogin: () => false,
      }),
      (error: unknown) => (error as { code?: string }).code === "HOST_LIFECYCLE_APP_READBACK_FAILED",
    );
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  });
});

test("Desktop claim off macOS is not applicable and changes nothing", async () => {
  await withMacHome(async ({ userHome, slockHome }) => {
    const item = loginItem();
    const result = await convergeAppHostLifecycle(slockHome, true, { platform: "linux", userHome, ...item });
    assert.equal(result.status, "not-applicable");
    assert.equal(item.value, false);
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  });
});

test("remove turns off an App-owned Launch at login and leaves no LaunchAgent and no owner record", async () => {
  await withMacHome(async ({ userHome, slockHome, plist }) => {
    const item = loginItem();
    await convergeAppHostLifecycle(slockHome, true, { platform: "darwin", userHome, ...item });
    await writeLeftoverCarrier(slockHome, plist);
    const result = await removeHostLifecycle(slockHome, { platform: "darwin", userHome, ...item });
    assert.equal(result.status, "removed");
    assert.equal(item.value, false);
    assert.equal(await exists(plist), false);
    assert.equal(await readHostLifecycleMarker(slockHome), null);
  });
});

test("remove refuses an App-owned record without the Desktop login-item seam", async () => {
  await withMacHome(async ({ userHome, slockHome }) => {
    await convergeAppHostLifecycle(slockHome, true, { platform: "darwin", userHome, ...loginItem() });
    await assert.rejects(
      removeHostLifecycle(slockHome, { platform: "darwin", userHome }),
      (error: unknown) => (error as { code?: string }).code === "HOST_LIFECYCLE_APP_OWNER_REQUIRED",
    );
    assert.equal((await readHostLifecycleMarker(slockHome))?.owner, "app");
  });
});

test("an unreadable owner record fails instead of being overwritten", async () => {
  await withMacHome(async ({ userHome, slockHome }) => {
    await mkdir(path.join(slockHome, "computer"), { recursive: true });
    await writeFile(path.join(slockHome, "computer", "host-lifecycle-owner.json"), "not json\n");
    await assert.rejects(
      convergeCliHostLifecycle(slockHome, "enabled", { platform: "darwin", userHome }),
      (error: unknown) => (error as { code?: string }).code === "HOST_LIFECYCLE_OWNER_UNREADABLE",
    );
    assert.equal(
      await readFile(path.join(slockHome, "computer", "host-lifecycle-owner.json"), "utf8"),
      "not json\n",
    );
  });
});

test("the module never shells out: no launchctl, plutil, or child_process", async () => {
  const src = await readFile(new URL("./macosLoginCarrier.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /node:child_process|execFile|spawn\(/u);
  assert.doesNotMatch(src, /"\/bin\/launchctl"|plutil/u);
});

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

test("stable dispatcher resolution rejects an explicit OS-temporary path", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "raft-macos-login-temp-dispatcher-"),
  );
  const slockHome = path.join(root, "home", ".slock");
  const temporaryDispatcher = path.join(
    root,
    "raft-computer-darwin-arm64",
  );
  try {
    await assert.rejects(
      resolveStableDispatcherPath(
        slockHome,
        {
          [RAFT_COMPUTER_DISPATCHER_PATH_ENV_VAR]: temporaryDispatcher,
        },
        process.execPath,
      ),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "HOST_LIFECYCLE_DISPATCHER_UNBOUND",
        );
        assert.match((error as Error).message, /temporary dispatcher path/u);
        return true;
      },
    );
    const canonicalTemporaryDispatcher = path.join(
      await realpath(root),
      "raft-computer-darwin-arm64",
    );
    await assert.rejects(
      resolveStableDispatcherPath(
        slockHome,
        {
          [RAFT_COMPUTER_DISPATCHER_PATH_ENV_VAR]: canonicalTemporaryDispatcher,
        },
        process.execPath,
      ),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "HOST_LIFECYCLE_DISPATCHER_UNBOUND",
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ephemeral resident falls back only to a stable existing dispatcher in the CLI marker", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "raft-macos-login-marker-fallback-"),
  );
  const slockHome = path.join(root, "home", ".slock");
  const markerFile = path.join(
    slockHome,
    "computer",
    "host-lifecycle-owner.json",
  );
  const kResident = path.join(
    slockHome,
    "computer",
    "k",
    "slots",
    "candidate",
    "raft-computer",
  );
  try {
    await mkdir(path.dirname(markerFile), { recursive: true });
    await writeFile(
      markerFile,
      `${JSON.stringify({
        formatVersion: 1,
        owner: "cli",
        enabled: true,
        dispatcherPath: process.execPath,
        label: "build.raft.computer.login.test",
        definitionPath: "/tmp/test.plist",
      })}\n`,
    );

    assert.equal(
      await resolveStableDispatcherPath(slockHome, {}, kResident),
      path.resolve(process.execPath),
    );
    assert.equal(
      await resolveStableDispatcherPath(
        slockHome,
        {},
        path.join(root, "installer-extract", "raft-computer"),
      ),
      path.resolve(process.execPath),
    );

    await writeFile(
      markerFile,
      `${JSON.stringify({
        formatVersion: 1,
        owner: "cli",
        enabled: true,
        dispatcherPath: path.join(root, "deleted-temp-dispatcher"),
        label: "build.raft.computer.login.test",
        definitionPath: "/tmp/test.plist",
      })}\n`,
    );
    await assert.rejects(
      resolveStableDispatcherPath(slockHome, {}, kResident),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "HOST_LIFECYCLE_DISPATCHER_UNBOUND",
        );
        return true;
      },
    );

    await writeFile(
      markerFile,
      `${JSON.stringify({
        formatVersion: 1,
        owner: "cli",
        enabled: true,
        dispatcherPath: path.join(
          path.dirname(process.execPath),
          `raft-computer-missing-${process.pid}`,
        ),
        label: "build.raft.computer.login.test",
        definitionPath: "/tmp/test.plist",
      })}\n`,
    );
    await assert.rejects(
      resolveStableDispatcherPath(slockHome, {}, kResident),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "HOST_LIFECYCLE_DISPATCHER_UNBOUND",
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
