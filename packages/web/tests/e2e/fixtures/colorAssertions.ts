import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

type Rgba = [number, number, number, number];

export async function expectCssColor(
  page: Page,
  actual: string | null,
  expected: string,
  /**
   * Per-channel tolerance. Default 0 (exact). Use 1 when the expected color
   * is a hex literal but the actual comes from an oklch design token — the
   * color-space round-trip can drift one channel by 1/255 (e.g. RUI's
   * bg-primary oklch(0.883 0.162 91.89) → [255,212,65] vs #FFD440).
   */
  tolerance = 0,
): Promise<void> {
  expect(actual).not.toBeNull();
  const colors = await page.evaluate(
    ({ actualColor, expectedColor }) => {
      const toRgba = (color: string): Rgba => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Unable to create canvas context for color normalization");
        }
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data) as Rgba;
      };

      return {
        actual: toRgba(actualColor),
        expected: toRgba(expectedColor),
      };
    },
    { actualColor: actual!, expectedColor: expected },
  );

  if (tolerance === 0) {
    expect(colors.actual).toEqual(colors.expected);
    return;
  }
  for (let i = 0; i < 4; i++) {
    expect(
      Math.abs(colors.actual[i] - colors.expected[i]),
      `channel ${i} of ${actual} vs ${expected}`,
    ).toBeLessThanOrEqual(tolerance);
  }
}
