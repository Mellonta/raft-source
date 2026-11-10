import { isRaftVendorUrl } from "./vendorUrl";
export { isRaftVendorUrl } from "./vendorUrl";

/** Process setting for Raft Server and each independent Raft Computer service. */
export function privacyModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  switch (env.RAFT_PRIVACY_MODE?.trim().toLowerCase()) {
    case undefined: case "": case "0": case "false": return false;
    case "1": case "true": return true;
    default: throw new Error("RAFT_PRIVACY_MODE must be 1, true, 0 or false");
  }
}

export function assertPrivacyServiceUrl(value: string | URL): void {
  if (privacyModeEnabled() && isRaftVendorUrl(new URL(value))) {
    throw new Error("RAFT_PRIVACY_MODE disables vendor services. Configure your own server or release source.");
  }
}

/** An Undici interceptor runs for each redirect, before DNS, proxy CONNECT or body writes. */
export function rejectVendorDispatch<Options extends { origin?: string | URL; path: string }, Handler>(
  dispatch: (options: Options, handler: Handler) => boolean,
) {
  return (options: Options, handler: Handler): boolean => {
    // Concatenate the path as HTTP origin-form. A leading "//" is still a path on that origin.
    assertPrivacyServiceUrl(new URL(String(options.origin)).origin + options.path);
    return dispatch(options, handler);
  };
}
