import type { ReactNode } from "react";

export default function MobileBottomBarStack({
  showLiveActivity,
  liveActivity,
  tabBar,
  floating = false,
}: {
  showLiveActivity: boolean;
  liveActivity: ReactNode;
  tabBar: ReactNode;
  /**
   * Elegant themes float the mobile bottom bars over the content so the page
   * scrolls behind the tab-bar capsule (task #678). Brutal keeps the bars in
   * normal flow so the activity strip cannot overlap or leave a gap above the
   * tab bar.
   */
  floating?: boolean;
}) {
  const bars = (
    <>
      {showLiveActivity ? (
        <div
          className="pointer-events-auto md:hidden shrink-0"
          data-testid="mobile-live-activity-slot"
        >
          {liveActivity}
        </div>
      ) : null}
      {tabBar}
    </>
  );

  if (!floating) return bars;

  // The overlay column itself never intercepts pointer events; the activity
  // strip and the capsule opt back in individually so the content around them
  // stays tappable.
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col md:hidden"
      data-testid="mobile-bottom-bar-overlay"
    >
      {bars}
    </div>
  );
}
