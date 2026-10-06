import assert from "node:assert/strict";

localStorage.clear();
localStorage.setItem("slock_message_body_font_size", "lg");

const {
  MESSAGE_BODY_FONT_SIZE_STORAGE_KEY,
  getMessageBodyFontSizeStyle,
  seedMessageBodyFontSizeFromProfile,
  useAppearanceStore,
} = await import("../src/store/appearanceStore");

test("message font size preference reads from and persists to the local device", () => {
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "lg");

  useAppearanceStore.getState().setMessageBodyFontSize("sm");

  assert.equal(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY), "sm");
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "sm");
});

test("message font size style is terminal against the RUI theme body recipe", () => {
  assert.deepEqual(getMessageBodyFontSizeStyle("sm"), { fontSize: "0.75rem" });
  assert.deepEqual(getMessageBodyFontSizeStyle("md"), { fontSize: "0.875rem" });
  assert.deepEqual(getMessageBodyFontSizeStyle("lg"), { fontSize: "1rem" });
});

test("invalid local message font size writes normalize back to medium", () => {
  localStorage.clear();

  useAppearanceStore.getState().setMessageBodyFontSize("invalid" as never);

  assert.equal(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY), "md");
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "md");
});

test("legacy profile font size seeds an empty local device preference once", () => {
  localStorage.clear();
  useAppearanceStore.setState({ messageBodyFontSize: "md" });

  seedMessageBodyFontSizeFromProfile("lg");

  assert.equal(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY), "lg");
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "lg");
});

test("legacy profile font size does not overwrite an existing local device preference", () => {
  localStorage.clear();
  useAppearanceStore.getState().setMessageBodyFontSize("sm");

  seedMessageBodyFontSizeFromProfile("lg");

  assert.equal(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY), "sm");
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "sm");
});
