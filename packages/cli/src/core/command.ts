import { Option, type Command } from "commander";

import type { CommandContext, CommandRuntimeOptions } from "./context";
import { createCommandContext } from "./context";
import { renderError } from "./renderer";
import { CliExit, cliError, toCliError } from "./errors";
import { assertGuidanceWithinLimits, attachGuidanceToHelp, commandPath, gateCommandGuidance } from "../ax/commandGuidance";

export interface CommandOptionSpec {
  flags: string;
  description: string;
  parse?: (value: string, previous: any) => any;
  hidden?: boolean;
}

export interface CommandSpec {
  name: string;
  description: string;
  arguments?: string[];
  options?: CommandOptionSpec[];
  helpAfter?: string;
  /**
   * Usage guidance of a consequential command (RFC 072 §7): always printed in
   * full by `--help`; the first run in an agent's model context delivers it
   * instead of executing (ax/commandGuidance.ts). At most MAX_GUIDANCE_LINES
   * lines and MAX_GUIDANCE_CHARS characters.
   */
  guidance?: string;
}

export type CommandHandler = (ctx: CommandContext, ...args: any[]) => Promise<void> | void;

export function defineCommand(spec: CommandSpec, handler: CommandHandler): {
  spec: CommandSpec;
  handler: CommandHandler;
} {
  return { spec, handler };
}

export function registerCliCommand(
  parent: Command,
  command: ReturnType<typeof defineCommand>,
  runtimeOptions: CommandRuntimeOptions = {},
): void {
  const child = parent.command(command.spec.name).description(command.spec.description);
  for (const arg of command.spec.arguments ?? []) {
    child.argument(arg);
  }
  for (const option of command.spec.options ?? []) {
    const commanderOption = option.hidden ? new Option(option.flags, option.description).hideHelp() : null;
    if (option.parse) {
      if (commanderOption) {
        commanderOption.argParser(option.parse);
        child.addOption(commanderOption);
      } else {
        child.option(option.flags, option.description, option.parse);
      }
    } else if (commanderOption) {
      child.addOption(commanderOption);
    } else {
      child.option(option.flags, option.description);
    }
  }
  if (command.spec.guidance) {
    assertGuidanceWithinLimits(command.spec.name, command.spec.guidance);
    attachGuidanceToHelp(child, command.spec.guidance, { env: runtimeOptions.env });
  }
  if (command.spec.helpAfter) {
    child.addHelpText("after", command.spec.helpAfter);
  }
  child.action(async (...args: any[]) => {
    const ctx = createCommandContext(runtimeOptions);
    try {
      if (command.spec.guidance && gateCommandGuidance(commandPath(child), command.spec.guidance, ctx.io.stdout, ctx.env) === "held") {
        throw cliError("GUIDANCE_DELIVERED", "Not executed; the command's guidance was delivered instead.", {
          effect: "not_executed",
          retryable: true,
          // The text above already says what happened and what to do.
          textDetailMode: "omit_restated_lines",
          suggestedNextAction: "Run the same command again unchanged.",
        });
      }
      await command.handler(ctx, ...args);
    } catch (err) {
      // CliExit is the sanctioned "account already written, set the status"
      // exit. Wrapping it in toCliError turned every such exit into a spurious
      // "Unexpected error: CliExit(1) / Code: INTERNAL_BUG" on stderr — an
      // internal-tool-error claim about a perfectly normal refusal (task #60).
      if (err instanceof CliExit) throw err;
      const cliError = toCliError(err);
      renderError(ctx.io, cliError);
      throw new CliExit(cliError.exitCode);
    }
  });
}
