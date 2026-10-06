/**
 * Global server test setup (vitest setupFiles): tests write a message and read
 * it at once, so the history-read settle window is 0 here. Tests about the
 * window itself set one with setReadPositionSettleMsForTests and restore it.
 */
import { setReadPositionSettleMsForTests } from "../../services/readPositionSettle";

setReadPositionSettleMsForTests(0);
