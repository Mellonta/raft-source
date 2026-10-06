#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";

const STAGING_API_ORIGIN = "https://api-aws-staging.botiverse.dev";
const STAGING_FRONTEND_ORIGIN = "https://raft-app-staging.botiverse.dev";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readQaCredential(path) {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    const [username, password, apiOrigin, frontendOrigin] = text.trimEnd().split("\n");
    if (!username || !password) fail("invalid TestBed QA credential file");
    return {
      username,
      password,
      api_origin: apiOrigin || "https://api-aws-staging.botiverse.dev",
      frontend_origin: frontendOrigin || "https://raft-app-staging.botiverse.dev",
    };
  }
}

async function writeSecretJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function requireStagingOrigin(origin, frontendOrigin) {
  if (origin !== STAGING_API_ORIGIN || frontendOrigin !== STAGING_FRONTEND_ORIGIN) {
    fail("staging origin contract mismatch");
  }
}

async function readStagingSession(path) {
  const session = await readJson(path);
  requireStagingOrigin(session.origin, session.frontendOrigin);
  if (typeof session.accessToken !== "string" || typeof session.refreshToken !== "string") {
    fail("staging session is missing credentials");
  }
  return session;
}

async function responseJson(response) {
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = { error: "non-json response" };
  }
  if (!response.ok) {
    const code = body?.code ?? "HTTP_ERROR";
    const detail = body?.error ?? response.statusText;
    fail(`${response.status} ${code}: ${detail}`);
  }
  return body;
}

function authHeaders(session, serverId) {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    ...(serverId ? { "X-Server-Id": serverId } : {}),
  };
}

const [command, ...args] = process.argv.slice(2);

