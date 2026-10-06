import assert from "node:assert/strict";
import net from "node:net";
import { errorClassOf, errorCodeOf } from "./index";

// Task #421 — `errorClassOf` returns `err.name`, so every fs failure reads as
// the literal "Error" and every fetch failure as "TypeError". The code gets its
// own bounded attribute; `errorClassOf` keeps its current meaning because
// existing queries and alarms are written against those values.

function fsError(code: string): Error {
  const err = new Error("simulated") as Error & { code?: string };
  err.code = code;
  return err;
}

test("#421 ENOSPC and EACCES share an error_class but get distinct error_codes", () => {
  const noSpace = fsError("ENOSPC");
  const denied = fsError("EACCES");

  assert.equal(errorClassOf(noSpace), "Error");
  assert.equal(errorClassOf(denied), "Error", "the class cannot tell these apart — that is the point");

  assert.equal(errorCodeOf(noSpace), "ENOSPC");
  assert.equal(errorCodeOf(denied), "EACCES");
  assert.notEqual(errorCodeOf(noSpace), errorCodeOf(denied));
});

test("#421 errorClassOf is unchanged", () => {
  assert.equal(errorClassOf(fsError("ENOSPC")), "Error");
  assert.equal(errorClassOf(new TypeError("x")), "TypeError");
  assert.equal(errorClassOf("plain string"), "string");
  const nameless = new Error("x");
  nameless.name = "";
  assert.equal(errorClassOf(nameless), "unknown");
});

test("#421 an error with no code at all reports null, not 'other'", () => {
  assert.equal(errorCodeOf(new Error("no code here")), null);
  assert.equal(errorCodeOf("a string"), null);
  assert.equal(errorCodeOf(null), null);
  assert.equal(errorCodeOf(undefined), null);
});

test("#421 an unrecognised or non-string code folds to 'other'", () => {
  assert.equal(errorCodeOf(fsError("ESOMETHINGNEW")), "other");
  const numeric = new Error("x") as Error & { code?: number };
  numeric.code = 42;
  assert.equal(errorCodeOf(numeric), "other", "a numeric code is not stringified into the attribute");
});

test("#421 the cause chain is walked, but only to a bounded depth", () => {
  const deep = new Error("top", { cause: new Error("l1", { cause: new Error("l2", { cause: fsError("ENOSPC") }) }) });
  assert.equal(errorCodeOf(deep), "ENOSPC", "depth 3 is within the bound");

  const tooDeep = new Error("top", {
    cause: new Error("l1", { cause: new Error("l2", { cause: new Error("l3", { cause: fsError("ENOSPC") }) }) }),
  });
  assert.equal(tooDeep instanceof Error, true);
  assert.notEqual(errorCodeOf(tooDeep), "ENOSPC", "past the bound the code is not reported");
});

// @Tracey measured this: a failed `fetch` is a TypeError with NO top-level
// code; the real code sits on `err.cause`. Reading only `err.code` folded the
// single largest class of upload failures into "other" (20,658 TypeErrors in
// one day). This uses a real fetch against a closed port rather than a
// hand-built shape, so it stays true if undici changes where it puts the code.
test("#421 a real fetch failure reports its code from the cause chain", async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const chosen = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(chosen));
    });
  });

  let caught: unknown;
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    assert.fail("fetch to a closed port must reject");
  } catch (err) {
    caught = err;
  }

  assert.equal(errorClassOf(caught), "TypeError", "the class is the same for every fetch failure");
  assert.equal(
    (caught as { code?: unknown }).code,
    undefined,
    "precondition: fetch puts no code on the top-level error",
  );
  assert.equal(errorCodeOf(caught), "ECONNREFUSED", "the code must be recovered from err.cause");
});
