/**
 * Frontmatter scalar parsing for SKILL.md metadata (task #275).
 *
 * The previous reader walked the frontmatter line by line, took whatever
 * followed the first `:` on the same line, and ignored continuations. That
 * turns `description: |` into the description `"|"` — the block marker itself
 * presented to the user as the skill's description — and leaves quoted values
 * carrying their own quote characters.
 *
 * This parses the YAML subset that skill frontmatter actually uses, explicitly
 * rather than by importing a YAML engine: the repository has no YAML dependency
 * and a metadata reader is not a good reason to introduce one. The supported
 * subset is stated here so the boundary is a decision rather than an accident:
 *
 *   key: plain scalar            plain, trailing ` #` comment removed
 *   key: "quoted: value"         double-quoted, \" and \\ unescaped
 *   key: 'quoted: value'         single-quoted, '' unescaped to '
 *   key: |                       literal block, newlines preserved
 *   key: |-  |+  |2              literal with chomping / explicit indent
 *   key: >                       folded block, newlines folded to spaces
 *   key: >-  >+                  folded with chomping
 *
 * NOT supported, deliberately: anchors, aliases, tags, flow collections, nested
 * mappings, multi-document streams, directives. Skill frontmatter is a flat
 * string map.
 *
 * Block scalars report YAML truth including chomping, so `|-`, `|` and `|+`
 * differ in their trailing newlines. The presentation trim belongs to the
 * consumer (`parseSkillMd`), not here: trimming at this layer would make the
 * three chomping modes indistinguishable and unassertable.
 *
 * Unsupported syntax FAILS CLOSED to the empty string rather than passing the
 * raw text through, because a wrong description is worse than a missing one --
 * showing a user `&anchor text` or `!!str Tagged` as a skill's description is
 * the same defect as showing them the block marker `|`. This is enforced by
 * `isUnsupportedPlainScalar` and asserted per form in the tests; a boundary
 * that lives only in a comment is decoration, not a boundary.
 */

/** A block scalar header, e.g. `|`, `>-`, `|2+`. */
interface BlockHeader {
  readonly folded: boolean;
  /** `-` strip, `+` keep, otherwise clip (YAML's default). */
  readonly chomp: "strip" | "keep" | "clip";
  /** Explicit indentation indicator, when the header carried a digit. */
  readonly explicitIndent: number | null;
}

