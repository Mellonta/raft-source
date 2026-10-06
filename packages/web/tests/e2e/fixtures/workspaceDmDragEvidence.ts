import type { Page, Request, Response, TestInfo } from "@playwright/test";

const RESPONSE_BODY_CAPTURE_TIMEOUT_MS = 250;
const responseBodyCaptureTimeout = Symbol("responseBodyCaptureTimeout");

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof responseBodyCaptureTimeout> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof responseBodyCaptureTimeout>((resolve) => {
        timeout = setTimeout(() => resolve(responseBodyCaptureTimeout), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// Observe only this drag and this server's sidebar-order PATCH. Never capture
// headers, auth, unrelated traffic, or DataTransfer contents.
export async function withWorkspaceDmDragEvidence<T>(
  page: Page,
  testInfo: TestInfo,
  serverId: string,
  dmIds: string[],
  action: () => Promise<T>,
  attachmentName = "workspace-dm-drag-evidence",
) {
  const browser = await page.evaluateHandle((ids) => {
    const events: Array<Record<string, unknown>> = [];
    const types = [
      "dragstart", "dragenter", "dragover", "drop", "dragend",
      "pointerdown", "pointermove", "pointerup",
      "mousedown", "mousemove", "mouseup",
    ];
    const listener = (event: Event) => {
      const pointer = event as MouseEvent | DragEvent;
      const row = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-sidebar-channel-id]") : null;
      const id = row?.dataset.sidebarChannelId;
      if (!id || !ids.includes(id) || events.length >= 200) return;
      const rect = row!.getBoundingClientRect();
      events.push({ type: event.type, at: performance.now(), id,
        x: pointer.clientX, y: pointer.clientY, top: rect.top, left: rect.left,
        width: rect.width, height: rect.height, viewportWidth: innerWidth,
        viewportHeight: innerHeight, defaultPrevented: event.defaultPrevented });
    };
    for (const type of types) document.addEventListener(type, listener, true);
    return { events, stop() { for (const type of types) document.removeEventListener(type, listener, true); } };
  }, dmIds);
  const patches: Array<Record<string, unknown>> = [];
  const requests = new Map<Request, Record<string, unknown>>();
  const pending: Promise<void>[] = [];
  const matches = (request: Request) => request.method() === "PATCH"
    && new URL(request.url()).pathname === `/api/servers/${serverId}/sidebar-order`;
  const onRequest = (request: Request) => {
    if (!matches(request)) return;
    const entry: Record<string, unknown> = { at: Date.now(), payload: request.postDataJSON() };
    patches.push(entry);
    requests.set(request, entry);
  };
  const onResponse = (response: Response) => {
    const entry = requests.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    pending.push((async () => {
      const body = await withTimeout(response.json(), RESPONSE_BODY_CAPTURE_TIMEOUT_MS)
        .catch(() => responseBodyCaptureTimeout);
      if (body === responseBodyCaptureTimeout) {
        entry.responseUnavailable = true;
        return;
      }
      entry.response = body;
    })());
  };
  const onFailed = (request: Request) => {
    const entry = requests.get(request);
    if (entry) entry.failure = request.failure()?.errorText ?? "unknown";
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  let result: T | undefined;
  let actionError: unknown;
  let actionSucceeded = false;
  try {
    result = await action();
    actionSucceeded = true;
  } catch (error) {
    actionError = error;
  }
  try {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onFailed);
  } catch {
    // Diagnostic cleanup should not replace the drag/PATCH action result.
  }
  const events = await browser.evaluate(state => { state.stop(); return state.events; }).catch(() => null);
  await browser.dispose().catch(() => undefined);
  await Promise.allSettled(pending);
  await testInfo.attach(attachmentName, {
    body: Buffer.from(JSON.stringify({ retry: testInfo.retry, dmIds, events, patches }, null, 2)),
    contentType: "application/json",
  }).catch(() => undefined);
  if (!actionSucceeded) throw actionError;
  return result as T;
}
