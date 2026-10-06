import { useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Archive, ArchiveRestore, GitBranch, Hash, Lock } from "lucide-react";

import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import Banner from "../ui/Banner";
import { Button } from "raft-ui";
import SectionHeader from "../ui/SectionHeader";
import SurfaceListItem from "../ui/SurfaceListItem";
import Tooltip from "../ui/Tooltip";

type ArchivedChannel = Channel & {
  type: "channel" | "private" | "joint";
  archivedAt: string;
};

function isArchivedChannel(channel: Channel): channel is ArchivedChannel {
  return (
    !!channel.archivedAt
    && (channel.type === "channel" || channel.type === "private" || channel.type === "joint")
  );
}

function channelTypeIcon(type: ArchivedChannel["type"]) {
  if (type === "private") return <Lock size={16} />;
  if (type === "joint") return <GitBranch size={16} />;
  return <Hash size={16} />;
}

function channelTypeMessageId(type: ArchivedChannel["type"]) {
  if (type === "private") return "settings.archivedChannels.private" as const;
  if (type === "joint") return "settings.archivedChannels.joint" as const;
  return "settings.archivedChannels.public" as const;
}

function ArchivedChannelsSectionContent() {
  const { formatMessage } = useIntl();
  const { formatMediumDateTime } = useTimeFormatter();
  const nav = useAppNavigate();
  const { capabilities } = useServerPermissions();
  const channels = useChannelStore((state) => state.channels);
  const loading = useChannelStore((state) => state.loading);
  const unarchiveChannel = useChannelStore((state) => state.unarchiveChannel);
  const [busyChannelId, setBusyChannelId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const archivedChannels = useMemo(
    () => channels
      .filter(isArchivedChannel)
      .sort((left, right) => (
        right.archivedAt.localeCompare(left.archivedAt)
        || left.name.localeCompare(right.name)
      )),
    [channels],
  );

  if (!capabilities.archiveChannels || loading || archivedChannels.length === 0) {
    return null;
  }

  const handleUnarchive = async (channel: ArchivedChannel) => {
    setError("");
    setBusyChannelId(channel.id);
    try {
      await unarchiveChannel(channel.id);
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(axiosError.response?.data?.error || formatMessage({ id: "channel.edit.failedUnarchive" }));
    } finally {
      setBusyChannelId(null);
    }
  };

  return (
    <section className="mb-6" data-testid="archived-channels-section">
      <SectionHeader
        className="mb-3"
        icon={<Archive size={16} />}
        label={formatMessage({ id: "settings.archivedChannels.sectionLabel" })}
        count={archivedChannels.length}
      />

      {error ? (
        <Banner
          intent="warning"
          density="sm"
          className="mb-3"
          data-testid="archived-channels-error"
        >
          {error}
        </Banner>
      ) : null}

      <div className="space-y-2">
        {archivedChannels.map((channel) => {
          const busy = busyChannelId === channel.id;
          const typeLabel = formatMessage({ id: channelTypeMessageId(channel.type) });
          const channelName = formatMessage(
            { id: "settings.archivedChannels.channelName" },
            { name: channel.name },
          );
          return (
            <SurfaceListItem
              key={channel.id}
              interactive={false}
              className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`archived-channel-row-${channel.id}`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Tooltip content={typeLabel}>
                <span
                  className="flex size-8 shrink-0 items-center justify-center border border-line-muted bg-fill-muted text-foreground-muted theme-brutal:border-2 theme-brutal:border-black/30 theme-brutal:bg-brutal-stone theme-brutal:text-black/65"
                  aria-label={typeLabel}
                >
                  {channelTypeIcon(channel.type)}
                </span>
                </Tooltip>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="block max-w-full truncate text-left text-sm font-bold text-foreground-strong underline decoration-2 underline-offset-2 hover:text-foreground-muted theme-brutal:text-black theme-brutal:hover:text-black/65"
                    aria-label={formatMessage(
                      { id: "settings.archivedChannels.openAriaLabel" },
                      { name: channel.name },
                    )}
                    onClick={() => nav.toChannel(channel.id)}
                  >
                    {channelName}
                  </button>
                  <div className="mt-0.5 truncate text-xs text-foreground-muted theme-brutal:text-black/55">
                    {formatMessage(
                      { id: "settings.archivedChannels.metadata" },
                      {
                        type: typeLabel,
                        date: formatMediumDateTime(channel.archivedAt),
                      },
                    )}
                  </div>
                </div>
              </div>
              <Button
                size="sm"
                variant="success"
                className="w-full sm:w-auto"
                disabled={busyChannelId !== null}
                aria-label={formatMessage(
                  { id: "settings.archivedChannels.unarchiveAriaLabel" },
                  { name: channel.name },
                )}
                onClick={() => void handleUnarchive(channel)}
              >
                <ArchiveRestore size={14} />
                {busy
                  ? formatMessage({ id: "channel.edit.unarchiving" })
                  : formatMessage({ id: "channel.create.unarchive" })}
              </Button>
            </SurfaceListItem>
          );
        })}
      </div>
    </section>
  );
}

export default function ArchivedChannelsSection() {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  return <ArchivedChannelsSectionContent key={serverId} />;
}
