/**
 * Task #137: a pixel avatar is ONE <img> (cached SVG data URL), not a CSS grid
 * of 64 <div>s. A busy channel carried 134 avatars = 8,710 of 14,827 DOM nodes.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { render } from "@testing-library/react";
import PixelAvatar, { AVATAR_KEYS, DEFAULT_AVATAR_KEY, getPixelAvatarData, pixelAvatarDataUrl } from "../src/components/agent/PixelAvatar";

test("renders exactly one element: an <img> with the SVG data URL, markers and size kept", () => {
  const { container } = render(<PixelAvatar avatarKey={DEFAULT_AVATAR_KEY} size={24} className="rounded-sm" />);
  assert.equal(container.querySelectorAll("*").length, 1, "one node per avatar");
  const img = container.querySelector("img")!;
  assert.equal(img.getAttribute("data-agent-pixel-avatar"), "true");
  assert.equal(img.getAttribute("data-cell-size"), "3");
  assert.equal(img.getAttribute("alt"), "", "decorative, like the old grid");
  assert.equal(img.style.width, "24px");
  assert.ok(img.className.includes("rounded-sm"));
  assert.equal(img.getAttribute("src"), pixelAvatarDataUrl(DEFAULT_AVATAR_KEY));
});

test("the SVG encodes exactly the sprite: background + one 1×1 rect per non-transparent cell", () => {
  for (const key of [DEFAULT_AVATAR_KEY, AVATAR_KEYS[1], "random:seed-a", "random:seed-b"]) {
    const data = getPixelAvatarData(key)!;
    const svg = decodeURIComponent(pixelAvatarDataUrl(key)!.split(",")[1]);
    const filled = data.grid.flat().filter((c) => c !== "_").length;
    assert.equal((svg.match(/<rect x=/g) ?? []).length, filled, key);
    assert.ok(svg.includes(`<rect width="8" height="8" fill="${data.bg}"/>`), key);
  }
});

test("URLs are cached per key and differ between sprites; unknown keys render nothing", () => {
  assert.equal(pixelAvatarDataUrl("random:x"), pixelAvatarDataUrl("random:x"));
  assert.notEqual(pixelAvatarDataUrl("random:x"), pixelAvatarDataUrl("random:y"));
  assert.equal(pixelAvatarDataUrl("no-such-avatar"), null);
  const { container } = render(<PixelAvatar avatarKey="no-such-avatar" />);
  assert.equal(container.innerHTML, "");
});
