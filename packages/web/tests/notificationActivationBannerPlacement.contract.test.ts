import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const messageInputSource = readFileSync(
  new URL("../src/components/message/MessageInput.tsx", import.meta.url),
  "utf8",
);
const chatPanelSource = readFileSync(
  new URL("../src/components/message/ChatPanel.tsx", import.meta.url),
  "utf8",
);

test("mobile activation slot is first in MessageInput and only ChatPanel opts into it", () => {
  assert.match(
    messageInputSource,
    /<div className="flex w-full flex-col gap-2">\s*\{activationBanner\}\s*\{error/,
  );
  assert.match(
    chatPanelSource,
    /activationBanner=\{primaryComposerEligible && isMobileComposer\s*\? <NotificationActivationBanner placement="mobile" \/>/,
  );
  assert.match(
    chatPanelSource,
    /\{primaryComposerEligible && !isMobileComposer \? \(\s*<NotificationActivationBanner placement="desktop" \/>\s*\) : null\}\s*<MessageInput/,
  );

  for (const relativePath of [
    "../src/components/message/ThreadPanel.tsx",
    "../src/components/message/ForwardComposerDialog.tsx",
    "../src/components/message/AttachmentCommentsPanel.tsx",
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /activationBanner=/);
  }
});

test("desktop activation actions center vertically without changing the mobile flow", () => {
  const bannerSource = readFileSync(
    new URL("../src/components/message/NotificationActivationBanner.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    bannerSource,
    /className=\{`\[&>div:last-child\]:self-center \$\{placementClassName\}`\}/,
  );
  assert.doesNotMatch(
    bannerSource,
    /\[&>div:last-child\]:contents/,
  );
});

test("dismiss progress is 4px, three seconds, and static under reduced motion", () => {
  const bannerSource = readFileSync(
    new URL("../src/components/message/NotificationActivationBanner.tsx", import.meta.url),
    "utf8",
  );
  const cssSource = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(bannerSource, /notification-activation-dismiss-timer/);
  assert.match(bannerSource, /onAnimationEnd=\{\(\) => setDismissed\(true\)\}/);
  assert.match(bannerSource, /const result = await enablePushNotifications\(\)|result = await enablePushNotifications\(\)/);
  assert.match(bannerSource, /web_push_native_result/);
  assert.match(bannerSource, /web_push_subscription_saved/);
  assert.match(bannerSource, /web_push_subscription_failed/);
  assert.match(bannerSource, /window\.addEventListener\("focus", handleFocus\)/);
  assert.match(bannerSource, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(bannerSource, /h-1 bg-brutal-black/);
  assert.match(cssSource, /notification-activation-progress 3000ms linear forwards/);
  assert.match(cssSource, /notification-activation-dismiss-timer 3000ms linear forwards/);
  assert.match(
    cssSource,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.notification-activation-progress \{\s*animation: none;\s*width: 100%;/,
  );
});

test("desktop banner keeps symmetric 8px open bands above and below", () => {
  const bannerSource = readFileSync(
    new URL("../src/components/message/NotificationActivationBanner.tsx", import.meta.url),
    "utf8",
  );
  const placement = bannerSource.match(/placement === "desktop" \? "([^"]+)"/)?.[1] ?? "";
  assert.ok(placement, "desktop placement className not found");
  // Top band: an explicit 8px margin under the message surface edge.
  assert.match(placement, /(?:^|\s)mt-2(?:\s|$)/);
  // Bottom band: no extra margin — the banner defers to the composer column's
  // own 8px gap, so both bands ride the same scale step. Carrying spacing in
  // composer padding instead made the rendered gap asymmetric (a measured
  // "22px" bottom hid a visible 8px band behind the form's top border).
  assert.match(placement, /(?:^|\s)mb-0(?:\s|$)/);
});
