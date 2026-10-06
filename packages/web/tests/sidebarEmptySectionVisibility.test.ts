import assert from "node:assert/strict";
import {
  defaultHideEmptySidebarSections,
  readHideEmptySidebarSections,
  shouldHideEmptySidebarSection,
  writeHideEmptySidebarSections,
} from "../src/components/layout/sidebarEmptySectionVisibility";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

test("hide-empty-sections defaults to OFF outside the desktop shell", () => {
  // No `window.raftDesktop` in the node test env → web default is OFF.
  assert.equal(defaultHideEmptySidebarSections(), false);
  assert.equal(readHideEmptySidebarSections(memoryStorage()), false);
});

test("an explicit stored choice wins over the platform default", () => {
  const storage = memoryStorage();

  // Even with the desktop default forced ON, a stored "false" is honored.
  writeHideEmptySidebarSections(false, storage);
  assert.equal(readHideEmptySidebarSections(storage, true), false);

  writeHideEmptySidebarSections(true, storage);
  assert.equal(readHideEmptySidebarSections(storage, false), true);
});

test("with no stored value the provided fallback (platform default) is used", () => {
  const storage = memoryStorage();
  assert.equal(readHideEmptySidebarSections(storage, true), true);
  assert.equal(readHideEmptySidebarSections(storage, false), false);
});

test("persistence tolerates unavailable storage", () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error("unavailable");
    },
    setItem: () => {
      throw new Error("unavailable");
    },
  };

  assert.equal(readHideEmptySidebarSections(throwingStorage, true), true);
  assert.doesNotThrow(() => writeHideEmptySidebarSections(true, throwingStorage));
});

test("empty sidebar sections stay hidden unless they are active drag surfaces", () => {
  const base = {
    hideEmptySections: true,
    loading: false,
    itemCount: 0,
  };

  assert.equal(shouldHideEmptySidebarSection(base), true);
  assert.equal(shouldHideEmptySidebarSection({ ...base, itemCount: 1 }), false);
  assert.equal(shouldHideEmptySidebarSection({ ...base, loading: true }), false);
  assert.equal(shouldHideEmptySidebarSection({ ...base, hideEmptySections: false }), false);

  assert.equal(shouldHideEmptySidebarSection({ ...base, dragActive: true }), true);
  assert.equal(shouldHideEmptySidebarSection({
    ...base,
    dragActive: true,
    dragStartedInSection: true,
  }), false);
  assert.equal(shouldHideEmptySidebarSection({
    ...base,
    dragActive: true,
    revealWhileDragging: true,
  }), false);
});
