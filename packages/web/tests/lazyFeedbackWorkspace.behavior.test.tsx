// Exercise upstream mechanisms explicitly; mellontaPrivacy.test.ts verifies the shipped policy.
vi.mock("@botiverse/raft-shared/src/distributionPolicy", async (importOriginal) => ({
  ...await importOriginal<typeof import("@botiverse/raft-shared/src/distributionPolicy")>(),
  DISTRIBUTION_POLICY: { forkReleases: false, managedMcp: true, diagnosticUploads: true, tracing: true, productAnalytics: true, upstreamServices: true, externalAvatars: true },
}));

import assert from "node:assert/strict";
import { lazy } from "react";
import type { ComponentType } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { LazyAboutFeedbackPanel } from "../src/components/settings/LazyAboutFeedbackDialog";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

test("a slow first-open loader renders localized pending content inside the settings panel", async () => {
  let resolvePanel!: (value: { default: ComponentType }) => void;
  const DeferredPanel = lazy(() => new Promise((resolve) => {
    resolvePanel = resolve;
  }));

  render(
    <TestIntlProvider>
      <LazyAboutFeedbackPanel panel={DeferredPanel} />
    </TestIntlProvider>,
  );

  const pending = screen.getByRole("status", { name: "Loading feedback…" }).parentElement?.parentElement;
  assert.equal(pending?.getAttribute("aria-busy"), "true");
  assert.ok(screen.getByRole("status", { name: "Loading feedback…" }));
  assert.equal(screen.queryByRole("dialog"), null);

  await act(async () => {
    resolvePanel({
      default: () => <section aria-label="Loaded feedback" />,
    });
  });
  assert.ok(screen.getByRole("region", { name: "Loaded feedback" }));
});
