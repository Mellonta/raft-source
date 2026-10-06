// Activity-surface telemetry (stdrc #proj-activity:171042a3 2026-06-25:
// "能从数据中分析用户点击 activity 的次数").
//
// The Activity-placement A/B (rail vs sidebar entry point) was REMOVED per
// stdrc 2026-06-30: Activity-on-the-LeftRail is now the unconditional default
// placement. There is no layout-variant `activity-layout` flag any
// more — Activity always lives on the rail (desktop) / under Chat (mobile).
//
// These helpers go through ./track, which sends nothing until RFC-067's
// product-data pipeline exists.
import type { ProductEventProperties } from "@botiverse/raft-shared";
import { trackEvent } from "./track";

/** User opened the Activity surface (from rail or sidebar entry). */
export function trackActivityOpen(from: "rail" | "sidebar"): void {
  trackEvent("activity_open", { from });
}

/** User opened one item from the Activity list. */
export function trackActivityItemOpen(
  itemKind: NonNullable<ProductEventProperties<"activity_item_open">["item_kind"]>,
): void {
  trackEvent("activity_item_open", { item_kind: itemKind });
}

/** User marked an Activity item read / done. */
export function trackActivityMark(action: "read" | "done"): void {
  trackEvent("activity_mark", { action });
}
