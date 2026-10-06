import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import DialogCard from "../src/components/ui/DialogCard";
import ProgressBar from "../src/components/ui/ProgressBar";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { TestIntlProvider } from "./helpers/intl";

// ui-primitives batch (Task 8): DialogCard close, ProgressBar aria, Spinner aria.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
});

test("catalog pins ui-primitives MessageIds with preserved English meaning", () => {
  assert.equal(en["common.close"], "Close");
  assert.equal(en["ui.progressBar.ariaLabel"], "Progress");
  assert.equal(en["common.loadingLabel"], "Loading");
  assert.match(zh["common.close"], /\p{Script=Han}/u);
  assert.match(zh["ui.progressBar.ariaLabel"], /\p{Script=Han}/u);
  assert.match(zh["common.loadingLabel"], /\p{Script=Han}/u);
  assert.notEqual(zh["ui.progressBar.ariaLabel"], en["ui.progressBar.ariaLabel"]);
});

test("ProgressBar default aria-label uses zh-cn catalog", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <ProgressBar value={40} />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByRole("progressbar", { name: zh["ui.progressBar.ariaLabel"] }));
  assert.equal(screen.queryByRole("progressbar", { name: "Progress" }), null);
});

test("spinner call sites always announce with a localized label", () => {
  // The primitive is RUI's Spinner now (its own default is the English
  // "Loading"); each call site therefore carries either an explicit
  // aria-label from our catalogs or is marked decorative.
  const srcRoot = resolve(import.meta.dirname, "..", "src");
  const files = execSync(
    `grep -rl "<Spinner" ${srcRoot} --include=*.tsx`,
    { encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  assert.ok(files.length > 0);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const tag of src.matchAll(/<Spinner\b[\s\S]{0,320}?\/>/g)) {
      assert.ok(
        /aria-label=|aria-hidden="true"/.test(tag[0]),
        `${file}: every Spinner needs an aria-label or aria-hidden`,
      );
    }
  }
});

test("DialogCard renders and executes its zh-cn close control", () => {
  let closes = 0;
  render(
    <TestIntlProvider locale="zh-cn">
      <DialogCard title="Probe" onClose={() => { closes += 1; }}>
        <p>Body</p>
      </DialogCard>
    </TestIntlProvider>,
  );

  const close = screen.getByRole("button", { name: zh["common.close"] });
  assert.equal(screen.queryByRole("button", { name: "Close" }), null);
  fireEvent.click(close);
  assert.equal(closes, 1);
});
