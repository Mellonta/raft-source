// tsconfig.raftdev.json overrides typeRoots, so "vitest/globals" cannot be
// pulled in through compilerOptions.types. Import it here instead so the
// raftdev*.test.ts files see the Vitest global APIs (globals: true).
import "vitest/globals";
