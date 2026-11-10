import { browserPrivacyMode } from "@botiverse/raft-shared/src/browserPrivacy";
import { getServerUrl } from "./server";

export const STAGING_COMPUTER_SERVER_URL = "https://api-aws-staging.botiverse.dev";
export const DEFAULT_COMPUTER_SERVER_URL = "https://api.raft.build";
export const LEGACY_DEFAULT_COMPUTER_SERVER_URL = "https://api.slock.ai";

// The Computer ships as a self-contained SEA binary installed by the native
// shell script (`install.sh` on macOS/Linux, `install.ps1` on Windows), not
// npm — no Node/npm required. The installer resolves the latest version from
// the release base `manifest.json`. Prod uses the formal
// computer-v* channel; staging uses a branch snapshot channel isolated under
// /computer/staging. The installed binary is `raft-computer`.
export const COMPUTER_CDN_BASE_STAGING = "https://slock-cdn-staging.botiverse.dev/computer/staging";
export const COMPUTER_CDN_BASE_PROD = "https://cdn.raft.build/computer";

export type ComputerCommandPlatform = "mac-linux" | "windows";

/** Set by Mellonta's web build and dev launcher using the checked-in client pin. */
export function mellontaComputerVersion(): string | undefined {
  const version = import.meta.env?.VITE_MELLONTA_COMPUTER_VERSION;
  if (version && !/^\d+\.\d+\.\d+-mellonta\.\d+$/.test(version)) throw new Error("Invalid Mellonta Computer version");
  return version || undefined;
}

function shellArg(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function normalizeComputerVersionPin(version?: string | null): string | null {
  const normalized = version?.trim() ?? "";
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)
    ? normalized
    : null;
}

export function computerInstallCommand(
  deploymentEnv?: string,
  version?: string | null,
): string {
  const base = deploymentEnv === "staging" ? COMPUTER_CDN_BASE_STAGING : COMPUTER_CDN_BASE_PROD;
  const versionPin = normalizeComputerVersionPin(version);
  const installEnv = [
    ...(deploymentEnv === "staging"
      ? [
          `RAFT_COMPUTER_RELEASE_BASE=${base}`,
          "RAFT_COMPUTER_INSTALL_CHANNEL=alpha",
        ]
      : []),
    ...(versionPin ? [`RAFT_COMPUTER_VERSION=${versionPin}`] : []),
  ];
  return `curl -fsSL ${base}/install.sh | ${installEnv.length > 0 ? `${installEnv.join(" ")} ` : ""}sh`;
}

export function windowsComputerInstallCommand(
  deploymentEnv?: string,
  version?: string | null,
): string {
  const base = deploymentEnv === "staging" ? COMPUTER_CDN_BASE_STAGING : COMPUTER_CDN_BASE_PROD;
  const versionPin = normalizeComputerVersionPin(version);
  const installEnv = [
    ...(deploymentEnv === "staging"
      ? [
          `$env:RAFT_COMPUTER_RELEASE_BASE = "${base}"`,
          '$env:RAFT_COMPUTER_INSTALL_CHANNEL = "alpha"',
        ]
      : []),
    ...(versionPin ? [`$env:RAFT_COMPUTER_VERSION = "${versionPin}"`] : []),
  ];
  const installUrl = deploymentEnv === "staging"
    ? '"$env:RAFT_COMPUTER_RELEASE_BASE/install.ps1"'
    : `${base}/install.ps1`;
  return `${installEnv.length > 0 ? `${installEnv.join("; ")}; ` : ""}irm ${installUrl} | iex`;
}

export interface ComputerSetupCommandOptions {
  // Retained as a no-op input so existing callsites (AddMachineDialog,
  // MachineDetailPanel) keep passing the daemon-side legacy key without
  // churn. The CLI removed `--adopt-legacy` / `--legacy-api-key` in
  // RFC v9 PR-impl-3 commit 3 — legacy-daemon adoption is now driven by
  // an interactive TTY prompt inside `raft-computer setup`, not flags.
  legacyApiKey?: string | null;
  // Identity-carried adoption (task #239 PR-D/PR-E): when the calling
  // surface knows WHICH machine row this computer is (machine detail
  // page), the command carries `--machine <id>` and `raft-computer setup`
  // adopts that row directly — no fingerprint matching, no local
  // evidence, works after key rotation. The id is an identifier, not a
  // secret.
  machineId?: string | null;
  platform?: ComputerCommandPlatform;
  // Optional deterministic installer target. Manual fresh-install recovery
  // uses the currently published Computer artifact instead of relying on a
  // CDN edge's potentially stale latest manifest.
  version?: string | null;
}

