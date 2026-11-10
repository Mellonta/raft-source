import { initializeBrowserPrivacy, browserPrivacyMode } from "@botiverse/raft-shared/src/browserPrivacy";
import { RUNTIME_API_BASE, RUNTIME_SOCKET_ORIGIN } from "./desktopRuntimeEnvironment";

import onlineFonts from "./assets/fonts/portal-online.css?url";
import offlineFonts from "./assets/fonts/fonts.css?url";

void initializeBrowserPrivacy(RUNTIME_API_BASE, RUNTIME_SOCKET_ORIGIN).then(() => {
  const fonts = document.createElement("link");
  fonts.rel = "stylesheet";
  fonts.href = browserPrivacyMode() ? offlineFonts : onlineFonts;
  document.head.append(fonts);
  return import("./main");
}, (error: Error) => {
  document.getElementById("root")!.textContent = error.message;
});
