// Request schemas: each agent operation validates its input with one zod
// schema (outcome.ts `validateOpRequest`), and the SDK's operation manifest
// projects the same schema to JSON Schema, so what a gateway advertises and
// what the operation accepts cannot drift apart.
//
// `requestSchema<T>()(schema)` pins a schema to the operation's TypeScript
// request type in both directions at compile time: every `T` is accepted by
// the schema's input type, and what the schema produces is a `T`. The
// schema's own precise type is kept (so `.extend`/`.omit` stay available).

import type { z } from "zod";

export function requestSchema<T>() {
  return <S extends z.ZodType<T>>(schema: S & ([T] extends [z.input<S>] ? unknown : never)): S => schema;
}
