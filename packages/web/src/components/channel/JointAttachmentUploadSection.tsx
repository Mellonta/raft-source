import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, X } from "lucide-react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import {
  cancelAttachmentUploadSession,
  listActiveAttachmentUploads,
} from "../../utils/directAttachmentUpload";
import type { RecoveryView } from "../../utils/directAttachmentUpload";
import Banner from "../ui/Banner";
import { Button } from "raft-ui";
import Tooltip from "../ui/Tooltip";
import {
  notifyAttachmentUploadChanged,
  subscribeAttachmentUploadChanged,
} from "../../store/attachmentUploadEvents";

type JointAttachmentUploadSectionProps = {
  uploads: RecoveryView[];
  cancelBusyId?: string | null;
  onOpenChannel: () => void;
  onCancel: (uploadId: string) => void;
};

export function useActiveAttachmentUploads(
  channelId: string,
  enabled: boolean,
) {
  const [loaded, setLoaded] = useState<{ channelId: string; uploads: RecoveryView[] }>({ channelId, uploads: [] });
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);
  const loadedRef = useRef(loaded);
  const refreshGenerationRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const canceledUploadIdsRef = useRef<Set<string>>(new Set());
  loadedRef.current = loaded;
  const publishUploads = useCallback((uploads: RecoveryView[]) => {
    const next = { channelId, uploads };
    loadedRef.current = next;
    setLoaded(next);
    return uploads;
  }, [channelId]);

  const refreshUploads = useCallback(() => {
    if (!enabled) return;
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    void listActiveAttachmentUploads(api, channelId, controller.signal)
      .then((nextUploads) => {
        if (!controller.signal.aborted && refreshGenerationRef.current === generation) {
          const serverIds = new Set(nextUploads.map((upload) => upload.uploadId));
          for (const uploadId of canceledUploadIdsRef.current) {
            if (!serverIds.has(uploadId)) canceledUploadIdsRef.current.delete(uploadId);
          }
          publishUploads(nextUploads.filter((upload) => !canceledUploadIdsRef.current.has(upload.uploadId)));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && refreshGenerationRef.current === generation) {
          publishUploads([]);
        }
      });
  }, [channelId, enabled, publishUploads]);

  // oxlint-disable-next-line react-doctor/no-cascading-set-state -- async external resource
  useEffect(() => {
    refreshUploads();
    const canceledUploadIds = canceledUploadIdsRef.current;
    return () => {
      refreshGenerationRef.current += 1;
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      canceledUploadIds.clear();
    };
  }, [refreshUploads]);

  useEffect(() => {
    if (!enabled) return;
    return subscribeAttachmentUploadChanged((change) => {
      if (change.channelId !== channelId) return;
      if (change.kind === "canceled") {
        canceledUploadIdsRef.current.add(change.uploadId);
        setLoaded((current) => ({ ...current, uploads: current.uploads.filter((upload) => upload.uploadId !== change.uploadId) }));
        refreshUploads();
      } else {
        refreshUploads();
      }
    });
  }, [channelId, enabled, refreshUploads]);

  const cancelUpload = useCallback(async (uploadId: string): Promise<RecoveryView[]> => {
    setCancelBusyId(uploadId);
    try {
      await cancelAttachmentUploadSession(api, uploadId);
      canceledUploadIdsRef.current.add(uploadId);
      notifyAttachmentUploadChanged({ channelId, uploadId, kind: "canceled" });
      // Remove the canceled row before the follow-up read. The server's
      // lifecycle cleanup is transactional but may be observed a few ms
      // later; the Settings surface must not keep showing a file the user
      // just canceled while that read catches up.
      const optimistic = loadedRef.current.channelId === channelId
        ? loadedRef.current.uploads.filter((upload) => upload.uploadId !== uploadId)
        : [];
      publishUploads(optimistic);
      refreshUploads();
      return optimistic;
    } finally {
      setCancelBusyId((current) => current === uploadId ? null : current);
    }
  }, [channelId, publishUploads, refreshUploads]);

  const uploads = enabled && loaded.channelId === channelId ? loaded.uploads : [];
  return { uploads, cancelBusyId, cancelUpload };
}

/**
 * Recovery surface for uploads that outlive the composer which created them.
 *
 * A direct upload cannot be resumed from Settings because the original File
 * object is intentionally not persisted. Opening the channel hands control
 * back to the owning composer (which may still have the File); cancellation is
 * always available here and is a real server-side delete, not just a UI hide.
 */
export default function JointAttachmentUploadSection({
  uploads,
  cancelBusyId = null,
  onOpenChannel,
  onCancel,
}: JointAttachmentUploadSectionProps) {
  const { formatMessage } = useIntl();

  if (uploads.length === 0) return null;

  return (
    <section
      className="space-y-3 border-b border-line-muted pb-5 theme-brutal:border-black/10"
      data-testid="channel-settings-joint-uploads-section"
    >
      <div>
        <h3 className="text-base font-bold text-foreground-strong theme-brutal:text-black" data-testid="channel-settings-joint-uploads-title">
          {formatMessage({ id: "channel.edit.activeUploadsTitle" })}
        </h3>
        <p className="mt-1 text-xs font-normal text-foreground-muted theme-brutal:text-black/55">
          {formatMessage({ id: "channel.edit.activeUploadsDescription" })}
        </p>
      </div>
      <Banner
        intent="warning"
        density="sm"
        withIcon
        className="min-w-0 font-normal"
        data-testid="channel-settings-joint-uploads-banner"
      >
        <div className="space-y-2">
          <ul className="space-y-2" data-testid="channel-settings-joint-uploads-list">
            {uploads.map((upload) => (
              <li
                key={upload.uploadId}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-line-muted pt-2 first:border-t-0 first:pt-0 theme-brutal:border-black/20"
                data-testid={`channel-settings-joint-upload-${upload.uploadId}`}
              >
                <Tooltip content={upload.filename}>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-bold">
                    <FileUp size={14} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{upload.filename}</span>
                  </span>
                </Tooltip>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onOpenChannel}
                    data-testid={`channel-settings-joint-upload-open-${upload.uploadId}`}
                  >
                    {formatMessage({ id: "channel.edit.continueUpload" })}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onCancel(upload.uploadId)}
                    disabled={cancelBusyId === upload.uploadId}
                    data-testid={`channel-settings-joint-upload-cancel-${upload.uploadId}`}
                  >
                    <X size={14} aria-hidden="true" />
                    {cancelBusyId === upload.uploadId
                      ? formatMessage({ id: "channel.edit.cancelingUpload" })
                      : formatMessage({ id: "channel.edit.cancelUpload" })}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Banner>
    </section>
  );
}
