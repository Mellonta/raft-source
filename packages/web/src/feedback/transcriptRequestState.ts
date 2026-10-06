// task #1228 ①: what the Report Issue dialog may say about the session-record
// request. The browser only ever learns the HTTP result of its own request
// (the server answers 202 before the agent's computer does anything), so no
// state here means "attached", "uploaded" or "being uploaded".

export type TranscriptRequestState = "pending" | "requested" | "request_failed" | "request_unconfirmed";

/** Measured from the START of the request; the report never waits on it. */
export const TRANSCRIPT_REQUEST_CONFIRM_CAP_MS = 10_000;

function httpStatusOf(err: unknown): number | null {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : null;
}

/**
 * Start the request now and report its state. `pending` immediately; after
 * the cap without an answer, `request_unconfirmed`; a later answer still
 * updates the state. `settled` resolves with the final state and NEVER rejects
 * (a synchronous throw from `send` included), so no unhandled rejection can
 * come from here.
 */
export function startTranscriptRequest(
  send: () => Promise<unknown>,
  onState: (state: TranscriptRequestState) => void,
  capMs: number = TRANSCRIPT_REQUEST_CONFIRM_CAP_MS,
): { settled: Promise<TranscriptRequestState> } {
  onState("pending");
  let answered = false;
  const timer = setTimeout(() => {
    if (!answered) onState("request_unconfirmed");
  }, capMs);
  // `send` runs synchronously so the request starts before anything the
  // caller does next (e.g. filing the ticket); a synchronous throw becomes a
  // rejection like any other failure.
  let sent: Promise<unknown>;
  try {
    sent = Promise.resolve(send());
  } catch (err) {
    sent = Promise.reject(err);
  }
  const settled = sent
    .then(
      (): TranscriptRequestState => "requested",
      // An HTTP status means the server answered non-2xx; no status means the
      // answer never arrived (network, aborted) and the outcome is unknown.
      (err: unknown): TranscriptRequestState => (httpStatusOf(err) !== null ? "request_failed" : "request_unconfirmed"),
    )
    .then((state) => {
      answered = true;
      clearTimeout(timer);
      onState(state);
      return state;
    });
  return { settled };
}
