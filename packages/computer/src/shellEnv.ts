/**
 * `@botiverse/raft-computer/shell-env` — the service-boot environment seam for
 * hosts other than the `raft-computer` CLI entry (Raft Desktop's app-hosted
 * `__service`, slock#8610).
 *
 * Deliberately a SEPARATE, lightweight entry (no service graph): the capture
 * must be applied to process.env BEFORE any module of the service graph
 * evaluates (home/path constants, lock markers and runtime registries read env
 * at module init) — importing it through `./lib` would load that graph first.
 *
 * Same contract as the CLI-hosted login carrier (task #326): the user's login
 * shell runs once (bounded, nonce-framed), the result replaces the service env
 * with protected keys re-applied, and failure keeps the baseline env and
 * records `RAFT_COMPUTER_SHELL_ENV_STATE=unavailable:<code>`.
 *
 * Host contract:
 *  - the host binary must answer `<selfExec…> __print-env --nonce N --sock P`
 *    by calling `printEnvMode(process.argv)` before anything else;
 *  - in its `__service` mode it sets LOGIN_CARRIER_ENV_VAR=1 and awaits
 *    `bootstrapServiceEnv(process.argv, process.env, () => captureShellEnv({ selfExec }))`
 *    before importing `@botiverse/raft-computer/lib`.
 */
export {
  bootstrapServiceEnv,
  captureShellEnv,
  LOGIN_CARRIER_ENV_VAR,
  printEnvMode,
  SHELL_ENV_STATE_ENV_VAR,
  type ShellEnvCaptureResult,
} from "./shellEnvCapture";
