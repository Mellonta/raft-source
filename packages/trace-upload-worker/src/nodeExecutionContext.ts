import type { ExecutionContextLike } from "./env";

// Node has no platform ExecutionContext. This one observes every background
// promise: a rejection is logged and counted on a stable line instead of
// becoming an unhandledRejection that kills the process (task #426).
export function createNodeExecutionContext(): ExecutionContextLike {
  return {
    waitUntil(promise: Promise<unknown>): void {
      Promise.resolve(promise).catch((error: unknown) => {
        console.error("[TraceUploadWorker] background_task_failed", {
          error_class: error instanceof Error ? error.name : "Error",
          error_message: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}

// Backstop only: with all background promises observed via
// createNodeExecutionContext, any unhandledRejection is from an unknown,
// non-background path — log + count it (WITH the message, so CloudWatch can
// still attribute an escaping R2 PUT failure; the R2 error message
// "R2 PUT failed with status N" carries no secrets), then keep Node's fatal
// default so a real state error is never swallowed.
export function installUnhandledRejectionGuard(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[TraceUploadWorker] unhandled_rejection", {
      error_class: reason instanceof Error ? reason.name : "Error",
      error_message: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });
}
