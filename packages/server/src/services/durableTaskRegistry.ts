import { DurableTaskRegistry } from "./durableTasks";

/**
 * Every durable task kind the server can run (RFC 073). A kind must be
 * registered on every replica before any code path creates tasks of it, so a
 * rolling deploy adds the definition one release before its first producer.
 */
export const durableTaskRegistry = new DurableTaskRegistry();
