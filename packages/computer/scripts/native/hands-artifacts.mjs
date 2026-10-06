import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { transportCauseSuffix } from './publish-hands-release.mjs';

export const REQUIRED_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];
export function auditVariant(name) { return `audit-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`; }
export async function digest(stream, maxBytes = Infinity) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > maxBytes) throw new Error('artifact exceeds declared size'); hash.update(chunk); }
  return { sha256: hash.digest('hex'), size_bytes: size };
}
function identityEqual(actual, expected, label) {
  if (actual.sha256 !== expected.sha256 || actual.size_bytes !== expected.size_bytes) {
    throw new Error(`${label}: artifact identity mismatch`);
  }
}
export async function loadHostedArtifacts({ manifestPath, artifactDir }) {
  const dir = resolve(artifactDir);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const names = Object.keys(manifest.targets ?? {}).sort();
  if (JSON.stringify(names) !== JSON.stringify(REQUIRED_TARGETS)) throw new Error('manifest requires exactly five Computer targets');
  if (!manifest.version || !manifest.nodeVersion) throw new Error('manifest version and Node identity required');
  const assets = [];
  const physical = new Map();
  async function file(entry, name) {
    if (!entry || typeof entry.file !== 'string' || basename(entry.file) !== entry.file || entry.file.includes('\\') || !entry.file || entry.file === '.' || entry.file === '..') throw new Error(`${name}: invalid filename`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error(`${name}: invalid identity`);
    const path = join(dir, entry.file);
    const expected = { sha256: entry.sha256, size_bytes: entry.size };
    if (!physical.has(entry.file)) {
      if (!(await stat(path)).isFile()) throw new Error(`${name}: not a file`);
      physical.set(entry.file, { path, file: entry.file, ...await digest(createReadStream(path)) });
    }
    identityEqual(physical.get(entry.file), expected, name);
    return physical.get(entry.file);
  }
  // Signed manifests can reference nested notarization evidence. Preserve and
  // verify those original bytes as well as executable representations.
  async function references(value, label) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'file')) await file(value, label);
    for (const [key, nested] of Object.entries(value)) if (nested && typeof nested === 'object') await references(nested, `${label}.${key}`);
  }
  await references(manifest, 'manifest');
  const wasm = await file(manifest.photonWasm, 'photonWasm');
  for (const target of REQUIRED_TARGETS) {
    const [platform, arch] = target.split('-');
    const entry = manifest.targets[target];
    const raw = await file(entry, target);
    const gzip = await file(entry.gz, `${target}.gz`);
    if (gzip.file !== `${raw.file}.gz`) throw new Error(`${target}: noncanonical gzip filename`);
    const input = createReadStream(gzip.path);
    const decoder = createGunzip();
    input.on('error', error => decoder.destroy(error));
    identityEqual(await digest(input.pipe(decoder)), raw, `${target} decoded gzip`);
    for (const [artifact, variant, filetype] of [[raw, null, 'binary'], [gzip, 'gzip', 'gz'], [wasm, 'photon-wasm', 'wasm']]) {
      assets.push({ ...artifact, target, platform, arch, variant, filetype, artifact_kind: 'installable' });
    }
  }
  // Every remaining final artifact is retained as an audit attachment. This
  // includes signing receipts, hash files and candidate provenance, not only
  // the minimum installable files. No CDN is needed to reconstruct a release.
  for (const name of (await readdir(dir)).sort()) {
    if (physical.has(name) || name === 'hands-publication.json') continue;
    const path = join(dir, name);
    if (!(await stat(path)).isFile()) continue;
    physical.set(name, { path, file: name, ...await digest(createReadStream(path)) });
  }
  if (!physical.has('manifest.json')) throw new Error('artifact directory must contain manifest.json');
  if ((await readFile(join(dir, 'manifest.json'))).compare(await readFile(manifestPath)) !== 0) throw new Error('manifest file differs from artifact directory');
  for (const [name, artifact] of physical) {
    if (assets.some(a => a.file === name)) continue;
    // Use one target consistently; audit assets never participate in selection.
    assets.push({ ...artifact, target: 'linux-x64', platform: 'linux', arch: 'x64', variant: auditVariant(name), filetype: 'other', artifact_kind: 'diagnostic' });
  }
  return { version: manifest.version, nodeVersion: manifest.nodeVersion, manifest, assets, files: [...physical.values()] };
}

