#!/bin/sh
# Mellonta Linux installer, adapted from the Raft 1.13 installer (FSL-1.1-ALv2).
# Verifies exact GitHub release binary and WASM before replacing either file.
# Called by setup-client.sh or the checksum-verified Computer upgrade adapter.
# Required: --version X.Y.Z-mellonta.N (release packaging supplies the default).
# Overrides: RAFT_HOME / SLOCK_HOME, RAFT_COMPUTER_INSTALL_DIR,
# RAFT_COMPUTER_RELEASE_BASE, RAFT_COMPUTER_FORCE=1 (intentional downgrade),
# RAFT_COMPUTER_NO_MODIFY_PATH=1. No Node, sudo or external installer required.
set -eu

BIN_NAME="raft-computer"
PHOTON_WASM_NAME="photon_rs_bg.wasm"
INSTALL_DIR="${RAFT_COMPUTER_INSTALL_DIR:-$HOME/.local/bin}"
DEFAULT_INSTALL_DIR="$HOME/.local/bin"
NO_MODIFY_PATH="${RAFT_COMPUTER_NO_MODIFY_PATH:-0}"
# Publish workflows may patch this default for channel-specific installer roots.
INSTALL_CHANNEL_DEFAULT=""
STATE_HOME="${RAFT_HOME:-${SLOCK_HOME:-$HOME/.slock}}"
case "$STATE_HOME" in
  "~") STATE_HOME="$HOME" ;;
  "~/"*) STATE_HOME="$HOME/${STATE_HOME#~/}" ;;
esac
K_STATE_DIR="${STATE_HOME}/computer/k"
K_RESET_BACKUP=""
K_RESET_RESIDENT="0"
DISPATCHER_PUBLISHED="0"

err() {
  printf '[install] error: %s\n' "$1" >&2
  if [ -n "$K_RESET_BACKUP" ]; then
    printf '[install] previous K state is preserved at %s\n' "$K_RESET_BACKUP/k" >&2
  fi
  exit 1
}
info() { printf '[install] %s\n' "$1" >&2; }

usage() {
  printf '%s\n' \
    'Usage: install.sh [--channel main] [--version <semver>]' \
    '' \
    'Options:' \
    '  --channel <main>  Use the fork release channel.' \
    '  --version <semver>      Install one exact immutable version.' \
    '  -h, --help              Show this help.' \
    '' \
    'Command-line options override their RAFT_COMPUTER_* environment equivalents.' >&2
}

CLI_INSTALL_CHANNEL=""
CLI_VERSION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel)
      [ "$#" -ge 2 ] || err "--channel requires main"
      CLI_INSTALL_CHANNEL="$2"
      shift 2
      ;;
    --channel=*)
      CLI_INSTALL_CHANNEL="${1#--channel=}"
      [ -n "$CLI_INSTALL_CHANNEL" ] || err "--channel requires main"
      shift
      ;;
    --version)
      [ "$#" -ge 2 ] || err "--version requires a SemVer value"
      CLI_VERSION="$2"
      shift 2
      ;;
    --version=*)
      CLI_VERSION="${1#--version=}"
      [ -n "$CLI_VERSION" ] || err "--version requires a SemVer value"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) err "unknown option: $1 (run install.sh --help)" ;;
  esac
done

case "$CLI_INSTALL_CHANNEL" in
  "") ;;
  main) CLI_INSTALL_CHANNEL="latest" ;;
  *) err "invalid --channel: ${CLI_INSTALL_CHANNEL} (expected main)" ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || err "missing required tool: $1"; }
need uname; need mkdir; need chmod; need mv; need cp
if command -v curl >/dev/null 2>&1; then
  DL="curl -fsSL"; DLO="curl -fsSL -o"
  # The binary is ~150MB — show a progress bar (stderr is the user's TTY even
  # under `curl … | sh`) and retry on transient transport hiccups (e.g. the
  # HTTP/2 framing errors some networks hit on large downloads).
  DLP="curl -fL --retry 3 --retry-delay 1 --progress-bar -o"
elif command -v wget >/dev/null 2>&1; then
  DL="wget -qO-"; DLO="wget -qO"
  DLP="wget --tries=3 --show-progress -O"
else err "need curl or wget"; fi

# --- detect platform/arch in the same tokens build.mjs emits (process.platform/arch) ---
darwin_hardware_supports_arm64() {
  [ "$(/usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null || true)" = "1" ]
}

