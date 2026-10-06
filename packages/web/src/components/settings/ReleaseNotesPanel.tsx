import { useEffect, useMemo, useReducer } from "react";
import { FileText } from "lucide-react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import { useServerStore } from "../../store/serverStore";
import { useMobileBack } from "../../hooks/useAppNavigate";
import type { MessageId } from "../../i18n/messages/en";
import { Badge, Button, Card } from "raft-ui";
import Banner from "../ui/Banner";
import PanelHeader from "../ui/PanelHeader";
import SectionEyebrow from "../ui/SectionEyebrow";

export type ReleaseNoteType = "feature" | "fix" | "improvement" | "breaking" | "deprecated";

export interface ReleaseNoteEntry {
  entryId: string;
  type: ReleaseNoteType;
  text: string;
  emphasis: boolean;
  ordinal: number;
}

export interface PublishedReleaseNote {
  releaseId: string;
  releaseKey: string;
  version: string | null;
  tag: string | null;
  date: string;
  revision: number;
  snapshotHash: string;
  publishedAt: string;
  state: "published" | "retracted";
  entries: ReleaseNoteEntry[];
}

interface ReleaseNotesPage {
  items: PublishedReleaseNote[];
  nextCursor: string | null;
}

export type ReleaseNotesPageLoader = (
  cursor: string | null,
  signal: AbortSignal,
) => Promise<unknown>;

const RELEASE_NOTE_TYPES = new Set<ReleaseNoteType>([
  "feature",
  "fix",
  "improvement",
  "breaking",
  "deprecated",
]);

const RELEASE_TYPE_CONFIG: Record<ReleaseNoteType, { labelId: MessageId; badgeVariant: "information" | "warning" | "success" | "accent" | "muted" }> = {
  feature: { labelId: "settings.releaseNotes.type.new", badgeVariant: "information" },
  fix: { labelId: "settings.releaseNotes.type.fix", badgeVariant: "warning" },
  improvement: { labelId: "settings.releaseNotes.type.improved", badgeVariant: "success" },
  breaking: { labelId: "settings.releaseNotes.type.breaking", badgeVariant: "accent" },
  deprecated: { labelId: "settings.releaseNotes.type.deprecated", badgeVariant: "muted" },
};

