import { privacyModeFromEnv } from "./privacyMode";
import { isRaftVendorUrl } from "./vendorUrl";
export { isRaftVendorUrl } from "./vendorUrl";

/** Read the process setting for stand-alone Raft tools and vendor transports. */
export function privacyModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return privacyModeFromEnv(env);
}

export function assertPrivacyServiceUrl(value: string | URL, env?: Record<string, string | undefined>): void {
  if (privacyModeEnabled(env) && isRaftVendorUrl(new URL(value))) {
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
