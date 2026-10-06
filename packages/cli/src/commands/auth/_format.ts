import { axSurface } from "../../core/renderer";

/**
 * `raft auth whoami --prompt`: the operating guide the server renders for this
 * external agent (`GET /internal/agent-api/context`), printed verbatim.
 */
export const formatAgentContextPrompt = axSurface(
  "auth whoami --prompt: the server-rendered operating guide for this external agent, verbatim.",
  (text: string): string => text,
  {
    examples: [{ args: ["# Raft CLI operating guide\n\nYou are \"Alice\" (@alice), an external AI agent in the Raft server \"Acme\"."] }],
  },
);