if (command === "login") {
  const [qaPath, sessionPath] = args;
  if (!qaPath || !sessionPath) fail("usage: staging-api.mjs login QA_FILE SESSION_FILE");
  const qa = await readQaCredential(qaPath);
  const origin = qa.api_origin;
  if (typeof origin !== "string" || typeof qa.username !== "string" || typeof qa.password !== "string") {
    fail("invalid TestBed QA credential file");
  }
  requireStagingOrigin(origin, qa.frontend_origin);
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: qa.username, password: qa.password }),
  });
  const body = await responseJson(response);
  if (typeof body?.accessToken !== "string" || typeof body?.refreshToken !== "string" || typeof body?.user?.id !== "string") {
    fail("login response missing session identity");
  }
  await writeSecretJson(sessionPath, {
    origin,
    frontendOrigin: qa.frontend_origin,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    user: body.user,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, userId: body.user.id })}\n`);
} else if (command === "get") {
  const [sessionPath, path, outPath, serverId] = args;
  if (!sessionPath || !path || !outPath || !path.startsWith("/api/")) {
    fail("usage: staging-api.mjs get SESSION_FILE /api/PATH OUT_FILE [SERVER_ID]");
  }
  const session = await readStagingSession(sessionPath);
  const response = await fetch(`${session.origin}${path}`, {
    headers: authHeaders(session, serverId),
  });
  const body = await responseJson(response);
  await writeSecretJson(outPath, body);
  process.stdout.write(`${JSON.stringify({ ok: true, status: response.status, path })}\n`);
} else if (command === "attach") {
  const [sessionPath, serverSlug, name, outPath] = args;
  if (!sessionPath || !serverSlug || !name || !outPath) {
    fail("usage: staging-api.mjs attach SESSION_FILE SERVER_SLUG NAME OUT_FILE");
  }
  const session = await readStagingSession(sessionPath);
  const response = await fetch(`${session.origin}/api/computer/attach`, {
    method: "POST",
    headers: { ...authHeaders(session), "Content-Type": "application/json" },
    body: JSON.stringify({ serverSlug, name }),
  });
  const body = await responseJson(response);
  if (typeof body?.apiKey !== "string" || !body.apiKey.startsWith("sk_computer_")
    || typeof body?.serverMachineId !== "string" || typeof body?.machineId !== "string"
    || typeof body?.serverId !== "string" || typeof body?.serverSlug !== "string") {
    fail("attach response missing Computer identity");
  }
  if (body.serverSlug !== serverSlug) fail("attach response server slug mismatch");
  await writeSecretJson(outPath, body);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    serverId: body.serverId,
    serverSlug: body.serverSlug,
    serverMachineId: body.serverMachineId,
    machineId: body.machineId,
    resumed: body.resumed,
  })}\n`);
} else if (command === "attachment-payload") {
  const [attachPath, serverUrl, outPath] = args;
  if (!attachPath || !serverUrl || !outPath || !serverUrl.startsWith("https://")) {
    fail("usage: staging-api.mjs attachment-payload ATTACH_FILE SERVER_URL OUT_FILE");
  }
  if (serverUrl !== STAGING_API_ORIGIN) fail("staging origin contract mismatch");
  const attach = await readJson(attachPath);
  if (typeof attach?.apiKey !== "string" || !attach.apiKey.startsWith("sk_computer_")) {
    fail("attach file missing Computer credential");
  }
  await writeSecretJson(outPath, {
    kind: "computer-attachment",
    schemaVersion: 1,
    serverId: attach.serverId,
    serverSlug: attach.serverSlug,
    serverMachineId: attach.serverMachineId,
    machineId: attach.machineId,
    apiKey: attach.apiKey,
    serverUrl,
    attachedAt: new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    serverId: attach.serverId,
    serverMachineId: attach.serverMachineId,
    machineId: attach.machineId,
    apiKeyPrinted: false,
  })}\n`);
} else if (command === "delete-machine") {
  const [sessionPath, attachPath, runReceiptPath] = args;
  if (!sessionPath || !attachPath || !runReceiptPath) {
    fail("usage: staging-api.mjs delete-machine SESSION_FILE ATTACH_FILE RUN_RECEIPT_FILE");
  }
  const session = await readStagingSession(sessionPath);
  const attach = await readJson(attachPath);
  const runReceipt = await readJson(runReceiptPath);
  if (runReceipt?.schema !== "raft.task809.pre-upgrade.v1"
    || attach?.serverId !== runReceipt?.server?.id
    || attach?.serverSlug !== runReceipt?.server?.slug
    || attach?.machineId !== runReceipt?.machine?.id
    || attach?.serverMachineId !== runReceipt?.linkedComputer?.id) {
    fail("delete identity does not match the run attachment and receipt");
  }
  const { serverId, machineId } = attach;
  if (typeof serverId !== "string" || typeof machineId !== "string") {
    fail("run attachment is missing machine identity");
  }
  const response = await fetch(`${session.origin}/api/servers/${serverId}/machines/${machineId}`, {
    method: "DELETE",
    headers: authHeaders(session, serverId),
  });
  await responseJson(response);
  process.stdout.write(`${JSON.stringify({ ok: true, status: response.status })}\n`);
} else if (command === "probe-computer-revoked") {
  const [attachPath] = args;
  if (!attachPath) {
    fail("usage: staging-api.mjs probe-computer-revoked ATTACH_FILE");
  }
  const attach = await readJson(attachPath);
  if (typeof attach?.apiKey !== "string" || !attach.apiKey.startsWith("sk_computer_")
    || typeof attach?.serverId !== "string"
    || typeof attach?.serverMachineId !== "string") {
    fail("attach file missing Computer credential or identity");
  }
  const response = await fetch(`${STAGING_API_ORIGIN}/internal/computer/runners`, {
    headers: {
      Authorization: `Bearer ${attach.apiKey}`,
      "X-Server-Id": attach.serverId,
    },
  });
  const revoked = response.status === 401;
  process.stdout.write(`${JSON.stringify({
    ok: revoked,
    revoked,
    status: response.status,
    serverMachineId: attach.serverMachineId,
  })}\n`);
  if (!revoked) process.exitCode = 1;
} else {
  fail("commands: login | get | attach | attachment-payload | delete-machine | probe-computer-revoked");
}
