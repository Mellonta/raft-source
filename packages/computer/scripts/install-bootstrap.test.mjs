#!/usr/bin/env node
// Execute the pinned install.sh entry script against a local file://
// immutable-release mirror with an argv-printing stub installer, pinning the
// RAFT_COMPUTER_VERSION forwarding contract that the released desktop/web
// install commands depend on. The Windows side of the same contract runs in
// the SEA build's win32 job against the same pinned install.ps1.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// The entry scripts are not committed here: they live in the public
// botiverse/raft-computer-installer repository at the commit pinned in
// installer-entry.json, fetched raw by that SHA. A fetch failure fails this
// file (no skip).
const pin = JSON.parse(readFileSync(new URL('./installer-entry.json', import.meta.url), 'utf8'));
async function raw(name) {
  const url = `https://raw.githubusercontent.com/${pin.repository}/${pin.commit}/bootstrap/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}
const [scriptText, ps1Text] = await Promise.all([raw('install.sh'), raw('install.ps1')]);

function sandbox(t, { script = scriptText } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-pin-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const mirror = join(root, 'mirror');
  // Cover every unix target the bootstrap can resolve on a developer machine,
  // not just CI's linux-x64.
  const stub = '#!/bin/sh\n: > "$PIN_OUT"\nfor a in "$@"; do printf \'<%s>\' "$a" >> "$PIN_OUT"; done\n';
  let sums = '';
  for (const target of ['linux-x64', 'darwin-arm64', 'darwin-x64']) {
    const nativeDir = join(mirror, 'native', target);
    mkdirSync(nativeDir, { recursive: true });
    const bin = join(nativeDir, 'raft-computer-installer');
    writeFileSync(bin, stub);
    chmodSync(bin, 0o755);
    sums += `${createHash('sha256').update(readFileSync(bin)).digest('hex')}  native/${target}/raft-computer-installer\n`;
  }
  writeFileSync(join(mirror, 'SHA256SUMS'), sums);
  const patched = join(root, 'install.sh');
  writeFileSync(patched, script);
  return { root, patched, out: join(root, 'argv.txt') };
}

function runBootstrap(sbx, { args = [], env = {} } = {}) {
  const result = spawnSync('sh', [sbx.patched, ...args], {
    env: {
      ...process.env,
      PIN_OUT: sbx.out,
      RAFT_COMPUTER_INSTALLER_RELEASE_BASE: `file://${sbx.root}/mirror`,
      ...env,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(sbx.out, 'utf8');
}

test('bootstrap forwards RAFT_COMPUTER_VERSION as --version with explicit-argument precedence', t => {
  const sbx = sandbox(t);
  assert.equal(runBootstrap(sbx), '<install>');
  assert.equal(runBootstrap(sbx, { env: { RAFT_COMPUTER_VERSION: '1.0.29' } }), '<install><--version><1.0.29>');
  assert.equal(
    runBootstrap(sbx, { args: ['install', '--version', '9.9.9'], env: { RAFT_COMPUTER_VERSION: '1.0.29' } }),
    '<install><--version><9.9.9>',
    'an explicit --version wins over the environment pin',
  );
  assert.equal(
    runBootstrap(sbx, { args: ['status'], env: { RAFT_COMPUTER_VERSION: '1.0.29' } }),
    '<status>',
    'non-install commands never receive the pin',
  );
  assert.equal(
    runBootstrap(sbx, { args: ['upgrade', '--channel', 'alpha'], env: { RAFT_COMPUTER_VERSION: '1.0.29' } }),
    '<upgrade><--channel><alpha>',
    'an explicit --channel wins over the environment pin',
  );
});

test('bootstrap pin wins over a baked INSTALL_CHANNEL_DEFAULT', t => {
  const sbx = sandbox(t, {
    script: scriptText.replace('INSTALL_CHANNEL_DEFAULT=""', 'INSTALL_CHANNEL_DEFAULT="alpha"'),
  });
  assert.notEqual(readFileSync(sbx.patched, 'utf8'), scriptText, 'channel-default bake did not apply');
  assert.equal(runBootstrap(sbx, { env: { RAFT_COMPUTER_VERSION: '1.0.29' } }), '<install><--version><1.0.29>');
  assert.equal(runBootstrap(sbx), '<install><--channel><alpha>');
});

