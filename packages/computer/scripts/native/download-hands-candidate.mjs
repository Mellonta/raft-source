import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { isHandsStorageLocation } from './hands-artifacts.mjs';
import { resolveAppAndChannel, versionCodeFromVersion } from './publish-hands-release.mjs';

/** Promotion reads the already hosted candidate, never rebuilds it or consults
 * a legacy CDN namespace. Each downloaded file is checked before use. */
export async function downloadHandsCandidate({ api, apiBase, appSlug, version, sourceCommit, dir, fetchImpl = fetch }) {
  const { appId, channelId } = await resolveAppAndChannel(api, appSlug, 'alpha');
  const query = new URLSearchParams({ channel: channelId, product_type: 'cli-binary', release_type: 'stable', version_code: String(versionCodeFromVersion(version)) });
  const releases = (await api('GET', `/api/apps/${appId}/releases?${query}`)).releases;
  const matches = (releases ?? []).filter(r => r.version_name === version && ['active', 'superseded'].includes(r.status));
  if (matches.length !== 1) throw new Error('promotion requires one published alpha candidate');
  const release = matches[0];
  const build = await api('GET', `/api/apps/${appId}/builds/${release.build_id}`);
  const provenance = typeof build.provenance_json === 'string' ? JSON.parse(build.provenance_json) : build.provenance_json;
  if (build.artifact_mode !== 'hands_r2' || build.version_name !== version || provenance?.source_commit !== sourceCommit) throw new Error('candidate hosted source identity mismatch');
  const assets = (await api('GET', `/api/apps/${appId}/builds/${build.id}/assets`)).assets;
  if (!Array.isArray(assets) || !assets.length) throw new Error('candidate has no hosted assets');
  await mkdir(dir, { recursive: true });
  const downloaded = new Map();
  for (const asset of assets) {
    const metadata = typeof asset.metadata_json === 'string' ? JSON.parse(asset.metadata_json) : asset.metadata_json;
    const file = metadata?.file_name;
    if (typeof file !== 'string' || !file || ['.', '..'].includes(file) || basename(file) !== file || file.includes('\\')) throw new Error('candidate asset lacks safe original filename');
    if (!asset.r2_key || !/^[a-f0-9]{64}$/.test(asset.file_hash) || !Number.isSafeInteger(Number(asset.size_bytes)) || Number(asset.size_bytes) <= 0) throw new Error('invalid hosted candidate asset identity');
    const identity = `${asset.file_hash}/${asset.size_bytes}`;
    if (downloaded.has(file)) {
      if (downloaded.get(file) !== identity) throw new Error('candidate aliases disagree');
      continue;
    }
    const target = `${asset.platform}-${asset.arch}`;
    if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(target)) throw new Error('invalid candidate target');
    const url = new URL(`/dl/${appSlug}/releases/${release.id}/${target}${asset.variant === 'gzip' ? '.gz' : ''}`, apiBase);
    if (asset.variant && asset.variant !== 'gzip') url.searchParams.set('kind', asset.variant);
    // Hands answers with one signed redirect into its own R2 bucket; that hop
    // is followed, any other target refused. Bytes are checked below.
    const headers = { 'accept-encoding': 'identity' };
    let response = await fetchImpl(url, { redirect: 'manual', headers });
    if (response.status >= 300 && response.status < 400) {
      const location = new URL(response.headers.get('location') ?? '', url);
      await response.body?.cancel();
      if (!isHandsStorageLocation(location)) throw new Error(`candidate download for ${file} redirected outside Hands storage: ${location.host}`);
      response = await fetchImpl(location, { redirect: 'error', headers });
    }
    if (!response.ok || !response.body) throw new Error(`candidate download failed: ${response.status}`);
    let size = 0;
    const hash = createHash('sha256');
    const checker = new Transform({ transform(chunk, _, done) {
      size += chunk.length;
      if (size > Number(asset.size_bytes)) return done(new Error('candidate exceeds frozen size'));
      hash.update(chunk); done(null, chunk);
    } });
    await pipeline(response.body, checker, createWriteStream(join(dir, file), { flags: 'wx' }));
    if (size !== Number(asset.size_bytes) || hash.digest('hex') !== asset.file_hash) throw new Error('candidate bytes differ from frozen identity');
    downloaded.set(file, identity);
  }
  return { manifestPath: join(dir, 'manifest.json'), artifactDir: dir };
}
