type AttachmentUploadChangeHandler = (change: AttachmentUploadChange) => void;

export type AttachmentUploadChange = Readonly<{
  channelId: string;
  uploadId: string;
  kind: "canceled" | "completed";
}>;

const attachmentUploadEvents = new EventTarget();
const ATTACHMENT_UPLOAD_CHANGED = "attachment-upload-changed";

/**
 * Upload sessions are shared by Settings and the channel composer. Keep the
 * invalidation primitive separate from either surface so a successful server
 * mutation can invalidate every mounted consumer, including a composer that
 * was mounted before Settings opened.
 */
export function notifyAttachmentUploadChanged(change: AttachmentUploadChange): void {
  attachmentUploadEvents.dispatchEvent(
    new CustomEvent<AttachmentUploadChange>(ATTACHMENT_UPLOAD_CHANGED, { detail: change }),
  );
}

export function subscribeAttachmentUploadChanged(handler: AttachmentUploadChangeHandler): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Partial<AttachmentUploadChange>>).detail;
    if (
      typeof detail?.channelId === "string"
      && typeof detail.uploadId === "string"
      && (detail.kind === "canceled" || detail.kind === "completed")
    ) {
      handler(detail as AttachmentUploadChange);
    }
  };
  attachmentUploadEvents.addEventListener(ATTACHMENT_UPLOAD_CHANGED, listener);
  return () => attachmentUploadEvents.removeEventListener(ATTACHMENT_UPLOAD_CHANGED, listener);
}
