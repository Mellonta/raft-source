import "./helpers/domSetup";
import assert from "node:assert/strict";
import { resolveScreenshotSurface } from "../src/utils/selectScreenshot";

afterEach(() => { document.body.replaceChildren(); });

test("share captures inherit the visible dark surface through transparent message containers", () => {
  const panel = document.createElement("div");
  panel.style.backgroundColor = "rgb(28, 28, 26)";
  const wrapper = document.createElement("div");
  wrapper.style.backgroundColor = "transparent";
  const row = document.createElement("div");
  row.style.backgroundColor = "rgba(0, 0, 0, 0)";
  row.style.color = "rgb(220, 220, 216)";
  panel.append(wrapper);
  wrapper.append(row);
  document.body.append(panel);
  assert.deepEqual(resolveScreenshotSurface(row), {
    backgroundColor: "rgb(28, 28, 26)", color: "rgb(220, 220, 216)",
  });
  wrapper.style.backgroundColor = "rgba(255, 255, 0, 0.2)";
  panel.style.backgroundColor = "rgb(255, 255, 0)";
  assert.equal(resolveScreenshotSurface(row).backgroundColor, "rgb(255, 255, 0)");
  panel.style.backgroundColor = "rgb(255, 255, 255)";
  row.style.color = "rgb(20, 17, 17)";
  assert.deepEqual(resolveScreenshotSurface(row), {
    backgroundColor: "rgb(255, 255, 255)", color: "rgb(20, 17, 17)",
  });
});
