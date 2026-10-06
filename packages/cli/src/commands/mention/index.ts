import type { Command } from "commander";

import type { CommandRuntimeOptions } from "../../core/context";
import { registerMentionDeliveryCommand } from "./delivery";
import { registerMentionExecuteCommands } from "./execute";
import { registerMentionPendingCommand } from "./pending";

export function registerMentionCommands(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerMentionPendingCommand(parent, runtimeOptions);
  registerMentionExecuteCommands(parent, runtimeOptions);
  registerMentionDeliveryCommand(parent, runtimeOptions);
}
