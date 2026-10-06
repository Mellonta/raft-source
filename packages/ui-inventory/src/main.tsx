import React from "react";
import ReactDOM from "react-dom/client";

import "@botiverse/raft-web/src/index.css";
import { LocaleProvider } from "@botiverse/raft-web/src/i18n/LocaleProvider";
import { IntlProviderWrapper } from "@botiverse/raft-web/src/i18n/IntlProviderWrapper";
import App from "./App";

// The inventory mounts real web surfaces, and SelectionPopover (among the
// components it shows) reads react-intl in its body — without these providers
// the whole tree throws at mount. Same deep-import style as the rest of this
// app; LocaleProvider carries its own storage/browser-preference defaults.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider>
      <IntlProviderWrapper>
        <App />
      </IntlProviderWrapper>
    </LocaleProvider>
  </React.StrictMode>
);