detect_target() {
  os="$(uname -s)"
  case "$os" in
    Darwin) PLAT="darwin" ;;
    Linux)  PLAT="linux" ;;
    *) err "unsupported OS: $os (this installer handles macOS + Linux; Windows uses install.ps1)" ;;
  esac

  machine="$(uname -m)"
  # A shell launched through Rosetta reports x86_64 even on Apple Silicon.
  # Query the hardware capability so install always chooses the native arm64 carrier.
  if [ "$os" = "Darwin" ] && darwin_hardware_supports_arm64; then
    machine="arm64"
  fi
  case "$machine" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *) err "unsupported arch: $machine" ;;
  esac
  TARGET="${PLAT}-${ARCH}"
case "$TARGET" in
  linux-x64|linux-arm64) ;;
  *) err "Mellonta releases support Linux x86-64 and ARM64 only" ;;
esac
}
detect_target

# Compare two SemVer 2.0.0 versions without depending on Node.js or a platform
# package manager. Prints newer/older/equal for the first argument relative to
# the second, or invalid-a/invalid-b when either input is not valid SemVer.
semver_compare() {
  LC_ALL=C awk -v a="$1" -v b="$2" '
    function valid_identifiers(value, prerelease, side, parts, count, i, item) {
      count = split(value, parts, ".")
      if (count < 1) return 0
      for (i = 1; i <= count; i++) {
        item = parts[i]
        if (item == "" || item !~ /^[0-9A-Za-z-]+$/) return 0
        if (prerelease && item ~ /^[0-9]+$/ && length(item) > 1 && substr(item, 1, 1) == "0") return 0
        if (prerelease) {
          if (side == "A") AP[i] = item
          else BP[i] = item
        }
      }
      if (prerelease) {
        if (side == "A") APC = count
        else BPC = count
      }
      return 1
    }
    function parse(value, side, plus, main, build, dash, core, pre, fields, count, i) {
      if (value == "" || value ~ /[[:space:]]/) return 0
      plus = index(value, "+")
      main = value
      if (plus > 0) {
        if (index(substr(value, plus + 1), "+") > 0) return 0
        build = substr(value, plus + 1)
        main = substr(value, 1, plus - 1)
        if (build == "" || !valid_identifiers(build, 0, side)) return 0
      }
      dash = index(main, "-")
      core = main
      pre = ""
      if (dash > 0) {
        core = substr(main, 1, dash - 1)
        pre = substr(main, dash + 1)
        if (pre == "" || !valid_identifiers(pre, 1, side)) return 0
      } else if (side == "A") APC = 0
      else BPC = 0

      count = split(core, fields, ".")
      if (count != 3) return 0
      for (i = 1; i <= 3; i++) {
        if (fields[i] !~ /^(0|[1-9][0-9]*)$/) return 0
      }
      if (side == "A") { AM = fields[1]; AN = fields[2]; AX = fields[3] }
      else { BM = fields[1]; BN = fields[2]; BX = fields[3] }
      return 1
    }
    function numeric_cmp(left, right) {
      if (length(left) > length(right)) return 1
      if (length(left) < length(right)) return -1
      if (("x" left) > ("x" right)) return 1
      if (("x" left) < ("x" right)) return -1
      return 0
    }
    function emit_relation(result) {
      if (result > 0) print "newer"
      else if (result < 0) print "older"
      else print "equal"
      exit
    }
    BEGIN {
      if (!parse(a, "A")) { print "invalid-a"; exit }
      if (!parse(b, "B")) { print "invalid-b"; exit }

      result = numeric_cmp(AM, BM); if (result != 0) emit_relation(result)
      result = numeric_cmp(AN, BN); if (result != 0) emit_relation(result)
      result = numeric_cmp(AX, BX); if (result != 0) emit_relation(result)

      if (APC == 0 && BPC == 0) emit_relation(0)
      if (APC == 0) emit_relation(1)
      if (BPC == 0) emit_relation(-1)

      limit = APC < BPC ? APC : BPC
      for (i = 1; i <= limit; i++) {
        a_numeric = AP[i] ~ /^[0-9]+$/
        b_numeric = BP[i] ~ /^[0-9]+$/
        if (a_numeric && b_numeric) result = numeric_cmp(AP[i], BP[i])
        else if (a_numeric) result = -1
        else if (b_numeric) result = 1
        else if (("x" AP[i]) > ("x" BP[i])) result = 1
        else if (("x" AP[i]) < ("x" BP[i])) result = -1
        else result = 0
        if (result != 0) emit_relation(result)
      }
      if (APC > BPC) emit_relation(1)
      if (APC < BPC) emit_relation(-1)
      emit_relation(0)
    }
  '
}

