import type { FilePreviewBadgeType } from "raft-ui";

/**
 * Maps an attachment filename onto the semantic file kind RUI's
 * `FilePreviewBadge` colours. Shared by the message attachment card and the
 * Files panel row so both surfaces agree on what a given extension looks like;
 * unknown extensions return null and render no badge.
 */
const FILE_BADGE_TYPES: Record<string, FilePreviewBadgeType> = {
  pdf: "pdf", doc: "doc", docx: "docx", txt: "txt", md: "md", markdown: "md",
  csv: "csv", json: "json", zip: "zip", html: "html",
  png: "png", jpg: "jpg", jpeg: "jpeg", gif: "gif", webp: "webp", svg: "svg",
  mp4: "mp4", mov: "mov",
};

export function attachmentBadgeType(filename: string): FilePreviewBadgeType | null {
  return FILE_BADGE_TYPES[filename.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}
