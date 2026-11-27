import "./index.css";
import { browserPrivacyMode, initializeBrowserPrivacy } from "@botiverse/raft-shared/src/browserPrivacy";
import { setPrivacyMode } from "./store/privacyMode";
import { RUNTIME_API_BASE, RUNTIME_SOCKET_ORIGIN } from "./runtimeEndpoints";

void initializeBrowserPrivacy(RUNTIME_API_BASE, RUNTIME_SOCKET_ORIGIN).then(() => {
  if (browserPrivacyMode()) setPrivacyMode(true);
  return import("./main");
}, (error: Error) => {
  document.getElementById("root")!.textContent = error.message;
});
