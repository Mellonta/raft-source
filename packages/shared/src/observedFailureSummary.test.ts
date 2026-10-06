import assert from "node:assert/strict";
import {
  OBSERVED_FAILURE_MAX_CLASSES,
  OBSERVED_FAILURE_SPANS,
  UNKNOWN_FAILURE_SPAN,
  normalizeTraceInstant,
  parseObservedFailureSummary,
  toObservedFailureSpan,
  type ObservedFailureSummary,
} from "./observedFailureSummary";

const CREDENTIAL = "sk_agent_LIVE_TOKEN_abcdef123456";

/** A summary shaped exactly as the daemon module emits one. */
function moduleOutput(): ObservedFailureSummary {
  return {
    window: {
      requestedFrom: "2026-09-15T12:00:00.000Z",
      requestedTo: "2026-09-15T12:30:00.000Z",
      observedFrom: "2026-09-15T12:01:00.000Z",
      observedTo: "2026-09-15T12:29:00.000Z",
      recordsRead: 120,
      recordsInWindow: 100,
      failureRecords: 3,
      nonFailureRecords: 97,
      excluded: { unparseable: 1, undatable: 2, otherAgent: 17 },
      completeness: "unknown",
    },
    failures: [
      {
        span: "daemon.connection.error",
        count: 2,
        firstAt: "2026-09-15T12:02:00.000Z",
        lastAt: "2026-09-15T12:20:00.000Z",
        attribution: "machine-wide",
      },
      {
        span: "daemon.runtime.process.exit",
        count: 1,
        firstAt: null,
        lastAt: null,
        attribution: "exact",
      },
    ],
  };
}

test("parseObservedFailureSummary: a valid module output survives the hop byte-identically", () => {
  const input = moduleOutput();
  // The acceptance requirement is literally "the stored field equals the
  // module output" -- asserted, not asserted-about.
  assert.deepEqual(parseObservedFailureSummary(structuredClone(input)), input);
  assert.equal(
    JSON.stringify(parseObservedFailureSummary(structuredClone(input))),
    JSON.stringify(input),
  );
});

test("parseObservedFailureSummary: unknown keys are dropped rather than carried through", () => {
  const input = structuredClone(moduleOutput()) as unknown as Record<string, unknown>;
  input.rawTranscriptExcerpt = CREDENTIAL;
  (input.window as Record<string, unknown>).secretNote = CREDENTIAL;
  const parsed = parseObservedFailureSummary(input);
  const serialized = JSON.stringify(parsed);
  assert.ok(!serialized.includes(CREDENTIAL));
  assert.ok(!serialized.includes("rawTranscriptExcerpt"));
  assert.ok(!serialized.includes("secretNote"));
});

test("parseObservedFailureSummary: an unrecognized span name is collapsed, never echoed", () => {
  const input = structuredClone(moduleOutput());
  (input.failures[0] as { span: string }).span = `daemon.connection.error?token=${CREDENTIAL}`;
  const parsed = parseObservedFailureSummary(input);
  assert.equal(parsed.failures[0]?.span, UNKNOWN_FAILURE_SPAN);
  assert.ok(!JSON.stringify(parsed).includes(CREDENTIAL));
  // Collapsing must not lose the failure itself.
  assert.equal(parsed.failures[0]?.count, 2);
});

test("parseObservedFailureSummary: instants are re-serialized rather than copied", () => {
  const input = structuredClone(moduleOutput()) as ObservedFailureSummary;
  (input.window as { requestedFrom: string }).requestedFrom = "2026-09-15T14:00:00+02:00";
  const parsed = parseObservedFailureSummary(input);
  assert.equal(parsed.window.requestedFrom, "2026-09-15T12:00:00.000Z");
  assert.ok(!JSON.stringify(parsed).includes("+02:00"));
});

test("parseObservedFailureSummary: completeness may only be the literal unknown", () => {
  for (const bad of [true, false, "known", "partial", null, undefined]) {
    const input = structuredClone(moduleOutput()) as unknown as Record<string, unknown>;
    (input.window as Record<string, unknown>).completeness = bad;
    assert.throws(() => parseObservedFailureSummary(input), /completeness/);
  }
});