# --- resolve base + version ---
# Each immutable GitHub release contains its own manifest and assets.
RELEASE_BASE="${RAFT_COMPUTER_RELEASE_BASE:-https://github.com/Mellonta/raft-source/releases/download}"
VERSION="${CLI_VERSION:-${RAFT_COMPUTER_VERSION:-}}"
INSTALL_CHANNEL="${CLI_INSTALL_CHANNEL:-${RAFT_COMPUTER_INSTALL_CHANNEL:-$INSTALL_CHANNEL_DEFAULT}}"
if [ -n "$INSTALL_CHANNEL" ]; then
  case "$INSTALL_CHANNEL" in
    latest) ;;
    pinned:*)
      pinned_version="${INSTALL_CHANNEL#pinned:}"
      [ "$(semver_compare "$pinned_version" "$pinned_version")" = "equal" ] \
        || err "invalid RAFT_COMPUTER_INSTALL_CHANNEL: ${INSTALL_CHANNEL}"
      ;;
    *) err "invalid RAFT_COMPUTER_INSTALL_CHANNEL: ${INSTALL_CHANNEL}" ;;
  esac
fi

persist_install_channel() {
  [ -n "$INSTALL_CHANNEL" ] || return 0

  channel_dir="${STATE_HOME}/computer"
  channel_file="${channel_dir}/channel"
  mkdir -p "$channel_dir"
  tmp_channel="${channel_file}.$$"
  printf '%s\n' "$INSTALL_CHANNEL" > "$tmp_channel"
  chmod 600 "$tmp_channel"
  mv -f "$tmp_channel" "$channel_file"
  info "release channel set to ${INSTALL_CHANNEL} (${channel_file})"
}

# A cold probe home prevents an installed dispatcher from handing `--version`
# to K stable. Installer byte checks must describe the file being checked.
binary_self_version() {
  probe_home="$(mktemp -d)" || return 1
  probe_version="$(SLOCK_HOME="$probe_home" RAFT_HOME="$probe_home" "$1" --version 2>/dev/null | awk '{token=$1; sub(/^v/, "", token); print token; exit}' || true)"
  rm -rf "$probe_home"
  printf '%s' "$probe_version"
}

refuse_if_newer() {
  version_label="$1"
  local_version="$2"
  [ -n "$local_version" ] \
    || err "could not determine ${version_label} version; refusing to continue"
  cmp="$(semver_compare "$local_version" "$VERSION")"
  case "$cmp" in
    invalid-a) err "${version_label} reported invalid SemVer '${local_version}'; refusing to continue" ;;
    invalid-b) err "invalid release version: ${VERSION}" ;;
    newer|older|equal) ;;
    *) err "could not compare ${version_label} v${local_version} with target v${VERSION}" ;;
  esac
  if [ "$cmp" = "newer" ]; then
    persist_shell_path
    info "${version_label} v${local_version} is NEWER than the target v${VERSION}; refusing to downgrade."
    info "  (set RAFT_COMPUTER_FORCE=1 to install v${VERSION} anyway)"
    exit 0
  fi
}

persist_shell_path() {
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) return 0 ;;
  esac

  if [ "$NO_MODIFY_PATH" = "1" ]; then
    info "note: ${INSTALL_DIR} is not on PATH (shell profile update disabled by RAFT_COMPUTER_NO_MODIFY_PATH=1)"
    return 0
  fi
  if [ "$INSTALL_DIR" != "$DEFAULT_INSTALL_DIR" ]; then
    info "note: custom install dir ${INSTALL_DIR} is not on PATH — add it to your shell profile"
    return 0
  fi

  shell_path="${SHELL:-}"
  shell_name="${shell_path##*/}"
  case "$shell_name" in
    zsh)
      shell_config="${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    bash)
      shell_config="$HOME/.bashrc"
      ;;
    *)
      info "note: ${INSTALL_DIR} is not on PATH — add: export PATH=\"\$HOME/.local/bin:\$PATH\""
      return 0
      ;;
  esac

  path_line='export PATH="$HOME/.local/bin:$PATH"'
  if [ -f "$shell_config" ] && grep -Fqx "$path_line" "$shell_config"; then
    info "PATH already configured in ${shell_config}"
    return 0
  fi

  shell_config_dir="${shell_config%/*}"
  if ! mkdir -p "$shell_config_dir"; then
    info "note: could not create ${shell_config_dir} — add to your shell profile: ${path_line}"
    return 0
  fi
  if ! printf '\n# raft-computer\n%s\n' "$path_line" >> "$shell_config"; then
    info "note: could not update ${shell_config} — add manually: ${path_line}"
    return 0
  fi
  info "added ${INSTALL_DIR} to PATH in ${shell_config} (new shells will pick it up)"
  info "to refresh this shell, run: . \"${shell_config}\""
}


