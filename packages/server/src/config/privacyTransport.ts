import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { privacyModeEnabled, rejectVendorDispatch } from "@botiverse/raft-shared/src/privacyMode";

/** All server fetch users, including SDKs using Node's default HTTP dispatcher. */
export function installServerPrivacyTransport(): void {
  if (privacyModeEnabled()) setGlobalDispatcher(getGlobalDispatcher().compose(rejectVendorDispatch));
}