test("parseObservedFailureSummary: malformed summaries are rejected", () => {
  assert.throws(() => parseObservedFailureSummary(null), /JSON object/);
  assert.throws(() => parseObservedFailureSummary("a string"), /JSON object/);
  assert.throws(() => parseObservedFailureSummary([]), /JSON object/);
  assert.throws(() => parseObservedFailureSummary({}), /window/);

  const noFailures = structuredClone(moduleOutput()) as unknown as Record<string, unknown>;
  delete noFailures.failures;
  assert.throws(() => parseObservedFailureSummary(noFailures), /failures must be an array/);

  const badCount = structuredClone(moduleOutput()) as unknown as Record<string, unknown>;
  (badCount.window as Record<string, unknown>).recordsRead = -1;
  assert.throws(() => parseObservedFailureSummary(badCount), /recordsRead/);

  const fractional = structuredClone(moduleOutput()) as unknown as Record<string, unknown>;
  (fractional.window as Record<string, unknown>).failureRecords = 1.5;
  assert.throws(() => parseObservedFailureSummary(fractional), /failureRecords/);

  const badAttribution = structuredClone(moduleOutput());
  (badAttribution.failures[0] as { attribution: string }).attribution = "probably-mine";
  assert.throws(() => parseObservedFailureSummary(badAttribution), /attribution is invalid/);

  const badInstant = structuredClone(moduleOutput());
  (badInstant.window as { requestedFrom: string }).requestedFrom = CREDENTIAL;
  assert.throws(() => parseObservedFailureSummary(badInstant), /requestedFrom/);

  const missingExcluded = structuredClone(moduleOutput()) as unknown as Record<string, unknown>;
  delete (missingExcluded.window as Record<string, unknown>).excluded;
  assert.throws(() => parseObservedFailureSummary(missingExcluded), /excluded/);
});

test("parseObservedFailureSummary: an unbounded class list is refused", () => {
  const input = structuredClone(moduleOutput()) as unknown as { failures: unknown[] };
  input.failures = Array.from({ length: OBSERVED_FAILURE_MAX_CLASSES + 1 }, () => ({
    span: "daemon.connection.error",
    count: 1,
    firstAt: null,
    lastAt: null,
    attribution: "machine-wide",
  }));
  assert.throws(() => parseObservedFailureSummary(input), /maximum class count/);
});

test("parseObservedFailureSummary: an empty failure list with a window is valid and stays empty", () => {
  const input = structuredClone(moduleOutput()) as ObservedFailureSummary;
  const empty = parseObservedFailureSummary({
    ...input,
    window: { ...input.window, observedFrom: null, observedTo: null },
    failures: [],
  });
  assert.deepEqual(empty.failures, []);
  assert.equal(empty.window.requestedFrom, "2026-09-15T12:00:00.000Z");
  assert.equal(empty.window.observedFrom, null);
  assert.equal(empty.window.completeness, "unknown");
  // Nothing in the contract may express "no failures occurred".
  assert.ok(!JSON.stringify(empty).includes("noFailures"));
});

test("boundary converters: every vocabulary member passes through unchanged", () => {
  for (const span of OBSERVED_FAILURE_SPANS) {
    assert.equal(toObservedFailureSpan(span), span);
  }
});

test("boundary converters: unknown and non-string span names collapse", () => {
  for (const value of [`x${CREDENTIAL}`, "", null, undefined, 42, {}, []]) {
    assert.equal(toObservedFailureSpan(value), UNKNOWN_FAILURE_SPAN);
  }
});

test("boundary converters: valid instants normalize, invalid ones become null", () => {
  assert.equal(normalizeTraceInstant("2026-09-15T12:14:06.000Z"), "2026-09-15T12:14:06.000Z");
  assert.equal(normalizeTraceInstant("2026-09-15T12:14:06+02:00"), "2026-09-15T10:14:06.000Z");
  for (const value of ["not-a-time", CREDENTIAL, "", null, undefined, NaN, Infinity, {}, []]) {
    assert.equal(normalizeTraceInstant(value), null);
  }
});