function parseBlockHeader(raw: string): BlockHeader | null {
  // YAML's indentation indicator is 1-9; `0` is invalid and must not be read
  // as a block at all (@XX, task #281).
  const match = /^([|>])([1-9]?)([-+]?)\s*(?:#.*)?$/.exec(raw.trim());
  if (!match) return null;
  const [, style, digits, chompChar] = match;
  return {
    folded: style === ">",
    chomp: chompChar === "-" ? "strip" : chompChar === "+" ? "keep" : "clip",
    explicitIndent: digits ? Number(digits) : null,
  };
}

function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Strip a trailing `#` comment from a plain scalar.
 *
 * YAML only starts a comment at a `#` preceded by whitespace, which is why a
 * value like `C#` or `a#b` keeps its hash.
 */
function stripPlainComment(value: string): string {
  const match = /\s#/.exec(value);
  return (match ? value.slice(0, match.index) : value).trim();
}

/**
 * YAML indicator characters that cannot open a plain scalar. Matching here is
 * what makes unsupported syntax fail closed instead of leaking as text.
 *
 * `-`, `?` and `:` indicate only when followed by a space or end of value, so
 * `-5` and `?!` remain ordinary scalars. The rest always indicate in first
 * position -- and only in FIRST position, so a description may still contain
 * them (`Deploy a&b, build [x]`).
 */
const ALWAYS_INDICATOR = new Set([",", "[", "]", "{", "}", "#", "&", "*", "!", "|", ">", "%", "@", "`", "'", '"']);
const SPACE_SENSITIVE_INDICATOR = new Set(["-", "?", ":"]);

function isUnsupportedPlainScalar(value: string): boolean {
  if (value.length === 0) return false;
  const first = value[0];
  if (ALWAYS_INDICATOR.has(first)) return true;
  if (SPACE_SENSITIVE_INDICATOR.has(first)) {
    return value.length === 1 || value[1] === " " || value[1] === "\t";
  }
  return false;
}

/**
 * Read a quoted scalar and whatever follows it.
 *
 * Scans for the closing quote rather than matching the end of the line, so a
 * trailing comment is recognised (`"text" # note`) while a `#` INSIDE the
 * quotes stays part of the value (`"issue #42"`). A value that never closes,
 * or that carries trailing junk which is not a comment, returns `null` and
 * therefore fails closed at the call site.
 */
function unquote(value: string): string | null {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return null;

  let i = 1;
  let inner = "";
  while (i < value.length) {
    const ch = value[i];
    if (quote === '"' && ch === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      inner += next === '"' || next === "\\" ? next : `\\${next}`;
      i += 2;
      continue;
    }
    if (ch === quote) {
      // A doubled single quote is an escaped quote, not the terminator.
      if (quote === "'" && value[i + 1] === "'") {
        inner += "'";
        i += 2;
        continue;
      }
      break;
    }
    inner += ch;
    i += 1;
  }
  if (i >= value.length) return null; // never closed

  const rest = value.slice(i + 1);
  if (rest.trim().length === 0) return inner;
  // YAML requires whitespace before a comment; anything else is malformed.
  if (/^\s+#/.test(rest)) return inner;
  return null;
}

/**
 * Apply YAML block chomping. The three modes differ ONLY in trailing newlines,
 * so the trailing blank lines must still be present when this is called --
 * stripping them earlier is what made `|-`, `|` and `|+` indistinguishable.
 *
 *   strip `-`  no trailing newline
 *   clip  ``   exactly one trailing newline when there is content
 *   keep  `+`  one newline per trailing blank line, plus the content's own
 */
function applyChomp(lines: string[], chomp: BlockHeader["chomp"]): string {
  let lastContent = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].length > 0) {
      lastContent = i;
      break;
    }
  }
  if (lastContent === -1) return chomp === "keep" ? "\n".repeat(lines.length) : "";

  const content = lines.slice(0, lastContent + 1).join("\n");
  if (chomp === "strip") return content;
  if (chomp === "clip") return `${content}\n`;
  return content + "\n".repeat(lines.length - lastContent);
}

/**
 * Fold a block into YAML's folded form.
 *
 *  - a single break between two equally-indented non-empty lines becomes a space
 *  - a run of k blank lines becomes k line breaks
 *  - a MORE-INDENTED line is kept literally, and the breaks around it are kept
 *
 * The blank-line and more-indented rules are what the first implementation got
 * wrong: it collapsed a run of k blanks to k-1 breaks and dropped the break
 * before a more-indented line entirely (@XX, task #281).
 */
function foldLines(lines: string[]): string {
  let out = "";
  let pendingBreaks = 0;
  let started = false;
  let previousWasMoreIndented = false;

  for (const line of lines) {
    if (line.trim().length === 0) {
      pendingBreaks += 1;
      continue;
    }
    const moreIndented = /^[ \t]/.test(line);
    if (!started) {
      // Leading blank lines are content, not padding: `>` followed by a blank
      // line and then text folds to a leading break. Zeroing pendingBreaks here
      // silently dropped it (@XX, task #281).
      out = "\n".repeat(pendingBreaks) + line;
      started = true;
      previousWasMoreIndented = moreIndented;
      pendingBreaks = 0;
      continue;
    }
    // A break adjacent to a more-indented line is preserved rather than folded,
    // and blank lines contribute their own breaks ON TOP of it -- so one blank
    // line before a more-indented paragraph yields two breaks, not one.
    const structural = moreIndented || previousWasMoreIndented ? 1 : 0;
    const breaks = pendingBreaks + structural;
    out += breaks > 0 ? "\n".repeat(breaks) : " ";
    out += line;
    previousWasMoreIndented = moreIndented;
    pendingBreaks = 0;
  }
  return out;
}

