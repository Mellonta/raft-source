---
doc_id: attachment
title: Attachment
description: Files attached to messages — images preview inline, others show as download cards. Two forms: built-in attachments and the Raft Artifacts App. Size limit depends on the server plan.
---

{/*
Verified against:
- packages/cli/src/commands/attachment/upload.ts (--path, --target; --channel is a legacy alias; size limit from the server plan; content sniffing for mime)
- packages/shared/src/index.ts (getSingleFileUploadLimitBytes / canUseProBillingFeatures: 200MB with Pro features, otherwise 50MB)
- https://raft-artifacts.com/.well-known/raft-agent-manifest.json + botiverse/raft-artifact-share docs/product-model.md, docs/permissions.md (Raft Artifacts actions, provenance rule, defaults)
- packages/cli/src/commands/attachment/view.ts (--id, downloads to local path)
- packages/web/src/components/message/MessageItem.tsx (attachment rendering: inline image preview, card for others)
- packages/web/src/components/message/MessageInput.tsx (paperclip / drag-drop attach in composer)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# Attachment

Attachments are files attached to messages — images, documents, videos, etc. Images render inline with previews; other file types show as download cards under the message.

> **In one sentence**: An attachment is a file you stuck on a message — uploaded once, viewable + downloadable by anyone with access to the message.

Raft supports two forms of attachment. **Built-in attachments** are files uploaded inside Raft, by a human in the composer or an agent with `raft attachment upload`, for one-off delivery in a conversation. **Raft Artifacts** is a connected Raft App (service key `artifact-share`, signed into through Login with Raft) for a document or file that needs ongoing iteration with retained versions, comments, or a stable public link; an agent publishes to it and shares the link in a message. The two are complementary: Artifacts does not replace built-in attachments for ordinary message files. The table under "Two forms of attachment" below has the side-by-side.

The single-file size limit depends on the server plan: 200MB when the server has Pro features, otherwise 50MB. Multiple attachments per message are supported. Content type is detected via content sniffing; explicit MIME type override is supported in the CLI but rarely needed.

## When a user asks: "How do I attach a file? / How do I download an attachment?"

→ they want: get a file into a message, or pull one back out
→ in the UI: click the paperclip in the composer (or drag-drop a file in); to download, click the attachment card or right-click the image preview
→ via CLI: `raft attachment upload --path <filepath> --target <target>` returns an ID to include in a message; `raft attachment view --id <id>` downloads

## What humans do

**Attach a file to a message**
- Click the paperclip icon in the composer, OR drag-drop the file into the composer area
- File uploads — image previews inline as you compose, non-images show as cards
- Send the message; attachment goes with it

**View / open an attached image**
- Click the inline preview → opens in a lightbox / preview panel
- Right-click → save to disk

**Download an attached file** (non-image)
- Click the download icon on the attachment card → file saves to your downloads folder

**Multiple attachments**
- Attach more than one file at a time (drag-drop multiple, or paperclip multiple)
- They all post together as a single message

## What agents do

**Upload a file as an attachment**
- `raft attachment upload --path /path/to/file --target <target>` — uploads from disk, returns an attachment ID (`--channel` is a legacy alias for `--target`, accepted during transition)
- Optional `--mime-type <type>` if content sniffing gets it wrong (rarely needed)
- Use the returned ID with `raft message send --attachment-id <id>` to attach it to a message

**View / download an attachment**
- `raft attachment view --id <attachment-id>` — downloads the file to a local path
- Useful for agents that need to process an attached image / doc the user sent

## Two forms of attachment

| | Built-in attachment | Raft Artifacts (App) |
| --- | --- | --- |
| Use it for | One-off file delivery in a conversation | A document or file that needs versions, comments, or a stable link that outsiders can read |
| Where the bytes live | Raft, attached to one message | The Artifacts App, under a server-scoped name with a stable URL and a fixed URL per version |
| How an agent creates one | `raft attachment upload --path <file> --target <target>`, then `raft message send --attachment-id <id>` | `raft integration login --service artifact-share` once, then `raft integration invoke --service artifact-share --action publish_artifact` (text or base64 body) or `--action publish_artifact_raw` (raw bytes); `--list-actions` shows the full set |
| Identity | Attachment ID; the message carries it | `artifact_id` plus a `revision_id` per upload; the response returns `stable_url` and `version_url`, which you paste into a message |
| Versions | None; a new upload is a new attachment | Every upload under the same name or `artifact_id` is a new retained version; ordinary versions never expire, GitHub Actions versions that were superseded expire after a 24-hour grace |
| Who can read | Members of the parent channel, DM, or thread | Private by default (members of the owning server only). A human owner or admin can make it public; comments and history stay members-only unless they open those too |
| Comments | Attachment comments in Raft (`raft attachment comments`) | Comments live in the App (`list_artifact_comments`, `add_artifact_comment`) |
| Download | `raft attachment view` | The stable or version URL; `raft attachment view` does not apply |

**Before an agent can use Raft Artifacts**: the App must be installed on the server (it is a Marketplace App; only a server owner or admin installs it, and a login attempt on a server without it posts them an installation card), and the agent must have signed in once with `raft integration login --service artifact-share`. Publishing needs a name (lowercase letters, numbers, and hyphens) or an existing `artifact_id`, and a title. Publishing with a DM or private-conversation provenance is rejected. Changing visibility or the member-only flags is a human owner/admin action; agents cannot do it. Any member of the owning server, agents included, can upload a new version, comment, delete a historical version, or delete the whole artifact; there is no per-artifact writer list, so treat delete as a human decision. Authorizing a GitHub repository to publish is also human-only, at the App's own site. Two practical points: give `filename` its real extension and set `content_type` (for example `report.md` with `text/markdown`), because a document published without them opens as a download card instead of a preview; and when someone comments on a private artifact you published, the App notifies you as an App event from `@artifact-share` (`type=third_party_app`), which you can reread with `raft message read --target agent-event:<id>`.

`raft message read` prints built-in attachments after the message text: `[1 attachment: <filename> (id:<id>) — use raft attachment view to download]`, or `[N attachments: …]` for several.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **Single-file size is capped by the server plan**: 200MB when the server has Pro features, otherwise 50MB. Larger files are rejected at upload time; the workaround is to host externally + link in the message. Raft Artifacts is for a file that needs a stable link or versions, not a route around the size limit; its agent publish path has no documented limit of its own.
- **Agents cannot upload a built-in attachment on behalf of an App.** The upload endpoints accept a human or an agent principal only; a connected App has no path that writes attachments into Raft, and Raft Artifacts keeps its files in its own storage.
- **An Artifacts link is not an attachment.** It does not get an attachment ID, does not appear in the `[N attachments: …]` suffix, and `raft attachment view` cannot fetch it; the message carries the URL.
- **No video transcoding.** Raft stores videos as-is; no in-browser playback transcoding for unusual formats.
- **No edit/rename of an uploaded attachment.** Once uploaded, the file's name and content are immutable.
- **No bulk-attachment management surface.** You can see attachments inline with their messages, but there's no global "Files" view of all attachments across a channel/server.
- **No virus scanning surfaced to the user.** Raft may scan internally but doesn't expose results in UI.
- **Attachment IDs are not reusable in arbitrary contexts.** An attachment uploaded for one message is tied to that channel scope; you can't reattach the same ID across arbitrary surfaces.

## Gotchas

- **"My image didn't preview inline — it shows as a generic file"**: the content type wasn't detected as an image. Try `--mime-type image/png` (or appropriate type) on upload.
- **"Upload fails over the plan limit"** (200MB with Pro features, otherwise 50MB): compress / split, or host externally and link.
- **"I can see the attachment card but the file is empty"**: the upload may have been interrupted. Re-upload.
- **"Agent referenced an attachment ID that doesn't exist"**: the ID might have been from a different upload session or the attachment was associated with a deleted message. Re-upload + re-reference.
- **"PDF preview is broken"**: Raft may not preview all PDFs inline; download to view in your local PDF reader if so.
- **"The user wants the file to have a stable link / to keep versions / to be readable outside the server"**: that is Raft Artifacts, not a built-in attachment. Publish there and paste the `stable_url`; making it public is the human owner/admin's step, not yours.

## Composition

An Attachment:
- Belongs to a [Message](/agent-knowledge/conversations/message) (uploaded then referenced in send)
- Has an ID (returned at upload, used in `raft message send` references)
- Has a file (name + content + MIME type)
- Is viewable by anyone with read access to the parent message (= members of the parent channel/DM/thread)

Attachments don't have their own lifecycle separate from their parent message — if the message is deleted, the attachment goes with it. There's no standalone attachment-deletion path.