export function assertHostedAssetSet(actualRows, expected) {
  if (!Array.isArray(actualRows) || actualRows.length !== expected.length) throw new Error('Hands hosted asset count mismatch');
  const key = row => JSON.stringify([row.artifact_kind, row.platform, row.arch, row.variant ?? null, row.filetype]);
  const indexed = new Map(actualRows.map(row => [key(row), row]));
  if (indexed.size !== actualRows.length) throw new Error('Hands duplicated asset selector');
  for (const wanted of expected) {
    const row = indexed.get(key(wanted));
    if (!row || !row.r2_key || row.external_url) throw new Error(`Hands missing hosted asset ${wanted.file}`);
    if (row.ingest_state !== 'ready' || !row.committed_final_key || row.committed_final_key !== row.r2_key || row.verified_sha256 !== row.file_hash || Number(row.verified_size_bytes) !== Number(row.size_bytes)) throw new Error(`Hands asset not verified ready: ${wanted.file}`);
    identityEqual({ sha256: row.file_hash, size_bytes: Number(row.size_bytes) }, wanted, wanted.file);
  }
}

const HANDS_STORAGE_HOST = /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/;

/** The one redirect target Hands' public /dl answers with: https, its R2
 *  account host, under /hands-artifacts/. Anything else (the former CDN,
 *  plain http) is refused by every reader of public Hands bytes. */
export function isHandsStorageLocation(location) {
  return location.protocol === 'https:' && HANDS_STORAGE_HOST.test(location.hostname) && location.pathname.startsWith('/hands-artifacts/');
}

export async function verifyHostedRelease({ origin, appSlug, releaseId, assets, fetchImpl = fetch, timeoutMs = 300_000, attempts = 2, now = Date.now }) {
  const base = new URL(origin);
  for (const asset of assets) {
    const url = new URL(`/dl/${encodeURIComponent(appSlug)}/releases/${encodeURIComponent(releaseId)}/${asset.target}${asset.variant === 'gzip' ? '.gz' : ''}`, base);
    if (asset.variant && asset.variant !== 'gzip') url.searchParams.set('kind', asset.variant);
    // A stalled storage read is retried from the Hands URL, which mints a
    // fresh signed redirect; identity, size and redirect-target verdicts are
    // final on the first answer.
    for (let attempt = 1; ; attempt++) {
      try {
        identityEqual(await readPublic({ url, asset, fetchImpl, timeoutMs, attempt, attempts, now }), asset, `public ${asset.file}`);
        break;
      } catch (error) {
        if (!error.transport || attempt >= attempts) throw error;
      }
    }
  }
}

async function readPublic({ url, asset, fetchImpl, timeoutMs, attempt, attempts, now }) {
  // One deadline per attempt covers both hops and the body: a stalled
  // response would otherwise hold the job open after activation.
  const signal = AbortSignal.timeout(timeoutMs);
  const started = now();
  let bytes = 0;
  const transport = async (step) => {
    try { return await step(); } catch (error) {
      // Size/identity verdicts are not transport failures; keep them as is.
      if (!signal.aborted && error?.name !== 'TypeError') throw error;
      // Bytes read and elapsed time tell a connection that never started
      // from a body that stopped part-way.
      const progress = `attempt ${attempt}/${attempts}, ${bytes} bytes in ${Math.round((now() - started) / 1000)} s`;
      const failure = new Error(`Hands public readback transport failed for ${asset.file} (${progress})${transportCauseSuffix(error)}`);
      failure.transport = true;
      throw failure;
    }
  };
  // Public bytes must come from Hands, not a redirect to the former CDN.
  // Hands answers with one signed redirect into its own R2 bucket; any
  // other redirect target is refused.
  const headers = { 'accept-encoding': 'identity' };
  let response = await transport(() => fetchImpl(url, { redirect: 'manual', headers, signal }));
  if (response.status >= 300 && response.status < 400) {
    const location = new URL(response.headers.get('location') ?? '', url);
    await response.body?.cancel();
    if (!isHandsStorageLocation(location)) {
      throw new Error(`Hands public readback for ${asset.file} redirected outside Hands storage: ${location.host}`);
    }
    response = await transport(() => fetchImpl(location, { redirect: 'error', headers, signal }));
  }
  if (!response.ok || !response.body) throw new Error(`Hands public readback failed for ${asset.file}: ${response.status}`);
  const counted = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) { bytes += chunk.byteLength; controller.enqueue(chunk); } }));
  return transport(() => digest(counted, asset.size_bytes));
}
