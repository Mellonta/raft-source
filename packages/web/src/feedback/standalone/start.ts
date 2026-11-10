import { browserPrivacyMode, initializeBrowserPrivacy } from "@botiverse/raft-shared/src/browserPrivacy";
import { readFeedbackHost } from "./host";

const apiOrigin = readFeedbackHost()?.session.apiOrigin || import.meta.env.VITE_API_URL || location.origin;
void initializeBrowserPrivacy(apiOrigin.replace(/\/$/, "") + "/api").then(() => {
  if (browserPrivacyMode()) {
    document.getElementById("root")!.textContent = "Feedback is disabled in privacy mode.";
    return;
  }
  return import("./main");
}, (error: Error) => {
  document.getElementById("root")!.textContent = error.message;
});
