# Raft SDK architecture

`@botiverse/raft-sdk` is the publishable distribution layer for Raft's Agent API. It is not the monorepo's source-level implementation package.

## Source and distribution boundary

- Reusable Agent API behavior belongs in `@botiverse/raft-shared`, where the CLI, Server tests, and other workspace consumers can execute it directly from source.
- The SDK exposes the stable public API, adapts it where necessary, and bundles the shared implementation into its ESM, CommonJS, and declaration artifacts.
- Workspace packages must not import the SDK as a source-code shortcut. Its package exports intentionally point at `dist/`, so doing so creates an undeclared “build the SDK first” prerequisite on a clean checkout.
- The published SDK must not retain a runtime dependency or import on the private shared package. Artifact checks enforce that the shared implementation is bundled.

When adding or changing a public SDK operation, implement the reusable operation in shared, keep the SDK wrapper thin, and test both the source consumer and the packed SDK artifact.

This document is an internal monorepo design note. It is intentionally excluded from the npm package; only the built distribution and npm-required metadata/readme are published.

## SDK 1.0 layering (in progress)

The full design, its decisions, and the delivery phases are in
`docs/sdk-1.0-design.md`. In short: four layers with one source of truth each,
all living in `@botiverse/raft-shared`, with the CLI and the SDK as thin
projections of them.

- **L1 routes** (`src/routes.ts`, shipped in 0.3.0): one typed method per
  contract route plus the operating metadata every projection shares
  (`sideEffect`, `idempotency`, `audience`; see
  `packages/shared/src/agentApiRouteMeta.ts`). The language-neutral
  description `packages/shared/agent-api/agent-api.v1.json` is generated from
  the same contract for other languages.
- **L2 operations** (next): agent intents such as `inbox.check`,
  `messages.reply`, `tasks.claim`, returning outcomes with a structured next
  step and the canonical CLI text.
- **L3 projections**: canonical text and the operation-based tool schema.

Generated inputs never get hand edits: run
`pnpm --filter @botiverse/raft-shared generate:agent-api-routes` and
`generate:agent-api-description` after changing the contract or the metadata;
CI checks both for freshness.