const RELEASE_CATEGORY_ORDER: ReleaseNoteType[] = [
  "feature",
  "improvement",
  "fix",
  "breaking",
  "deprecated",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseEntry(value: unknown): ReleaseNoteEntry {
  if (!isRecord(value)) throw new Error("release note entry must be an object");
  const { entryId, type, text, emphasis, ordinal } = value;
  if (!isNonEmptyString(entryId)) throw new Error("release note entryId is invalid");
  if (typeof type !== "string" || !RELEASE_NOTE_TYPES.has(type as ReleaseNoteType)) {
    throw new Error("release note type is invalid");
  }
  if (typeof text !== "string" || text.includes("\0")) throw new Error("release note text is invalid");
  if (typeof emphasis !== "boolean") throw new Error("release note emphasis is invalid");
  if (!Number.isInteger(ordinal) || Number(ordinal) < 0) throw new Error("release note ordinal is invalid");
  return { entryId, type: type as ReleaseNoteType, text, emphasis, ordinal: Number(ordinal) };
}

function parseRelease(value: unknown): PublishedReleaseNote {
  if (!isRecord(value)) throw new Error("release note must be an object");
  const { releaseId, releaseKey, version, tag, date, revision, snapshotHash, publishedAt, state, entries } = value;
  if (!isNonEmptyString(releaseId) || !isNonEmptyString(releaseKey)) throw new Error("release note identity is invalid");
  if (version !== null && typeof version !== "string") throw new Error("release note version is invalid");
  if (tag !== null && typeof tag !== "string") throw new Error("release note tag is invalid");
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("release note date is invalid");
  if (!Number.isInteger(revision) || Number(revision) < 1) throw new Error("release note revision is invalid");
  if (typeof snapshotHash !== "string" || !/^[0-9a-f]{64}$/i.test(snapshotHash)) throw new Error("release note hash is invalid");
  if (!isNonEmptyString(publishedAt)) throw new Error("release note publishedAt is invalid");
  if (state !== "published" && state !== "retracted") throw new Error("release note state is invalid");
  if (!Array.isArray(entries)) throw new Error("release note entries are invalid");
  const parsedEntries = entries.map(parseEntry);
  if (state === "retracted" && parsedEntries.length !== 0) throw new Error("retracted release note must not expose entries");
  return {
    releaseId,
    releaseKey,
    version,
    tag,
    date,
    revision: Number(revision),
    snapshotHash,
    publishedAt,
    state,
    entries: parsedEntries,
  };
}

export function parseReleaseNotesPage(value: unknown): ReleaseNotesPage {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("release notes response is invalid");
  if (value.nextCursor !== null && (typeof value.nextCursor !== "string" || value.nextCursor.length > 256)) {
    throw new Error("release notes cursor is invalid");
  }
  return { items: value.items.map(parseRelease), nextCursor: value.nextCursor as string | null };
}

async function loadReleaseNotesPage(cursor: string | null, signal: AbortSignal): Promise<unknown> {
  const response = await api.get("/release-notes", {
    params: { limit: 100, ...(cursor ? { cursor } : {}) },
    signal,
  });
  return response.data;
}

export async function loadAllReleaseNotes(
  signal: AbortSignal,
  loadPage: ReleaseNotesPageLoader = loadReleaseNotesPage,
): Promise<PublishedReleaseNote[]> {
  const releases: PublishedReleaseNote[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = parseReleaseNotesPage(await loadPage(cursor, signal));
    releases.push(...page.items);
    if (!page.nextCursor) return releases;
    if (seenCursors.has(page.nextCursor)) throw new Error("release notes cursor repeated");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("release notes pagination exceeded its bound");
}

type PanelState = {
  status: "loading" | "ready" | "error";
  releases: PublishedReleaseNote[];
  attempt: number;
};

function panelReducer(state: PanelState, action:
  | { type: "retry" }
  | { type: "ready"; releases: PublishedReleaseNote[] }
  | { type: "error" },
): PanelState {
  if (action.type === "retry") return { status: "loading", releases: [], attempt: state.attempt + 1 };
  if (action.type === "ready") return { ...state, status: "ready", releases: action.releases };
  return { ...state, status: "error", releases: [] };
}

export default function ReleaseNotesPanel() {
  const { formatMessage } = useIntl();
  const serverSlug = useServerStore((s) => s.current?.slug);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}/settings` : "/");
  const [state, dispatch] = useReducer(panelReducer, { status: "loading", releases: [], attempt: 0 });

  useEffect(() => {
    const controller = new AbortController();
    void loadAllReleaseNotes(controller.signal).then(
      (releases) => {
        if (!controller.signal.aborted) dispatch({ type: "ready", releases });
      },
      () => {
        if (!controller.signal.aborted) dispatch({ type: "error" });
      },
    );
    return () => controller.abort();
  }, [state.attempt]);

  const currentReleaseId = useMemo(
    () => state.releases.find((release) => release.state === "published")?.releaseId,
    [state.releases],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={formatMessage({ id: "settings.releaseNotes.title" })}
        icon={<FileText size={18} />}
        iconBg="bg-primary-soft text-foreground-strong theme-brutal:bg-soft-signal theme-brutal:text-black"
        onMobileBack={onMobileBack}
      />

      <div className="flex-1 overflow-y-auto bg-layer-panel px-5 py-4 text-foreground-strong theme-brutal:bg-white theme-brutal:text-black">
        <div className="mb-4 flex items-center gap-2">
          <FileText size={16} className="text-foreground-muted theme-brutal:text-black/60" />
          <SectionEyebrow>{formatMessage({ id: "settings.releaseNotes.whatsNew" })}</SectionEyebrow>
        </div>

        {state.status === "loading" ? (
          <p className="text-sm text-foreground-muted theme-brutal:text-black/60" role="status">
            {formatMessage({ id: "settings.releaseNotes.loading" })}
          </p>
        ) : null}

        {state.status === "error" ? (
          <Banner
            intent="destructive"
            withIcon
            role="alert"
            actions={(
              <Button
                variant="outline"
                size="sm"
                onClick={() => dispatch({ type: "retry" })}
              >
                {formatMessage({ id: "settings.releaseNotes.retry" })}
              </Button>
            )}
          >
            {formatMessage({ id: "settings.releaseNotes.unavailable" })}
          </Banner>
        ) : null}

        {state.status === "ready" ? (
          <div className="space-y-4">
            {state.releases.map((release) => {
              const isCurrentRelease = release.releaseId === currentReleaseId;
              return (
                <Card
                  key={release.releaseId}
                  data-testid="release-entry"
                  className={`p-4 ${isCurrentRelease ? "bg-primary-soft theme-brutal:bg-soft-signal/35" : ""}`}
                >
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <Badge appearance="solid" variant="primary" uppercase={false}>
                      {release.version ? `${release.version} (${release.date})` : release.date}
                    </Badge>
                    {isCurrentRelease ? (
                      <Badge appearance="solid" variant="success" uppercase={false}>
                        {formatMessage({ id: "settings.releaseNotes.current" })}
                      </Badge>
                    ) : null}
                    {release.state === "retracted" ? (
                      <Badge appearance="solid" variant="default" uppercase={false}>
                        {formatMessage({ id: "settings.releaseNotes.retracted" })}
                      </Badge>
                    ) : null}
                  </div>

                  <div className="space-y-3">
                    {RELEASE_CATEGORY_ORDER.map((type) => {
                      const entries = release.entries.filter((entry) => entry.type === type);
                      if (entries.length === 0) return null;
                      const config = RELEASE_TYPE_CONFIG[type];
                      return (
                        <div key={type}>
                          <Badge appearance="soft" variant={config.badgeVariant} uppercase>
                            {formatMessage({ id: config.labelId })}
                          </Badge>
                          <ul className="mt-1.5 list-disc space-y-1.5 pl-5 marker:text-foreground-muted theme-brutal:marker:text-black/70">
                            {entries.map((entry) => (
                              <li key={entry.entryId} className={`text-sm ${entry.emphasis ? "font-bold text-foreground-strong theme-brutal:text-black" : "text-foreground-muted theme-brutal:text-black/80"}`}>
                                {entry.text}
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
