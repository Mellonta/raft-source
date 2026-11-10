const vendorDomains = ["raft.build", "slock.ai", "botiverse.dev", "hands.build", "slock-server-staging.fly.dev", "botiverse.github.io"];

/** Match vendor-owned services and the upstream release repositories on shared hosting. */
export function isRaftVendorUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (vendorDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) return true;
  const githubApi = host === "api.github.com" || host === "uploads.github.com";
  if (!githubApi && !["github.com", "www.github.com", "raw.githubusercontent.com", "codeload.github.com"].includes(host)) return false;
  // URL.pathname preserves percent escapes. GitHub decodes the owner in a
  // request such as /%62otiverse/repo, including after an HTTP redirect.
  const path = url.pathname.replace(/%([a-f0-9]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return githubApi ? /^\/(?:repos|orgs|users)\/botiverse(?:\/|$)/i.test(path) : /^\/botiverse(?:\/|$)/i.test(path);
}