test('tooth: deleting the pin block silently drops the version pin', t => {
  const withoutPin = scriptText.split('\n')
    .filter(l => !l.includes('set -- "$@" --version "$RAFT_COMPUTER_VERSION"'))
    .join('\n');
  assert.notEqual(withoutPin, scriptText, 'mutation did not apply');
  const sbx = sandbox(t, { script: withoutPin });
  assert.equal(
    runBootstrap(sbx, { env: { RAFT_COMPUTER_VERSION: '1.0.29' } }),
    '<install>',
    'without the pin block the environment pin is silently ignored: the contract tests above turn red',
  );
});

test('sh/ps1 pin forwarding stays in lockstep (static cross-check)', () => {
  // The Windows execution contract runs in the SEA win32 job; this static pin
  // keeps the two entry scripts from drifting apart on Linux CI too.
  assert.match(ps1Text, /\$argv \+= @\('--version', \$env:RAFT_COMPUTER_VERSION\)/,
    'install.ps1 lost the RAFT_COMPUTER_VERSION forwarding');
  assert.match(ps1Text, /explicit --version/,
    'install.ps1 lost the explicit-argument precedence note');
  assert.match(scriptText, /set -- "\$@" --version "\$RAFT_COMPUTER_VERSION"/,
    'install.sh lost the RAFT_COMPUTER_VERSION forwarding');
});

test('sh/ps1 show the executable download instead of silencing both transfers', () => {
  assert.match(scriptText, /dl_progress\(\) \{ curl -fL --progress-bar/,
    'install.sh lost the visible curl progress bar');
  assert.match(scriptText, /dl_progress "\$binary_url" "\$tmp\/installer"/,
    'install.sh no longer uses the visible path for the executable');
  assert.match(ps1Text, /\$ProgressPreference = if \(\$showProgress\) \{ 'Continue' \}/,
    'install.ps1 lost its scoped progress preference');
  assert.match(ps1Text, /Download \$binaryUrl \$cli \$true/,
    'install.ps1 no longer enables progress for the executable');
});

test('both SEA publish workflows carry the Windows argv contract and no scalar steps', () => {
  // Structural tooth: a step that is a bare scalar (`- name` with no mapping)
  // is invalid Actions structure and must never ship.
  for (const wf of ['publish-computer-sea.yml', 'publish-computer-staging-sea.yml']) {
    const text = readFileSync(new URL(`../../../.github/workflows/${wf}`, import.meta.url), 'utf8');
    assert.match(text, /Verify the Windows bootstrap argv contract/, `${wf} lost the Windows argv contract step`);
    const bare = text.split('\n').filter(l => /^(\s*)- name\s*$/.test(l));
    assert.deepEqual(bare, [], `${wf} contains a bare scalar step: ${bare.join('; ')}`);
  }
});

test('staging installer publication is compare-and-swap and keeps alpha baked in', () => {
  const text = readFileSync(new URL('../../../.github/workflows/publish-computer-staging-sea.yml', import.meta.url), 'utf8');
  assert.match(text, /previous_staging_installer_sha256:/,
    'staging install.sh has no compare-and-swap input');
  assert.match(text, /previous_staging_installer_ps1_sha256:/,
    'staging install.ps1 has no compare-and-swap input');
  assert.match(text, /s3:\/\/slock-staging-cdn\/\$key/,
    'the installer-only job no longer writes the staging bucket');
  assert.match(text, /slock-cdn-staging\.botiverse\.dev\/\$key\?fresh=/,
    'the installer-only job no longer reads back the public staging object');
  assert.match(text, /INSTALL_CHANNEL_DEFAULT="alpha"/,
    'the staging shell entry point lost its alpha default');
  assert.match(text, /\$InstallChannelDefault = 'alpha'/,
    'the staging PowerShell entry point lost its alpha default');
});
