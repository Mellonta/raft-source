import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";

import { useComposerAutosize } from "../src/components/message/useComposerAutosize";

// Behavior teeth for task #20 (0.1.9 typing-lag report): the per-key path must
// not perform a synchronous measurement — scheduling coalesces bursts into ONE
// rAF measurement — and the field-sizing primary path must do no script work
// at all. jsdom has no layout engine, so these tests pin the SCHEDULING
// semantics (what runs when), not pixel outcomes; the real-frame benefit is
// task #19's fixture measurement.

type Raf = (cb: FrameRequestCallback) => number;
const originalRaf: Raf = globalThis.requestAnimationFrame;
const originalCancel = globalThis.cancelAnimationFrame;

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancel;
});

function installManualRaf() {
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  }) as Raf;
  globalThis.cancelAnimationFrame = (id: number) => { queue.delete(id); };
  return {
    flush() {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const cb of callbacks) cb(performance.now());
    },
    get pending() { return queue.size; },
  };
}

type AutosizeApi = {
  autoResize: () => void;
  scheduleAutoResize: () => void;
  cancelScheduledAutoResize: () => void;
  el: HTMLTextAreaElement | null;
};

function Harness({ fieldSizing, onReady }: {
  fieldSizing: boolean;
  onReady: (api: AutosizeApi) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const api = useComposerAutosize(ref, { fieldSizingSupported: fieldSizing });
  onReady({ ...api, el: ref.current });
  return <textarea ref={ref} data-testid="ta" />;
}

test("fallback path: keystrokes only SCHEDULE the measurement; a burst coalesces to one rAF", () => {
  const raf = installManualRaf();
  let api: AutosizeApi | null = null;
  const view = render(<Harness fieldSizing={false} onReady={(a) => { api = a; }} />);
  const el = view.getByTestId("ta") as HTMLTextAreaElement;

  // Three rapid keystrokes: no synchronous height mutation, exactly one
  // pending frame callback.
  api!.scheduleAutoResize();
  api!.scheduleAutoResize();
  api!.scheduleAutoResize();
  assert.equal(el.style.height, "", "no synchronous height write during the keystroke");
  assert.equal(raf.pending, 1, "burst coalesces to a single scheduled measurement");

  raf.flush();
  assert.notEqual(el.style.height, "", "the coalesced frame callback performs the resize");
  assert.equal(raf.pending, 0);

  // Next keystroke schedules again.
  api!.scheduleAutoResize();
  assert.equal(raf.pending, 1);
});

test("field-sizing path: neither scheduling nor direct resize does any script work", () => {
  const raf = installManualRaf();
  let api: AutosizeApi | null = null;
  const view = render(<Harness fieldSizing onReady={(a) => { api = a; }} />);
  const el = view.getByTestId("ta") as HTMLTextAreaElement;

  api!.scheduleAutoResize();
  api!.autoResize();
  assert.equal(raf.pending, 0, "field-sizing: no frame callbacks are scheduled");
  assert.equal(el.style.height, "", "field-sizing: the hook never touches style.height");
});

test("unmount cancels a pending scheduled measurement", () => {
  const raf = installManualRaf();
  let api: AutosizeApi | null = null;
  const view = render(<Harness fieldSizing={false} onReady={(a) => { api = a; }} />);
  api!.scheduleAutoResize();
  assert.equal(raf.pending, 1);
  view.unmount();
  assert.equal(raf.pending, 0, "pending rAF is cancelled on unmount");
});