# Selection channel: explicit env wins; otherwise a previously persisted
# channel keeps re-installs on the machine's chosen track — the same file the
# runtime updater reads, so installer and updater can never disagree.
SELECT_CHANNEL="$INSTALL_CHANNEL"
if [ -z "$SELECT_CHANNEL" ] && [ -f "${STATE_HOME}/computer/channel" ]; then
  persisted_channel="$(tr -d ' \t\r\n' < "${STATE_HOME}/computer/channel" 2>/dev/null || true)"
  case "$persisted_channel" in
    latest) SELECT_CHANNEL="$persisted_channel" ;;
    pinned:*)
      if [ "$(semver_compare "${persisted_channel#pinned:}" "${persisted_channel#pinned:}")" = "equal" ]; then
        SELECT_CHANNEL="$persisted_channel"
      else
        info "ignoring invalid persisted release channel '${persisted_channel}'"
      fi
      ;;
    "") ;;
    *) info "ignoring invalid persisted release channel '${persisted_channel}'" ;;
  esac
fi

# A saved pin selects an exact version from the fork.
if [ -z "$VERSION" ]; then
  case "$SELECT_CHANNEL" in
    pinned:*) VERSION="${SELECT_CHANNEL#pinned:}" ;;
  esac
fi
[ -n "$VERSION" ] || err "Use setup-client.sh or pass --version X.Y.Z-mellonta.N"
case "$VERSION" in *-mellonta.*) ;; *) err "Only Mellonta releases are supported" ;; esac
[ "$(semver_compare "$VERSION" "$VERSION")" = "equal" ] || err "invalid release version: ${VERSION}"
INSTALL_CHANNEL="pinned:${VERSION}"
TAG="${VERSION}"
BASE="${RELEASE_BASE%/}/${VERSION}"

# --- version-detection downgrade guard ---
# If a binary is already at $INSTALL_DIR/$BIN_NAME, peek its `--version`. With
# the target version already resolved, we can skip the 143MB download in one
# case that must not install:
#   - local > target  → refuse with a clear hint (avoids accidental downgrade
#                       when RAFT_COMPUTER_VERSION pins
#                       an older release).
# Same-version bytes are still downloaded + hash-verified: version text alone
# is not proof that the local file is the immutable published candidate, and
# reinstalling the exact published bytes remains idempotent.
# Set RAFT_COMPUTER_FORCE=1 to bypass the downgrade guard.
# Comparison follows SemVer precedence, including numeric/non-numeric
# prerelease identifiers and the rule that a stable release outranks its
# prereleases. Invalid target or observed versions fail closed.
existing="$INSTALL_DIR/$BIN_NAME"
FORCE="${RAFT_COMPUTER_FORCE:-0}"
if [ -x "$existing" ]; then
  dispatcher_self_ver="$(binary_self_version "$existing" || true)"
  resident_ver="$("$existing" --version 2>/dev/null | awk '{print $1; exit}' || true)"
  [ "$(semver_compare "$dispatcher_self_ver" "$dispatcher_self_ver")" = "equal" ] \
    || err "PATH dispatcher at ${existing} reported invalid SemVer '${dispatcher_self_ver}'; refusing to continue"
  [ "$(semver_compare "$resident_ver" "$resident_ver")" = "equal" ] \
    || err "effective K stable reached through ${existing} reported invalid SemVer '${resident_ver}'; refusing to continue"
  if [ "$dispatcher_self_ver" = "$VERSION" ]; then
    info "PATH dispatcher already reports v${VERSION} from its own bytes; verifying and reinstalling the exact immutable candidate."
  fi
  if [ "$FORCE" != "1" ]; then
    refuse_if_newer "PATH dispatcher at ${existing}" "$dispatcher_self_ver"
    refuse_if_newer "effective K stable reached through ${existing}" "$resident_ver"
  fi
fi

info "installing ${BIN_NAME} ${VERSION} (${TARGET})"

