// Canonical Manual (knowledge) text for agent-facing output (moved verbatim from
// the CLI's commands/knowledge/{get,search}.ts).

export interface AgentKnowledgeSearchResultLike {
  slug: string;
  title: string;
  firstScreen: string;
  /** Why this result matched. Absent on responses from older servers. */
  matchedTerms?: string[];
  correctedTerms?: Array<{ term: string; matched: string }>;
  expandedTerms?: Array<{ from: string; to: string }>;
}

function formatMatchReason(result: AgentKnowledgeSearchResultLike): string {
  const parts: string[] = [];
  for (const { term, matched } of result.correctedTerms ?? []) {
    parts.push(`${term} → ${matched} (typo)`);
  }
  for (const { from, to } of result.expandedTerms ?? []) {
    parts.push(`${from} → ${to} (concept)`);
  }
  return parts.length > 0 ? `   matched: ${parts.join(", ")}` : "";
}

export function formatAgentKnowledgeSearchResults(results: AgentKnowledgeSearchResultLike[]): string {
  return results
    .map((result, index) => {
      const firstScreen = result.firstScreen.trim();
      const body = firstScreen
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => `   ${line}`)
        .join("\n");
      const reason = formatMatchReason(result);
      return `${index + 1}. ${result.slug} — ${result.title}${reason ? `\n${reason}` : ""}${body ? `\n${body}` : ""}`;
    })
    .join("\n\n") + "\n";
}

export function formatAgentKnowledgeStdout(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}
