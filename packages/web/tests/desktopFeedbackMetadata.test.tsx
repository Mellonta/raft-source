import "./helpers/domSetup";

import assert from "node:assert/strict";

import api from "../src/api/client";
import { desktopFeedbackMetadata, handsFeedbackTransport } from "../src/feedback/handsFeedbackTransport";

// isElectronDesktopShell() reads window.raftDesktop.isDesktop; the metadata also reads
// platform + getAppVersion() off the same bridge. Drive both through window here.
type DesktopWindow = {
  raftDesktop?: {
    isDesktop?: boolean;
    platform?: string;
    getAppVersion?: () => Promise<string>;
  };
};

const originalRaftDesktop = (window as DesktopWindow).raftDesktop;
const originalPost = api.post;
const originalGet = api.get;

afterEach(() => {
  if (originalRaftDesktop === undefined) delete (window as DesktopWindow).raftDesktop;
  else (window as DesktopWindow).raftDesktop = originalRaftDesktop;
  api.post = originalPost;
  api.get = originalGet;
});

function setDesktop(bridge: DesktopWindow["raftDesktop"]) {
  (window as DesktopWindow).raftDesktop = bridge;
}

// ── desktopFeedbackMetadata (unit) ───────────────────────────────────────────

test("no metadata off the desktop shell (web/PWA)", async () => {
  assert.equal(await desktopFeedbackMetadata(), null);
});

test("desktop metadata carries version in client_version + platform in os_version", async () => {
  setDesktop({ isDesktop: true, platform: "darwin", getAppVersion: async () => "0.1.22" });
  assert.deepEqual(await desktopFeedbackMetadata(), {
    client_version: "Raft Desktop 0.1.22",
    os_version: "darwin",
  });
});

test("desktop without getAppVersion still identifies Raft Desktop", async () => {
  setDesktop({ isDesktop: true, platform: "win32" });
  assert.deepEqual(await desktopFeedbackMetadata(), {
    client_version: "Raft Desktop",
    os_version: "win32",
  });
});

test("a throwing getAppVersion degrades to the unversioned identity", async () => {
  setDesktop({
    isDesktop: true,
    platform: "linux",
    getAppVersion: async () => {
      throw new Error("bridge unavailable");
    },
  });
  assert.deepEqual(await desktopFeedbackMetadata(), {
    client_version: "Raft Desktop",
    os_version: "linux",
  });
});

// ── createTicket FormData (real submission path) ─────────────────────────────

function stubTicketReadback() {
  api.get = (async () => ({
    data: {
      ticket: {
        id: "t1", kind: "feedback", status: "open", closure_reason: null,
        duplicate_of_ticket_id: null, message: "the body", created_at: 1, updated_at: 1,
        unread: false, unread_count: 0, attachment_count: 0, comment_count: 0,
      },
      comments: [], attachments: [], next_comment_cursor: null, unread_total: 0,
    },
  })) as typeof api.get;
}

async function submitAndCaptureForm(): Promise<FormData> {
  let captured: FormData | null = null;
  api.post = (async (_url: string, body: FormData) => {
    captured = body;
    return { data: { id: "t1" } };
  }) as typeof api.post;
  stubTicketReadback();
  await handsFeedbackTransport.createTicket({
    kind: "feedback",
    message: "the body",
    submissionId: "11111111-1111-4111-8111-111111111111",
    attachments: [],
    onAttachmentProgress: () => {},
  } as never);
  assert.ok(captured, "api.post must be called");
  return captured as unknown as FormData;
}

test("desktop createTicket attaches a metadata field and leaves the message untouched", async () => {
  setDesktop({ isDesktop: true, platform: "darwin", getAppVersion: async () => "0.1.22" });
  const form = await submitAndCaptureForm();
  assert.equal(form.get("message"), "the body", "user message must not be mutated");
  const metadata = JSON.parse(String(form.get("metadata")));
  assert.equal(metadata.client_version, "Raft Desktop 0.1.22");
  assert.equal(metadata.os_version, "darwin");
});

test("web createTicket sends no metadata field", async () => {
  const form = await submitAndCaptureForm();
  assert.equal(form.get("message"), "the body");
  assert.equal(form.get("metadata"), null, "web must not send a desktop metadata field");
});