# --- fetch manifest, pick this target's file + sha256 ---
tmp="$(mktemp -d)"
install_stage=""
wasm_stage=""
cleanup() {
  # A publish failure leaves the old dispatcher in place. Restore its K state
  # and service so a failed rename cannot strand the previous installation.
  if [ "$DISPATCHER_PUBLISHED" = "0" ] && [ -n "$K_RESET_BACKUP" ] && [ -d "$K_RESET_BACKUP/k" ] && [ ! -e "$K_STATE_DIR" ]; then
    mv "$K_RESET_BACKUP/k" "$K_STATE_DIR" || true
    if [ "$K_RESET_RESIDENT" = "1" ]; then
      SLOCK_HOME="$STATE_HOME" RAFT_HOME="$STATE_HOME" "$tmp/$FILE" start >&2 || true
    fi
  fi
  rm -rf "$tmp"
  [ -z "$install_stage" ] || rm -f "$install_stage"
  [ -z "$wasm_stage" ] || rm -f "$wasm_stage"
}
trap cleanup EXIT
$DLO "$tmp/manifest.json" "${BASE}/manifest.json" || err "failed to download manifest.json from ${BASE}"

# JSON extraction for targets["<target>"].{file,sha256,size,gz?}.
# The flattened manifest is one line; sibling target blocks must NOT bleed
# into the captured target body, so use awk to track brace depth and slice
# out exactly THIS target's `{ … }` body. Targets contain at most one nested
# `{…}` (the optional `gz` block) — but the brace tracker handles arbitrary
# nesting anyway, so a future schema extension can't reintroduce the
# bleeding-into-next-target regression that shipped install.sh#2913 had.
flat_manifest="$(tr -d '\n' < "$tmp/manifest.json")"
target_body="$(printf '%s' "$flat_manifest" | awk -v key="\"${TARGET}\"" '
  {
    s = $0
    n = index(s, key)
    if (n == 0) exit
    # advance past `"key":<spaces>{`
    rest = substr(s, n + length(key))
    sub(/^[[:space:]]*:[[:space:]]*\{/, "", rest)
    depth = 1
    out = ""
    for (i = 1; i <= length(rest); i++) {
      c = substr(rest, i, 1)
      if (c == "{") depth++
      else if (c == "}") {
        depth--
        if (depth == 0) { print out; exit }
      }
      out = out c
    }
  }
')"
[ -n "$target_body" ] || err "no prebuilt binary for ${TARGET} in manifest (${TAG})"

photon_body="$(printf '%s' "$flat_manifest" | awk -v key="\"photonWasm\"" '
  {
    s = $0
    n = index(s, key)
    if (n == 0) exit
    rest = substr(s, n + length(key))
    sub(/^[[:space:]]*:[[:space:]]*\{/, "", rest)
    depth = 1
    out = ""
    for (i = 1; i <= length(rest); i++) {
      c = substr(rest, i, 1)
      if (c == "{") depth++
      else if (c == "}") {
        depth--
        if (depth == 0) { print out; exit }
      }
      out = out c
    }
  }
')"
[ -n "$photon_body" ] || err "manifest missing photonWasm sidecar for image processing"

# Depth-aware key scoping (the 1.0.6 signing pipeline embedded an `apple`
# evidence object — with its own nested `file`/`sha256` keys — inside darwin
# targets, and the previous flat/greedy slicing resolved FILE to a receipt
# json and filled the gz fields from raw values: darwin installs downloaded
# the raw binary, its sha "verified", then gunzip failed). Only depth-0 keys
# of the target describe the binary, and only the depth-0 `gz` object is the
# gzip sidecar; nested evidence objects are ignored wholesale. Values here
# never contain braces or quotes (filenames, hashes, numbers).
strip_nested() {
  printf '%s' "$1" | awk '{
    s = $0; depth = 0; out = ""
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1)
      if (c == "{") { depth++; continue }
      if (c == "}") { depth--; continue }
      if (depth == 0) out = out c
    }
    print out
  }'
}
extract_gz_body() {
  printf '%s' "$1" | awk '{
    s = $0; n = length(s); depth = 0
    for (i = 1; i <= n; i++) {
      c = substr(s, i, 1)
      if (c == "{") { depth++; continue }
      if (c == "}") { depth--; continue }
      if (c == "\"" && depth == 0 && substr(s, i, 4) == "\"gz\"") {
        j = i + 4
        while (j <= n && substr(s, j, 1) ~ /[[:space:]]/) j++
        if (substr(s, j, 1) != ":") continue
        j++
        while (j <= n && substr(s, j, 1) ~ /[[:space:]]/) j++
        if (substr(s, j, 1) != "{") exit
        d = 1; out = ""
        for (k = j + 1; k <= n; k++) {
          ck = substr(s, k, 1)
          if (ck == "{") d++
          else if (ck == "}") { d--; if (d == 0) { print out; exit } }
          out = out ck
        }
      }
    }
  }'
}
outer_block="$(strip_nested "$target_body")"
gz_inner="$(strip_nested "$(extract_gz_body "$target_body")")"
photon_block="$(strip_nested "$photon_body")"

