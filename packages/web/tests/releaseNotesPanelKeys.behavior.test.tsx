import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ReleaseNotesPanel, {
  loadAllReleaseNotes,
  parseReleaseNotesPage,
} from "../src/components/settings/ReleaseNotesPanel";
import type { PublishedReleaseNote } from "../src/components/settings/ReleaseNotesPanel";
import api from "../src/api/client";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";

afterEach(() => cleanup());

function release(overrides: Partial<PublishedReleaseNote> = {}): PublishedReleaseNote {
  return {
    releaseId: "11111111-1111-4111-8111-111111111111",
    releaseKey: "v:1.16.0",
    version: "1.16.0",
    tag: "server-v1.16.0",
    date: "2026-09-15",
    revision: 1,
    snapshotHash: "a".repeat(64),
    publishedAt: "2026-09-15T00:00:00.000Z",
    state: "published",
    entries: [
      {
        entryId: "22222222-2222-4222-8222-222222222222",
        type: "fix",
        text: "Remote release note",
        emphasis: true,
        ordinal: 0,
      },
    ],
    ...overrides,
  };
}

function mountPanel() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <IntlProviderWrapper>
          <ReleaseNotesPanel />
        </IntlProviderWrapper>
      </LocaleProvider>
    </MemoryRouter>,
  );
}

test("loadAllReleaseNotes follows the public cursor until the complete published snapshot is loaded", async () => {
  const cursors: Array<string | null> = [];
  const controller = new AbortController();
  const releases = await loadAllReleaseNotes(controller.signal, async (cursor) => {
    cursors.push(cursor);
    if (cursor === null) {
      return { items: [release()], nextCursor: "page-2" };
    }
    return {
      items: [release({
        releaseId: "33333333-3333-4333-8333-333333333333",
        releaseKey: "d:2026-09-14#1",
        version: null,
        tag: null,
        date: "2026-09-14",
      })],
      nextCursor: null,
    };
  });

  assert.deepEqual(cursors, [null, "page-2"]);
  assert.deepEqual(releases.map((entry) => entry.releaseKey), ["v:1.16.0", "d:2026-09-14#1"]);
});

test("the public response parser fails closed on drafts, unknown item types, and retracted content", () => {
  assert.throws(
    () => parseReleaseNotesPage({ items: [{ ...release(), state: "draft" }], nextCursor: null }),
    /state is invalid/,
  );
  assert.throws(
    () => parseReleaseNotesPage({
      items: [{ ...release(), entries: [{ ...release().entries[0], type: "html" }] }],
      nextCursor: null,
    }),
    /type is invalid/,
  );
  assert.throws(
    () => parseReleaseNotesPage({ items: [{ ...release(), state: "retracted" }], nextCursor: null }),
    /must not expose entries/,
  );
});

test("ReleaseNotesPanel renders API data, uses stable release ids, and skips retractions for Current", async () => {
  const apiClient = api as unknown as { get: (path: string, config: unknown) => Promise<{ data: unknown }> };
  const originalGet = apiClient.get;
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    apiClient.get = async () => ({ data: { items: [release({
        releaseId: "44444444-4444-4444-8444-444444444444",
        releaseKey: "v:1.17.0",
        version: "1.17.0",
        state: "retracted",
        entries: [],
      }),
      release(),
      release({
        releaseId: "55555555-5555-4555-8555-555555555555",
        releaseKey: "d:2026-09-14#1",
        version: null,
        tag: null,
        date: "2026-09-14",
        entries: [{
          entryId: "66666666-6666-4666-8666-666666666666",
          type: "feature",
          text: "<b>plain text only</b>",
          emphasis: false,
          ordinal: 0,
        }],
      })], nextCursor: null } });
    mountPanel();

    await screen.findByText("Remote release note");
    const rendered = screen.getAllByTestId("release-entry");
    assert.equal(rendered.length, 3);
    assert.ok(within(rendered[0]!).getByText("Retracted"));
    assert.ok(within(rendered[1]!).getByText("Current"));
    assert.equal(within(rendered[0]!).queryByText("Current"), null);
    assert.ok(screen.getByText("<b>plain text only</b>"));
    assert.equal(document.querySelector("b"), null, "release-note text must not render as HTML");
  } finally {
    console.error = originalError;
    apiClient.get = originalGet;
  }

  const duplicateKeyErrors = captured.filter((line) => /duplicate key|same key/i.test(line));
  assert.deepEqual(duplicateKeyErrors, []);
});

test("ReleaseNotesPanel shows an explicit unavailable state and retries without a bundle fallback", async () => {
  const apiClient = api as unknown as { get: (path: string, config: unknown) => Promise<{ data: unknown }> };
  const originalGet = apiClient.get;
  let calls = 0;
  apiClient.get = async () => {
    calls += 1;
    if (calls === 1) throw new Error("network down");
    return { data: { items: [release()], nextCursor: null } };
  };
  mountPanel();

  await screen.findByRole("alert");
  assert.match(screen.getByRole("alert").textContent ?? "", /Release notes are unavailable/);
  assert.equal(screen.queryAllByTestId("release-entry").length, 0);

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Remote release note");
  await waitFor(() => assert.equal(calls, 2));
  apiClient.get = originalGet;
});
