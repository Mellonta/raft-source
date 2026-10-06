import { appendFileSync } from "node:fs";

// Vitest reporter that records every test case that actually reached a result,
// one JSON line per case, so run-tests-with-manifest.mjs can prove no test was
// silently dropped. The event log path comes from the runner via env.
export default class TestExecutionReporter {
  constructor() {
    this.eventLogPath = process.env.RAFT_CLI_TEST_EVENT_LOG;
    if (!this.eventLogPath) {
      throw new Error("RAFT_CLI_TEST_EVENT_LOG must name the event log file");
    }
  }

  onTestCaseResult(testCase) {
    const state = testCase.result().state;
    appendFileSync(this.eventLogPath, `${JSON.stringify({
      type: state === "failed" ? "test:fail" : "test:pass",
      file: testCase.module.moduleId,
      name: testCase.name,
      skip: state === "skipped" ? true : null,
    })}\n`);
  }
}
