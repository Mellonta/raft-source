import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { getOidcJwks, signAgentAccessJwt, signOidcIdToken } from "./oidcService";

const names = ["JWT_SECRET", "RAFT_OIDC_SIGNING_PRIVATE_KEY", "RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS"] as const;
function restore(values: (string | undefined)[]) {
  names.forEach((name, index) => { if (values[index] === undefined) delete process.env[name]; else process.env[name] = values[index]; });
}
function agentToken() {
  return signAgentAccessJwt({ issuer: "https://issuer.test/oidc/demo", agentId: "00000000-0000-4000-8000-000000000001", clientId: "test-rp", serverId: "server", serverSlug: "demo", serverRole: "member", agentName: "Agent", displayName: "Agent", jti: "fixture", now: new Date("2026-10-05T00:00:00Z") });
}
function verifyWithPublishedKey(token: string) {
  const [header, payload, signature] = token.split(".");
  const kid = JSON.parse(Buffer.from(header, "base64url").toString()).kid;
  const key = getOidcJwks().keys.find((candidate) => candidate.kid === kid);
  assert.ok(key);
  assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
}

test("OIDC key rotation prepublishes and retains keys for both Agent JWT and existing ID tokens", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    process.env.JWT_SECRET = "synthetic-old-signing-fixture";
    delete process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
    delete process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS;
    const oldKey = getOidcJwks().keys[0];
    const oldToken = agentToken();
    const idToken = signOidcIdToken({ issuer: "https://issuer.test", expiresInSeconds: 3600, identity: { sub: "human", clientId: "rp", scopes: ["openid"], type: "human", serverId: "server", serverSlug: "demo", serverRole: "member" } });
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = pem;
    const newKey = getOidcJwks().keys[0];
    delete process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
    process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS = JSON.stringify([newKey]);
    assert.deepEqual(getOidcJwks().keys.map((key) => key.kid), [oldKey.kid, newKey.kid]);
    verifyWithPublishedKey(oldToken);
    process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = pem;
    process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS = JSON.stringify([oldKey]);
    const newToken = agentToken();
    verifyWithPublishedKey(newToken);
    verifyWithPublishedKey(oldToken);
    verifyWithPublishedKey(idToken);
    assert.equal(JSON.stringify(getOidcJwks()).includes('"d"'), false);
    assert.equal(JSON.stringify(getOidcJwks()).includes("PRIVATE KEY"), false);
    const claims = JSON.parse(Buffer.from(newToken.split(".")[1], "base64url").toString());
    assert.equal(claims.token_use, "agent_access");
    const idClaims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    assert.equal(idClaims.token_use, undefined, "an ID token cannot pass receiver token_use expectation");
    assert.equal(idClaims.exp - idClaims.iat, 3600);
  } finally { restore(previous); }
});

test("invalid or private publication material fails closed without echoing key data", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    process.env.JWT_SECRET = "synthetic-old-signing-fixture";
    delete process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
    delete process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS;
    const key = getOidcJwks().keys[0];
    for (const value of ["not-json", JSON.stringify([{ ...key, d: "private-bytes" }]), JSON.stringify([{ ...key, kid: "mismatch" }])]) {
      process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS = value;
      assert.throws(agentToken, { message: "Invalid OIDC public key configuration" });
    }
    delete process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS;
    process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = "private-invalid-pem";
    assert.throws(agentToken, { message: "Invalid OIDC signing key configuration" });
  } finally { restore(previous); }
});
