import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHandsClient } from './publish-hands-release.mjs';
import { uploadAsset as directUploadAsset } from './hands-hosted-transport.mjs';
import { loadHostedArtifacts, assertHostedAssetSet, verifyHostedRelease } from './hands-artifacts.mjs';

/** Preserve existing release/build identities while atomically replacing the
 * external storage backing. No channel pointer is changed by this operation. */
export async function backfillHosted({ api, appId, buildId, expected, releaseIds, uploadAsset, ...options }) {
  const verified = await loadHostedArtifacts(options);
  if (verified.version !== expected.version_name || !releaseIds?.length) throw new Error('backfill requires exact version and existing release identities');
  const path = `/api/apps/${appId}/builds/${buildId}`;
  const before = await api('GET', path);
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'artifact_mode' && before[key] === 'hands_r2') continue;
    if (before[key] !== value) throw new Error(`backfill identity differs: ${key}`);
  }
  if (!['external', 'hands_r2'].includes(before.artifact_mode) || before.status !== 'succeeded') throw new Error('backfill requires a published build');
  if (before.artifact_mode === 'external') {
    const required_asset_slots_json = verified.assets.map(({ artifact_kind, platform, arch, variant, filetype }) => ({ artifact_kind, platform, arch, variant, filetype }));
    await api('POST', `${path}/hosted-migration`, { expected, required_asset_slots_json });
    for (const asset of verified.assets) await uploadAsset({ api, apiBase: options.apiBase, appId, buildId, asset });
  }
  const assets = (await api('GET', `${path}/assets`)).assets;
  assertHostedAssetSet(assets, verified.assets);
  if (assets.some(a => !a.id) || new Set(assets.map(a => a.id)).size !== assets.length) throw new Error('backfill asset IDs must be unique');
  await api('POST', `${path}/hosted-migration/complete`, { asset_ids: assets.map(a => a.id) });
  const after = await api('GET', path);
  for (const key of ['id', 'source', 'version_name', 'version_code', 'status', 'provenance_json']) {
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) throw new Error(`backfill changed build identity: ${key}`);
  }
  if (after.artifact_mode !== 'hands_r2') throw new Error('backfill did not atomically switch storage');
  for (const releaseId of releaseIds) await verifyHostedRelease({ origin: options.apiBase, appSlug: options.appSlug, releaseId, assets: verified.assets, fetchImpl: options.publicFetch });
  return { build_id: buildId, release_ids: releaseIds, version: verified.version, status: 'hosted-and-public-bytes-verified' };
}

export async function runBackfillCommand(argv, overrides = {}) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i + 1]) throw new Error('expected --option value');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  for (const key of ['app-id', 'app', 'build-id', 'expected', 'release-ids', 'manifest', 'artifact-dir', 'output']) if (!args[key]) throw new Error(`--${key} required`);
  if (args.mode && !['plan', 'apply'].includes(args.mode)) throw new Error('--mode must be plan or apply');
  const expected = JSON.parse(await readFile(args.expected, 'utf8'));
  if (!expected.source || !expected.version_name || !Number.isSafeInteger(expected.version_code) || expected.artifact_mode !== 'external' || expected.status !== 'succeeded') throw new Error('complete original external succeeded identity required');
  const releaseIds = JSON.parse(await readFile(args['release-ids'], 'utf8'));
  if (!Array.isArray(releaseIds) || !releaseIds.length || releaseIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id))) throw new Error('existing release IDs required');
  const apiBase = process.env.HANDS_API ?? 'https://hands.build';
  const api = overrides.api ?? createHandsClient({ apiBase, token: process.env.HANDS_BEARER_TOKEN });
  const options = { api, apiBase, appId: args['app-id'], appSlug: args.app, buildId: args['build-id'], expected, releaseIds,
    manifestPath: args.manifest, artifactDir: args['artifact-dir'], uploadAsset: directUploadAsset };
  // Default is a read-only plan. An explicit apply is required, and the same
  // expected identity is checked again inside the mutating operation.
  const inventory = await loadHostedArtifacts(options);
  if (inventory.version !== expected.version_name) throw new Error('manifest differs from expected version');
  const build = await api('GET', `/api/apps/${options.appId}/builds/${options.buildId}`);
  for (const [key, value] of Object.entries(expected)) if (build[key] !== value && !(key === 'artifact_mode' && build[key] === 'hands_r2')) throw new Error(`backfill identity differs: ${key}`);
  for (const id of releaseIds) {
    const release = await api('GET', `/api/apps/${options.appId}/releases/${id}`);
    if (release.build_id !== build.id || !['active', 'superseded'].includes(release.status)) throw new Error('release is not a published identity of this build');
  }
  const result = args.mode === 'apply' ? await backfillHosted(options) : {
    status: 'read-only-plan', version: inventory.version, build_id: build.id, release_ids: releaseIds,
    files: inventory.files.map(({ file, sha256, size_bytes }) => ({ file, sha256, size_bytes })),
  };
  await writeFile(args.output, JSON.stringify(result, null, 2) + '\n');
  console.log(`${result.status}: ${result.version}`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runBackfillCommand(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
