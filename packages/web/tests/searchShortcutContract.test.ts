import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "./helpers/domSetup";

import {
  blurFocusedControlForScreenshotShortcut,
  getGlobalSearchShortcutLabel,
  isGlobalSearchShortcut,
  isSystemScreenshotShortcut,
} from "../src/utils/keyboardShortcuts";

const repoRoot = resolve(import.meta.dirname, "..");
const readSource = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

test("global search shortcut uses Command+K on Apple platforms", () => {
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: true, ctrlKey: false }, "MacIntel"), true);
  assert.equal(isGlobalSearchShortcut({ key: "K", metaKey: true, ctrlKey: false }, "MacIntel"), true);
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: false, ctrlKey: true }, "MacIntel"), false);
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: true, ctrlKey: true }, "MacIntel"), false);
});

test("global search shortcut uses Ctrl+K on non-Apple platforms", () => {
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: false, ctrlKey: true }, "Win32"), true);
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: false, ctrlKey: true }, "Linux x86_64"), true);
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: true, ctrlKey: false }, "Win32"), false);
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: true, ctrlKey: true }, "Win32"), false);
});

test("global search shortcut ignores other keys", () => {
  assert.equal(isGlobalSearchShortcut({ key: "j", metaKey: true, ctrlKey: false }, "MacIntel"), false);
  assert.equal(isGlobalSearchShortcut({ key: "j", metaKey: false, ctrlKey: true }, "Win32"), false);
});

test("global search shortcut label matches the active platform shortcut", () => {
  assert.equal(getGlobalSearchShortcutLabel("MacIntel"), "⌘K");
  assert.equal(getGlobalSearchShortcutLabel("iPhone"), "⌘K");
  assert.equal(getGlobalSearchShortcutLabel("Win32"), "Ctrl+K");
  assert.equal(getGlobalSearchShortcutLabel("Linux x86_64"), "Ctrl+K");
});

test("system screenshot shortcut recognizes OS capture chords without hijacking search", () => {
  assert.equal(isSystemScreenshotShortcut({ key: "3", metaKey: true, shiftKey: true }, "MacIntel"), true);
  assert.equal(isSystemScreenshotShortcut({ key: "4", metaKey: true, ctrlKey: true, shiftKey: true }, "MacIntel"), true);
  assert.equal(isSystemScreenshotShortcut({ key: "5", metaKey: true, shiftKey: true }, "MacIntel"), true);
  assert.equal(isSystemScreenshotShortcut({ key: "4", metaKey: true, shiftKey: false }, "MacIntel"), false);
  assert.equal(isSystemScreenshotShortcut({ key: "4", metaKey: true, shiftKey: true, altKey: true }, "MacIntel"), false);
  assert.equal(isSystemScreenshotShortcut({ key: "PrintScreen" }, "Win32"), true);
  assert.equal(isSystemScreenshotShortcut({ key: "4", metaKey: true, shiftKey: true }, "Win32"), false);
  assert.equal(isSystemScreenshotShortcut({ key: "k", metaKey: true }, "MacIntel"), false);
});

test("system screenshot shortcut clears focused button chrome but leaves typing focus alone", () => {
  const button = document.createElement("button");
  const input = document.createElement("input");
  input.type = "text";
  document.body.append(button, input);

  try {
    button.focus();
    assert.equal(document.activeElement, button);
    assert.equal(
      blurFocusedControlForScreenshotShortcut({ key: "4", metaKey: true, shiftKey: true }, document, "MacIntel"),
      true,
    );
    assert.notEqual(document.activeElement, button);

    input.focus();
    assert.equal(document.activeElement, input);
    assert.equal(
      blurFocusedControlForScreenshotShortcut({ key: "4", metaKey: true, shiftKey: true }, document, "MacIntel"),
      false,
    );
    assert.equal(document.activeElement, input);
  } finally {
    button.remove();
    input.remove();
  }
});

test("macOS screenshot modifier prelude clears button chrome before the final capture key", () => {
  const button = document.createElement("button");
  const input = document.createElement("input");
  input.type = "search";
  document.body.append(button, input);

  try {
    button.focus();
    assert.equal(document.activeElement, button);
    assert.equal(
      blurFocusedControlForScreenshotShortcut({ key: "Shift", metaKey: true, shiftKey: true }, document, "MacIntel"),
      true,
    );
    assert.notEqual(document.activeElement, button);

    button.focus();
    assert.equal(
      blurFocusedControlForScreenshotShortcut(
        { key: "Control", metaKey: true, ctrlKey: true, shiftKey: true },
        document,
        "MacIntel",
      ),
      true,
    );
    assert.notEqual(document.activeElement, button);

    button.focus();
    assert.equal(
      blurFocusedControlForScreenshotShortcut(
        { key: "Shift", metaKey: true, shiftKey: true, altKey: true },
        document,
        "MacIntel",
      ),
      false,
    );
    assert.equal(document.activeElement, button);

    button.focus();
    assert.equal(
      blurFocusedControlForScreenshotShortcut({ key: "Shift", metaKey: true, shiftKey: true }, document, "Win32"),
      false,
    );
    assert.equal(document.activeElement, button);

    input.focus();
    assert.equal(
      blurFocusedControlForScreenshotShortcut({ key: "Shift", metaKey: true, shiftKey: true }, document, "MacIntel"),
      false,
    );
    assert.equal(document.activeElement, input);
  } finally {
    button.remove();
    input.remove();
  }
});

test("MainLayout clears focused control chrome from the shared keydown listener", () => {
  const mainLayout = readSource("src/components/layout/MainLayout.tsx");

  assert.match(mainLayout, /blurFocusedControlForScreenshotShortcut,\n\s+isGlobalSearchShortcut,/);
  assert.match(
    mainLayout,
    /const onKeyDown = \(event: KeyboardEvent\) => \{\n\s+blurFocusedControlForScreenshotShortcut\(event\);\n\s+if \(isGlobalSearchShortcut\(event\)\)/,
  );
});
