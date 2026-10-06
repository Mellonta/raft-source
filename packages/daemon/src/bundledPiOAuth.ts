import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

// Despite its SDK name, this is platform-neutral static registration: no Bun
// runtime is used. Pi's default lazy imports deliberately evade bundlers, so a
// Computer SEA cannot resolve them from its nonexistent SDK directory. Register
// the complete SDK flow set for both the Built-in and Pi runtime entry paths.
registerBunOAuthFlows();

/** Offline artifact check: exercise the same lazy OAuth derivation as a stored login. */
export async function verifyBundledPiOAuth(): Promise<void> {
  const oauth = openaiCodexProvider().auth?.oauth;
  if (!oauth) throw new Error("Bundled OpenAI Codex provider has no OAuth flow");
  const access = "raft-bundle-check-not-a-credential";
  const auth = await oauth.toAuth({
    type: "oauth",
    access,
    refresh: "unused",
    expires: Number.MAX_SAFE_INTEGER,
  });
  if (auth.apiKey !== access) throw new Error("Bundled OAuth derivation returned an unexpected result");
}