extract_str() {
  # $1 = block text, $2 = key
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}
extract_num() {
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p"
}
FILE="$(extract_str "$outer_block" file)"
WANT_SHA="$(extract_str "$outer_block" sha256)"
SIZE="$(extract_num "$outer_block" size)"
[ -n "$FILE" ] && [ -n "$WANT_SHA" ] || err "manifest entry for ${TARGET} missing file/sha256"
WASM_FILE="$(extract_str "$photon_block" file)"
WASM_WANT_SHA="$(extract_str "$photon_block" sha256)"
[ "$WASM_FILE" = "$PHOTON_WASM_NAME" ] && [ -n "$WASM_WANT_SHA" ] \
  || err "manifest photonWasm entry missing ${PHOTON_WASM_NAME}/sha256"

GZ_FILE=""; GZ_WANT_SHA=""; GZ_SIZE=""
if [ -n "$gz_inner" ]; then
  GZ_FILE="$(extract_str "$gz_inner" file)"
  GZ_WANT_SHA="$(extract_str "$gz_inner" sha256)"
  GZ_SIZE="$(extract_num "$gz_inner" size)"
fi

# --- download + verify ---
# Pick a sha256 tool once (used for both the gz and the binary verification).
if command -v sha256sum >/dev/null 2>&1; then SHA_CMD="sha256sum";
elif command -v shasum >/dev/null 2>&1; then SHA_CMD="shasum -a 256";
else err "need sha256sum or shasum to verify the download"; fi

info "downloading ${WASM_FILE} (image processing resource)…"
$DLO "$tmp/$WASM_FILE" "${BASE}/${WASM_FILE}" || err "failed to download ${WASM_FILE}"
GOT_WASM_SHA="$($SHA_CMD "$tmp/$WASM_FILE" | awk '{print $1}')"
[ "$GOT_WASM_SHA" = "$WASM_WANT_SHA" ] || err "sha256 mismatch for ${WASM_FILE} (got ${GOT_WASM_SHA}, want ${WASM_WANT_SHA})"
info "image processing resource sha256 verified"

if [ -n "$GZ_FILE" ] && [ -n "$GZ_WANT_SHA" ] && command -v gunzip >/dev/null 2>&1; then
  # Gzipped path: ~3× smaller download (e.g. 143MB → ~42MB). Verify the .gz
  # against its manifest sha, decompress, then verify the decompressed binary
  # against the canonical binary sha. Both checks gate the install — same
  # security posture as the direct path.
  info "downloading ${GZ_FILE} (~$(( ${GZ_SIZE:-0} / 1024 / 1024 ))MB, gzipped)…"
  $DLP "$tmp/$GZ_FILE" "${BASE}/${GZ_FILE}" || err "failed to download ${GZ_FILE}"
  GOT_GZ_SHA="$($SHA_CMD "$tmp/$GZ_FILE" | awk '{print $1}')"
  [ "$GOT_GZ_SHA" = "$GZ_WANT_SHA" ] || err "sha256 mismatch for ${GZ_FILE} (got ${GOT_GZ_SHA}, want ${GZ_WANT_SHA})"
  info "downloaded gzip sha256 verified"
  info "decompressing…"
  gunzip -c "$tmp/$GZ_FILE" > "$tmp/$FILE" || err "failed to gunzip ${GZ_FILE}"
  rm -f "$tmp/$GZ_FILE"
  GOT_SHA="$($SHA_CMD "$tmp/$FILE" | awk '{print $1}')"
  [ "$GOT_SHA" = "$WANT_SHA" ] || err "sha256 mismatch for ${FILE} after decompression (got ${GOT_SHA}, want ${WANT_SHA})"
  info "binary sha256 verified"
else
  # Direct (uncompressed) path. Used when the manifest has no gz sidecar
  # (older releases) or `gunzip` isn't available on this host.
  info "downloading ${FILE} (~$(( ${SIZE:-0} / 1024 / 1024 ))MB)…"
  $DLP "$tmp/$FILE" "${BASE}/${FILE}" || err "failed to download ${FILE}"
  GOT_SHA="$($SHA_CMD "$tmp/$FILE" | awk '{print $1}')"
  [ "$GOT_SHA" = "$WANT_SHA" ] || err "sha256 mismatch for ${FILE} (got ${GOT_SHA}, want ${WANT_SHA})"
  info "sha256 verified"
fi