export interface ComputerCommands {
  install: string;
  setup: string;
  // mac/Linux production only: install, then run setup with the installed
  // binary, in one paste (`… | sh -s -- --setup /slug`). The entry script
  // never depends on the new PATH entry. Null where install and setup stay
  // separate steps (Windows, isolated test deployments).
  installAndSetup: string | null;
  status: string;
  doctor: string;
  // Restart the whole Computer service and every attached server runner.
  restartService: string;
  // Restart while scoping lifecycle readback to one server.
  restart: string;
  stop: string;
  start: string;
}

// Non-production deployments (staging / slockdev) are internal test surfaces.
// A tester frequently runs the connect command on a machine that already runs
// a real prod Computer; without isolation the command would install over
// ~/.local/bin/raft-computer and write state into ~/.slock, clobbering their
// prod Computer (binary + channel + state). For these envs every command
// carries the same per-server home/bin, while remaining a separate copy step:
// install only installs, setup only runs the installed binary, and terminal
// actions address that same isolated Computer. Production stays default — real
// users legitimately want a single Computer at the default location.
const ISOLATED_DEPLOYMENT_ENVS = new Set(["staging", "slockdev"]);

export function getComputerCommands(
  serverSlug: string | undefined | null,
  deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV,
  serverUrl?: string,
  options: ComputerSetupCommandOptions = {},
): ComputerCommands | null {
  const slug = serverSlug?.trim().replace(/^\/+/, "");
  if (!slug) return null;

  const platform = options.platform ?? "mac-linux";

  const privateMode = browserPrivacyMode();
  const forkVersion = mellontaComputerVersion();
  if (forkVersion && platform === "mac-linux") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug)) return null;
    const isolated = ISOLATED_DEPLOYMENT_ENVS.has(deploymentEnv ?? "");
    const home = isolated ? '"$HOME"/' + shellArg(".raft-computer-" + slug) : '"${RAFT_HOME:-${SLOCK_HOME:-$HOME/.slock}}"';
    const paths = isolated ? ` --home ${home} --install-dir ${home}/bin` : "";
    const release = `https://github.com/Mellonta/raft-source/releases/download/${forkVersion}/setup-client.sh`;
    const origin = shellArg(serverUrl || getServerUrl());
    const workspace = shellArg("/" + slug);
    // Run the downloaded Bash file with its original terminal available for device login.
    const install = `(script=$(mktemp) && trap 'rm -f "$script"' EXIT && curl -fsSLo "$script" ${release} && RAFT_PRIVACY_MODE=${privateMode ? 1 : 0} bash "$script" --server-url ${origin} --workspace ${workspace}${paths} --install-only)`;
    const binary = `bash ${home}/mellonta/raft-computer`;
    const machine = options.machineId ? " --machine " + shellArg(options.machineId) : "";
    const setup = `${binary} setup ${workspace} --server-url ${origin}${machine}`;
    return {
      install, setup, installAndSetup: `${install} && ${setup}`,
      status: `${binary} status`, doctor: `${binary} doctor`, restartService: `${binary} restart`,
      restart: `${binary} restart ${workspace}`, stop: `${binary} stop`, start: `${binary} start`,
    };
  }
  const privacyEnv = privateMode
    ? (platform === "windows" ? '$env:RAFT_PRIVACY_MODE = "1"; ' : "RAFT_PRIVACY_MODE=1 ")
    : "";
  const commandServerUrl = privateMode ? serverUrl || getServerUrl()
    : deploymentEnv === "production"
    ? isDefaultComputerServerUrl(serverUrl) ? null : serverUrl
    : deploymentEnv === "staging"
    ? STAGING_COMPUTER_SERVER_URL
    : deploymentEnv === "slockdev"
      ? serverUrl
      : null;
  const serverUrlArg = commandServerUrl ? ` --server-url ${commandServerUrl}` : "";
  const machineArg = options.machineId ? ` --machine ${options.machineId}` : "";
  const setupArgs = `${serverUrlArg}${machineArg}`;
  if (deploymentEnv && ISOLATED_DEPLOYMENT_ENVS.has(deploymentEnv)) {
    // `slug` is the canonical setup slug (same one used in `setup /${slug}`),
    // so the isolated home matches across web-generated command, #105 harness,
    // and manual QA. Every independent command carries the same env and invokes
    // the isolated binary by full path because it is intentionally not installed
    // on the tester's default PATH. `paths.ts` reads
    // `RAFT_HOME || SLOCK_HOME`, so RAFT_HOME alone carries the state root.
    if (platform === "windows") {
      const home = `$env:USERPROFILE\\.raft-computer-${slug}`;
      const environment = `${privacyEnv}$env:RAFT_HOME = "${home}"; $env:RAFT_COMPUTER_INSTALL_DIR = "$env:RAFT_HOME\\bin";`;
      const binary = `& "$env:RAFT_COMPUTER_INSTALL_DIR\\raft-computer.exe"`;
      return {
        install: privateMode || forkVersion ? "" : `${environment} ${windowsComputerInstallCommand(deploymentEnv, options.version)}`,
        setup: `${environment} ${binary} setup /${slug}${setupArgs}`,
        installAndSetup: null,
        status: `${environment} ${binary} status`,
        doctor: `${environment} ${binary} doctor`,
        restartService: `${environment} ${binary} restart`,
        restart: `${environment} ${binary} restart /${slug}`,
        stop: `${environment} ${binary} stop`,
        start: `${environment} ${binary} start`,
      };
    }

    const home = `$HOME/.raft-computer-${slug}`;
    const environment = `${privacyEnv}RAFT_HOME="${home}" RAFT_COMPUTER_INSTALL_DIR="${home}/bin"`;
    const binary = `"${home}/bin/raft-computer"`;
    return {
      install: privateMode || forkVersion ? "" : `${environment} sh -c '${computerInstallCommand(deploymentEnv, options.version)}'`,
      setup: `${environment} ${binary} setup /${slug}${setupArgs}`,
      installAndSetup: null,
      status: `${environment} ${binary} status`,
      doctor: `${environment} ${binary} doctor`,
      restartService: `${environment} ${binary} restart`,
      restart: `${environment} ${binary} restart /${slug}`,
      stop: `${environment} ${binary} stop`,
      start: `${environment} ${binary} start`,
    };
  }

  return {
    install: privateMode || forkVersion ? "" : platform === "windows"
      ? windowsComputerInstallCommand(deploymentEnv, options.version)
      : computerInstallCommand(deploymentEnv, options.version),
    setup: `${privacyEnv}raft-computer setup /${slug}${setupArgs}`,
    installAndSetup: privateMode || forkVersion || platform === "windows"
      ? null
      : `${computerInstallCommand(deploymentEnv, options.version)} -s -- --setup /${slug}${setupArgs}`,
    status: `${privacyEnv}raft-computer status`,
    doctor: `${privacyEnv}raft-computer doctor`,
    restartService: `${privacyEnv}raft-computer restart`,
    restart: `${privacyEnv}raft-computer restart /${slug}`,
    stop: `${privacyEnv}raft-computer stop`,
    start: `${privacyEnv}raft-computer start`,
  };
}

export function getComputerSetupCommand(
  serverSlug: string | undefined | null,
  deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV,
  serverUrl?: string,
  options: ComputerSetupCommandOptions = {},
): string | null {
  return getComputerCommands(serverSlug, deploymentEnv, serverUrl, options)?.setup ?? null;
}

function isDefaultComputerServerUrl(serverUrl: string | undefined): boolean {
  const normalized = serverUrl?.trim().replace(/\/+$/, "");
  return normalized === DEFAULT_COMPUTER_SERVER_URL || normalized === LEGACY_DEFAULT_COMPUTER_SERVER_URL;
}
