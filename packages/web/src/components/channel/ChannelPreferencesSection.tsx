import { useIntl } from "react-intl";
import { Switch } from "raft-ui";
import { useServerStore } from "../../store/serverStore";
import {
  hasSidebarPinnedRef,
  removeSidebarPinnedRef,
  upsertSidebarPinnedRef,
} from "../../utils/sidebarPinnedRefs";

/**
 * The per-user conversation preferences — Pin, (panel-only) Activity mute,
 * and the collapse-long-messages switch. Extracted from EditChannelDialog
 * (task #703) so the DM settings sheet renders the SAME preferences block as
 * the channel one: a DM has no name/description form, but pin and display
 * prefs apply to it unchanged (per-DM mute remains a documented non-feature,
 * so the mute row only ever appears when the caller passes `activityMute`).
 *
 * Visual language (v2「重量随风险」, Artea 2026-08-06): high-frequency,
 * zero-risk, fully reversible toggles stay BARE on the paper — hairline
 * dividers, no borders, no shadow.
 */
export interface ChannelPreferencesSectionProps {
  channelId: string;
  /** Mute is a panel-only surface; callers without the capability omit it. */
  isPanel?: boolean;
  activityMute?: {
    muted: boolean;
    busy: boolean;
    onToggle: () => void;
  };
  collapseLongMessages?: {
    enabled: boolean;
    busy: boolean;
    onToggle: () => void;
  };
}

export function ChannelPreferencesSection({
  channelId,
  isPanel = false,
  activityMute,
  collapseLongMessages,
}: ChannelPreferencesSectionProps) {
  const { formatMessage } = useIntl();
  const sidebarOrder = useServerStore((s) => s.sidebarOrder);
  const updateSidebarOrder = useServerStore((s) => s.updateSidebarOrder);
  const pinnedRefs = sidebarOrder.pinned ?? [];
  const channelPinRef = { kind: "channel" as const, id: channelId };
  const isPinned = hasSidebarPinnedRef(pinnedRefs, channelPinRef);
  const handleTogglePin = () => {
    const next = isPinned
      ? removeSidebarPinnedRef(pinnedRefs, channelPinRef)
      : upsertSidebarPinnedRef(pinnedRefs, channelPinRef);
    // Same fire-and-forget contract as the Sidebar context-menu toggle.
    void updateSidebarOrder({ pinned: next });
  };

  return (
    <section className="mt-5" data-testid="channel-settings-preferences">
      <h3 className="text-base font-bold text-foreground-strong">
        {formatMessage({ id: "message.chatPanel.overflow.preferencesGroup" })}
      </h3>
      <div className="mt-2 divide-y divide-black/10">
        <div className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <h4 id="channel-settings-pin-label" className="text-sm font-medium text-foreground-strong">
              {formatMessage({ id: "message.channelSettings.pinTitle" })}
            </h4>
            <p className="mt-1 text-xs font-normal text-foreground-muted">
              {formatMessage({ id: "message.channelSettings.pinDescription" })}
            </p>
          </div>
          <Switch
            size="md"
            checked={isPinned}
            onCheckedChange={handleTogglePin}
            aria-labelledby="channel-settings-pin-label"
            className="shrink-0"
            data-testid="channel-settings-pin-switch"
          />
        </div>
        {isPanel && activityMute && (
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <h4 id="channel-settings-mute-label" className="text-sm font-medium text-foreground-strong">
                {formatMessage({ id: "message.channelSettings.muteActivityTitle" })}
              </h4>
              <p className="mt-1 text-xs font-normal text-foreground-muted">
                {formatMessage({ id: "message.channelSettings.muteActivityDescription" })}
              </p>
            </div>
            <Switch
              size="md"
              checked={activityMute.muted}
              disabled={activityMute.busy}
              onCheckedChange={() => activityMute.onToggle()}
              aria-labelledby="channel-settings-mute-label"
              className="shrink-0"
              data-testid="channel-overflow-mute-switch"
            />
          </div>
        )}
        {collapseLongMessages && (
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <h4 id="channel-settings-collapse-label" className="text-sm font-medium text-foreground-strong">
                {formatMessage({ id: "message.channelSettings.collapseLongMessagesTitle" })}
              </h4>
              <p className="mt-1 text-xs font-normal text-foreground-muted">
                {formatMessage({ id: "message.channelSettings.collapseLongMessagesDescription" })}
              </p>
            </div>
            <Switch
              size="md"
              checked={collapseLongMessages.enabled}
              disabled={collapseLongMessages.busy}
              onCheckedChange={() => collapseLongMessages.onToggle()}
              aria-labelledby="channel-settings-collapse-label"
              className="shrink-0"
              data-testid="channel-settings-collapse-switch"
            />
          </div>
        )}
      </div>
    </section>
  );
}