# --- defense-in-depth: verify the downloaded binary's platform + arch ---
# Even if a manifest is malformed/tampered or the parser misroutes (the
# 0.0.53 #2913→#2924 regression silently installed the linux-x64 binary on a
# Mac), the bytes-on-disk shouldn't be allowed onto PATH unless they actually
# match the host. `file -b` on the just-decompressed binary catches a
# darwin↔linux or arm64↔x64 mismatch before `mv` puts it on PATH.
if command -v file >/dev/null 2>&1; then
  desc="$(file -b "$tmp/$FILE" 2>/dev/null || true)"
  case "$PLAT-$ARCH" in
    darwin-arm64) want_pat="Mach-O.*arm64" ;;
    darwin-x64)   want_pat="Mach-O.*x86_64" ;;
    linux-arm64)  want_pat="ELF.*aarch64" ;;
    linux-x64)    want_pat="ELF.*x86-64" ;;
    *)            want_pat="" ;;
  esac
  if [ -n "$want_pat" ]; then
    if ! printf '%s' "$desc" | grep -Eq "$want_pat"; then
      err "downloaded binary does not match host (host=${PLAT}-${ARCH}, file says: ${desc}). Refusing to install. This is usually a bug in install.sh — please report."
    fi
    info "binary platform verified (${PLAT}-${ARCH})"
  fi
fi

chmod +x "$tmp/$FILE"
candidate_version="$(binary_self_version "$tmp/$FILE" || true)"
[ "$candidate_version" = "$VERSION" ] \
  || err "verified candidate reported version '${candidate_version}', expected '${VERSION}'"

# The installer owns replacement independently of K's upgrade protocol. Old
# receipts (local or remote), journal phases and stale locks are archived as
# bytes; none is acknowledged, replayed or interpreted as an install gate.
reset_k_state() {
  old_pid="$(cat "$STATE_HOME/computer/run/service.pid" 2>/dev/null || true)"
  case "$old_pid" in
    ''|*[!0-9]*) old_pid="" ;;
    *) if [ "$old_pid" -gt 1 ] && kill -0 "$old_pid" 2>/dev/null; then K_RESET_RESIDENT="1"; fi ;;
  esac
  info "stopping Computer before replacement"
  SLOCK_HOME="$STATE_HOME" RAFT_HOME="$STATE_HOME" "$tmp/$FILE" stop \
    || err "could not stop Computer; K state has not been reset"
  if [ "$K_RESET_RESIDENT" = "1" ] && kill -0 "$old_pid" 2>/dev/null; then
    err "Computer process $old_pid is still running; K state has not been reset"
  fi
  [ -d "$K_STATE_DIR" ] || return 0
  # Detached upgrade drivers are not service children. Stop only an identified
  # K driver; never send a signal to an unrelated process after PID reuse.
  for pid in $(sed -nE 's/.*"coordinatorPid"[[:space:]]*:[[:space:]]*"?([0-9]+)"?.*/\1/p' "$K_STATE_DIR/operation.json" 2>/dev/null || true) \
             $(sed -nE 's/.*"pid"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$K_STATE_DIR/upgrade.lock" 2>/dev/null || true); do
    [ "$pid" -gt 1 ] || continue
    kill -0 "$pid" 2>/dev/null || continue
    driver_command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$driver_command" in
      *'__k-upgrade'*)
        kill -TERM "$pid" || err "could not stop upgrade driver $pid"
        tries=0
        while kill -0 "$pid" 2>/dev/null; do
          tries=$((tries + 1))
          [ "$tries" -lt 15 ] || err "upgrade driver $pid did not stop; K state has not been reset"
          sleep 1
        done
        ;;
      *) info "ignoring stale K process reference $pid; unrelated process left untouched" ;;
    esac
  done
  mkdir -p "$STATE_HOME/computer/k-quarantine"
  K_RESET_BACKUP="$(mktemp -d "$STATE_HOME/computer/k-quarantine/installer-${VERSION}.XXXXXX")" \
    || err "could not create K backup directory"
  mv "$K_STATE_DIR" "$K_RESET_BACKUP/k" || err "could not archive K state"
  info "K state reset; complete previous state saved to $K_RESET_BACKUP/k"
}

