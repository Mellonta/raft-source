const URL_CANDIDATE_PATTERN = /https?:\/\/[a-z\d\-._~:/?#@!$&'()*+,;=%\x5b\x5d]+/gi;
const TRAILING_SENTENCE_PUNCTUATION = /[.,!?;:。，！？；：'"“”‘’]+$/u;
const CLOSING_DELIMITERS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
  ["）", "（"],
  ["】", "【"],
  ["》", "《"],
]);

export type ChannelDescriptionSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string };

function countCharacter(value: string, character: string): number {
  let count = 0;
  for (const current of value) {
    if (current === character) count += 1;
  }
  return count;
}

function trimTrailingPunctuation(candidate: string): string {
  let value = candidate.replace(TRAILING_SENTENCE_PUNCTUATION, "");

  while (value) {
    const closing = value.at(-1);
    const opening = closing ? CLOSING_DELIMITERS.get(closing) : undefined;
    if (!closing || !opening) break;
    if (countCharacter(value, closing) <= countCharacter(value, opening)) break;
    value = value.slice(0, -closing.length);
  }

  return value;
}

function isSafeHttpUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && /[a-z\d]/iu.test(parsed.hostname);
  } catch {
    return false;
  }
}

function appendText(segments: ChannelDescriptionSegment[], value: string): void {
  if (!value) return;
  const previous = segments.at(-1);
  if (previous?.kind === "text") {
    previous.value += value;
    return;
  }
  segments.push({ kind: "text", value });
}

export function segmentChannelDescription(description: string): ChannelDescriptionSegment[] {
  const segments: ChannelDescriptionSegment[] = [];
  let cursor = 0;

  for (const match of description.matchAll(URL_CANDIDATE_PATTERN)) {
    const index = match.index;
    const rawCandidate = match[0];
    appendText(segments, description.slice(cursor, index));

    const link = trimTrailingPunctuation(rawCandidate);
    if (link && isSafeHttpUrl(link)) {
      segments.push({ kind: "link", value: link });
      appendText(segments, rawCandidate.slice(link.length));
    } else {
      appendText(segments, rawCandidate);
    }

    cursor = index + rawCandidate.length;
  }

  appendText(segments, description.slice(cursor));
  return segments;
}

export default function ChannelDescription({ description }: { description: string }) {
  return (
    <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere] [@media(max-height:600px)]:line-clamp-1">
      {segmentChannelDescription(description).map((segment, index) => (
        segment.kind === "link" ? (
          <a
            key={`${index}-${segment.value}`}
            href={segment.value}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-1 decoration-black/30 underline-offset-[3px] transition-colors hover:text-black/80 hover:decoration-current focus-visible:bg-primary-soft focus-visible:text-foreground-strong focus-visible:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-line-strong focus-visible:outline-offset-2 theme-brutal:focus-visible:bg-soft-signal theme-brutal:focus-visible:text-black theme-brutal:focus-visible:outline-black"
          >
            {segment.value}
          </a>
        ) : (
          <span key={`${index}-${segment.value}`}>{segment.value}</span>
        )
      ))}
    </span>
  );
}
