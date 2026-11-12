import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export function resolveAgentCommand(command: string): string | undefined {
  const expanded =
    command === "~"
      ? homedir()
      : command.startsWith("~/")
        ? resolve(homedir(), command.slice(2))
        : command;
  if (expanded.includes("/")) return Bun.which(resolve(expanded)) ?? undefined;
  return Bun.which(expanded) ?? undefined;
}

export function configuredAgentCommand(command: string): string {
  const executable = resolveAgentCommand(command);
  if (!executable) throw new Error(`Agent executable not found: ${command}`);
  return isAbsolute(executable) ? executable : resolve(executable);
}