# --- stage and verify all install files before stopping the service ---
mkdir -p "$INSTALL_DIR" || err "failed to create install directory ${INSTALL_DIR}"
install_stage="$INSTALL_DIR/.${BIN_NAME}.install.$$"
wasm_stage="$INSTALL_DIR/.${PHOTON_WASM_NAME}.install.$$"
cp "$tmp/$WASM_FILE" "$wasm_stage" || err "failed to stage verified image processing resource beside install target"
STAGED_WASM_SHA="$($SHA_CMD "$wasm_stage" | awk '{print $1}')"
[ "$STAGED_WASM_SHA" = "$WASM_WANT_SHA" ] || err "sha256 mismatch after staging ${PHOTON_WASM_NAME} (got ${STAGED_WASM_SHA}, want ${WASM_WANT_SHA})"
cp "$tmp/$FILE" "$install_stage" || err "failed to stage verified binary beside install target"
chmod +x "$install_stage"
STAGED_SHA="$($SHA_CMD "$install_stage" | awk '{print $1}')"
[ "$STAGED_SHA" = "$WANT_SHA" ] || err "sha256 mismatch after staging install candidate (got ${STAGED_SHA}, want ${WANT_SHA})"
STAGED_VERSION="$(binary_self_version "$install_stage" || true)"
[ "$STAGED_VERSION" = "$VERSION" ] || err "staged binary reported version '${STAGED_VERSION}', expected '${VERSION}'"
reset_k_state
mv -f "$wasm_stage" "$INSTALL_DIR/$PHOTON_WASM_NAME" || err "failed to atomically promote verified image processing resource"
mv -f "$install_stage" "$INSTALL_DIR/$BIN_NAME" || err "failed to atomically promote verified install candidate"
DISPATCHER_PUBLISHED="1"
INSTALLED_SHA="$($SHA_CMD "$INSTALL_DIR/$BIN_NAME" | awk '{print $1}')"
[ "$INSTALLED_SHA" = "$WANT_SHA" ] || err "sha256 mismatch after dispatcher publish (got ${INSTALLED_SHA}, want ${WANT_SHA})"
INSTALLED_VERSION="$(binary_self_version "$INSTALL_DIR/$BIN_NAME" || true)"
[ "$INSTALLED_VERSION" = "$VERSION" ] || err "installed dispatcher reported version '${INSTALLED_VERSION}', expected '${VERSION}'"
info "installed to ${INSTALL_DIR}/${BIN_NAME}"
persist_install_channel
persist_shell_path
if [ "$K_RESET_RESIDENT" = "1" ]; then
  SLOCK_HOME="$STATE_HOME" RAFT_HOME="$STATE_HOME" "$INSTALL_DIR/$BIN_NAME" start \
    || err "installed $VERSION but could not restart Computer"
  live_status="$(SLOCK_HOME="$STATE_HOME" RAFT_HOME="$STATE_HOME" "$INSTALL_DIR/$BIN_NAME" status)" \
    || err "installed $VERSION but could not read service status"
  live_version="$(printf '%s\n' "$live_status" | awk '/^Service version:/ {print $3; exit}')"
  [ "$live_version" = "$VERSION" ] || err "installed $VERSION but live service reports '$live_version'"
  info "running Computer $live_version"
fi

# --- previous (npm-global) installs ---
# The self-contained SEA binary supersedes any `npm i -g @botiverse/raft-computer`
# ~/.slock/computer is shared across binaries, so login/attachments carry over
# automatically — only the on-PATH binary needs to change hands. Upgrades are
# now SEA-only, so an old npm install can no longer self-upgrade; it must be
# replaced by this binary. We don't modify the user's npm — just detect a
# shadowing install and advise, so the new binary wins.
new="$INSTALL_DIR/$BIN_NAME"
prev="$(command -v "$BIN_NAME" 2>/dev/null || true)"
if [ -n "$prev" ] && [ "$prev" != "$new" ]; then
  info "found an existing ${BIN_NAME} at ${prev} (older install)."
  if command -v npm >/dev/null 2>&1 && npm ls -g --depth 0 @botiverse/raft-computer >/dev/null 2>&1; then
    info "  it was installed via npm and can no longer self-upgrade (upgrade is now SEA-only)."
    info "  remove it so this self-contained binary takes over:"
    info "    npm uninstall -g @botiverse/raft-computer"
  else
    info "  remove it, or ensure ${INSTALL_DIR} precedes its directory on PATH, so the new binary wins."
  fi
fi

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) info "done — run: ${BIN_NAME} --version" ;;
  *)
    info "installed successfully. Open a new terminal to use ${BIN_NAME}."
    if [ "$INSTALL_DIR" = "$DEFAULT_INSTALL_DIR" ]; then
      info 'to use it in this terminal, run: export PATH="$HOME/.local/bin:$PATH"'
    else
      info "to use it in this terminal, add ${INSTALL_DIR} to PATH"
    fi
    ;;
esac