/** Fold, then apply the header's chomping to the folded result. */
function fold(lines: string[], chomp: BlockHeader["chomp"]): string {
  let lastContent = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].length > 0) {
      lastContent = i;
      break;
    }
  }
  if (lastContent === -1) return chomp === "keep" ? "\n".repeat(lines.length) : "";
  const folded = foldLines(lines.slice(0, lastContent + 1)).replace(/\n+$/, "");
  if (chomp === "strip") return folded;
  if (chomp === "clip") return `${folded}\n`;
  return folded + "\n".repeat(lines.length - lastContent);
}

/**
 * Parse frontmatter delimited by `---` lines into a flat string map.
 *
 * Returns an empty map when there is no frontmatter block. Keys are trimmed;
 * a duplicate key keeps the last occurrence, matching the line reader this
 * replaces.
 */
export function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};

  const lines = match[1].split(/\r?\n/);
  const result: Record<string, string> = {};

  // Only lines at the frontmatter's OUTERMOST indentation are keys. A nested
  // mapping's children are themselves well-formed `key: value` lines, so a
  // reader that scans every line promotes them to top-level metadata -- which
  // let a nested `user-invocable: true` flip a skill that declared itself
  // false (@XX, task #281). Nesting is unsupported, and "unsupported" has to
  // be enforced on STRUCTURE, not only on a value's syntax.
  // Decided by KEY-BEARING lines only. A comment carries no mapping level, so
  // letting one vote made a root `#` comment above indented metadata erase the
  // whole document (@XX, task #281). Blank lines and comments are presentation,
  // ⛔ not structure -- nothing that cannot hold a key may set the level.
  const isStructural = (line: string): boolean =>
    line.trim().length > 0 && !line.trimStart().startsWith("#") && line.includes(":");
  const baseIndent = lines.reduce(
    (min, line) => (isStructural(line) ? Math.min(min, indentWidth(line)) : min),
    Number.POSITIVE_INFINITY,
  );

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    if (indentWidth(line) > baseIndent) continue; // child of a nested structure

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key.length === 0) continue;
    const rawValue = line.slice(colonIdx + 1).trim();
    const keyIndent = indentWidth(line);

    // NOTE: `key:` with nothing after it needs no special case. Its children are
    // already skipped by the indentation test above, and an empty value falls
    // through to the empty string -- which is the fail-closed answer. An
    // explicit branch here was written first and removed: a red arm showed it
    // could be deleted with no test noticing, i.e. it never decided anything.

    const block = parseBlockHeader(rawValue);
    if (!block) {
      const unquoted = unquote(rawValue);
      if (unquoted !== null) {
        result[key] = unquoted;
      } else if (isUnsupportedPlainScalar(rawValue)) {
        // Includes an unterminated quote and a malformed block header, which
        // reach here precisely because they could not be interpreted.
        result[key] = "";
      } else {
        result[key] = stripPlainComment(rawValue);
      }
      continue;
    }

    // Collect the block body: every following line indented further than the
    // key, with blank lines belonging to the block until a shallower line ends
    // it. Reading the indent from the first non-empty body line is what makes
    // the block marker stop being mistaken for the value.
    const body: string[] = [];
    let bodyIndent = block.explicitIndent === null ? -1 : keyIndent + block.explicitIndent;
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (candidate.trim().length === 0) {
        body.push("");
        continue;
      }
      const width = indentWidth(candidate);
      if (width <= keyIndent) break;
      if (bodyIndent < 0) bodyIndent = width;
      if (width < bodyIndent) break;
      body.push(candidate.slice(bodyIndent));
    }
    i = j - 1;

    // Trailing blank lines are DELIBERATELY kept: they are the only thing that
    // distinguishes strip from clip from keep, and removing them here is what
    // previously collapsed all three modes into one.
    result[key] = block.folded ? fold(body, block.chomp) : applyChomp(body, block.chomp);
  }

  return result;
}
