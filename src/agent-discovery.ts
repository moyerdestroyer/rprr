import { tmpdir } from "node:os";
import { probeAgentHandshake } from "./acp.ts";

export type DetectedAgent = {
  name: string;
  command: string;
  args: string[];
};

// Launch recipes only identify candidates. The ACP handshake confirms each result.
const launchers = [
  { name: "Command Code", executable: "cmd", args: ["acp"] },
  { name: "OpenCode", executable: "opencode", args: ["acp"] },
  { name: "Gemini CLI", executable: "gemini", args: ["--acp"] },
  { name: "GitHub Copilot", executable: "copilot", args: ["--acp"] },
  { name: "Codex ACP", executable: "codex-acp", args: [] },
  { name: "Claude ACP", executable: "claude-code-acp", args: [] },
  { name: "Pi ACP", executable: "pi-acp", args: [] },
] as const;

type DiscoveryTools = {
  which: (executable: string) => string | null;
  handshake: (command: string, args: string[]) => Promise<void>;
};

const tools: DiscoveryTools = {
  which: (executable) => Bun.which(executable),
  handshake: (command, args) =>
    probeAgentHandshake({ command, args }, tmpdir(), 6),
};

export async function discoverAgents(
  deps: DiscoveryTools = tools,
): Promise<DetectedAgent[]> {
  const found = await Promise.all(
    launchers.map(async ({ name, executable, args }) => {
      const command = deps.which(executable);
      if (!command) return null;
      try {
        await deps.handshake(command, [...args]);
        return { name, command, args: [...args] };
      } catch {
        return null;
      }
    }),
  );
  return found.filter((agent) => agent !== null);
}
