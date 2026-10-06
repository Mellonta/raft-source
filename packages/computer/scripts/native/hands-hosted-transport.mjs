import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { ensureActiveRelease, transportCauseSuffix } from './publish-hands-release.mjs';

export async function uploadAsset({ api, apiBase = 'https://hands.build', appId, buildId, asset, fetchImpl = fetch, recovery = {} }) {
  const slot = { artifact_kind: asset.artifact_kind, platform: asset.platform, arch: asset.arch, variant: asset.variant, filetype: asset.filetype };
  const idempotency = createHash('sha256').update(JSON.stringify([buildId, slot, asset.sha256, asset.size_bytes])).digest('hex');
  const response = await api('POST', `/api/apps/${appId}/builds/${buildId}/assets/uploads`, {
    ...slot, idempotency_key: idempotency, sha256: asset.sha256, size_bytes: asset.size_bytes,
    filename: asset.file, content_type: 'application/octet-stream', metadata_json: { file_name: asset.file },
  });
  if (response.state === 'ready') return;
  const expectedComplete = `/api/apps/${appId}/builds/${buildId}/assets/${response.asset_id}/upload/complete`;
  const completion = { api, appId, buildId, assetId: response.asset_id, path: expectedComplete, status: response, ...recovery };
  // An earlier completion holds the verification lease: the bytes are
  // already uploaded, so finish that verification instead of uploading again.
  if (response.state === 'verifying' && response.asset_id && response.upload == null) {
    await completeUpload(completion);
    return;
  }
  if (!response.asset_id || response.upload?.method !== 'PUT') throw new Error('Hands did not provide an asset upload capability');
  const url = new URL(response.upload.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid Hands upload capability');
  // The response never authorizes forwarding our API bearer outside /api.
  const complete = new URL(response.complete_url, apiBase);
  if (complete.origin !== new URL(apiBase).origin || complete.pathname !== expectedComplete || complete.search || complete.hash) throw new Error('upload completion escaped its app/build/asset');
  const body = createReadStream(asset.path);
  try {
    let uploaded;
    try {
      uploaded = await fetchImpl(url, {
        method: 'PUT', redirect: 'error', duplex: 'half',
        headers: { ...response.upload.headers, 'content-length': String(asset.size_bytes) },
        body, signal: AbortSignal.timeout(900_000),
      });
    } catch (error) {
      // Host and path only: the upload capability's query string is a signature.
      throw new Error(`Hands direct upload transport failed: ${asset.file} -> ${url.host}${url.pathname}${transportCauseSuffix(error)}`);
    }
    if (!uploaded.ok) throw new Error(`Hands direct upload failed: HTTP ${uploaded.status}`);
    await uploaded.body?.cancel();
  } finally { body.destroy(); }
  await completeUpload({ ...completion, status: {} });
  // Completion's server-side streamed SHA/size check, and a subsequent fresh
  // asset listing, are the proof. A successful PUT alone is never publication.
}

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Completes an uploaded asset, riding out another holder's verification
 * lease (409 ASSET_UPLOAD_BUSY) and a completion that outlives our request
 * timeout. Lease/expiry fields are used when Hands sends them; without them
 * we back off under a total budget and never read a missing field as an
 * expired lease. Never re-uploads. */
export async function completeUpload({ api, appId, buildId, assetId, path, status = {}, budgetMs = 45 * 60_000, now = Date.now, sleep = sleepFor }) {
  const statusPath = `/api/apps/${appId}/builds/${buildId}/assets/${assetId}/upload`;
  let deadline = now() + budgetMs;
  let backoff = 15_000;
  let last = 'none';
  const note = s => { if (Number.isFinite(s?.upload_expires_at)) deadline = Math.min(deadline, s.upload_expires_at); };
  const waitFor = (s, retryAfter) => {
    const lease = Number(s?.verifier_lease_expires_at);
    const hinted = Number(retryAfter) * 1000;
    const ms = Number.isFinite(lease) && lease > now() ? lease - now() + 1_000
      : Number.isFinite(hinted) && hinted > 0 ? hinted
      : backoff;
    backoff = Math.min(backoff * 2, 120_000);
    return Math.max(1_000, ms);
  };
  note(status);
  let wait = status.state === 'verifying' && status.can_retry_complete !== true ? waitFor(status) : 0;
  for (;;) {
    if (wait) {
      if (now() + wait > deadline) throw new Error(`Hands upload completion for asset ${assetId} did not finish before its deadline (last: ${last})`);
      await sleep(wait);
    }
    try {
      await api('POST', path, {});
      return;
    } catch (error) {
      if (error.status === 409 && error.payload?.code === 'ASSET_UPLOAD_BUSY') {
        last = 'ASSET_UPLOAD_BUSY';
        note(error.payload);
        wait = waitFor(error.payload, error.retryAfter);
        continue;
      }
      if (!error.transport) throw error;
      last = error.message;
      // The completion may still finish server-side: read state before retrying.
      let current = null;
      try { current = await api('GET', statusPath); } catch (lookup) { if (lookup.status !== 404 && !lookup.transport) throw lookup; }
      if (current?.state === 'ready') return;
      note(current);
      wait = current?.can_retry_complete === true ? 1_000 : waitFor(current);
    }
  }
}

export async function activateRelease({ api, appId, buildId, channelId, version }) {
  const build = await api('GET', `/api/apps/${appId}/builds/${buildId}`);
  if (build.status !== 'succeeded' || build.artifact_mode !== 'hands_r2' || Number(build.asset_ingest_protocol_version) !== 1) {
    throw new Error('Hands activation requires a succeeded verified-slot protocol build');
  }
  const result = await ensureActiveRelease(api, { appId, buildId, channelId, version, requiredExternalTargets: null });
  return { id: result.releaseId, revision: result.revision };
}
