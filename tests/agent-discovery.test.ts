import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAgentHandshake } from "../src/acp.ts";
import { discoverAgents } from "../src/agent-discovery.ts";

test("discovery offers only installed agents that complete an ACP handshake", async () => {
  const installed = new Map([
    ["cmd", "/agents/cmd"],
    ["opencode", "/agents/opencode"],
    ["gemini", "/agents/gemini"],
  ]);
  const attempted: string[] = [];
  const agents = await discoverAgents({
    which: (name) => installed.get(name) ?? null,
    handshake: async (command, args) => {
      attempted.push(`${command} ${args.join(" ")}`);
      if (command.endsWith("opencode")) throw new Error("ACP unavailable");
    },
  });
  expect(attempted).toEqual([
    "/agents/cmd acp",
    "/agents/opencode acp",
    "/agents/gemini --acp",
  ]);
  expect(agents).toEqual([
    { name: "Command Code", command: "/agents/cmd", args: ["acp"] },
    { name: "Gemini CLI", command: "/agents/gemini", args: ["--acp"] },
  ]);
});

test("ACP detection only initializes the agent and rejects non-ACP commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rprr-discovery-test-"));
  try {
    const state = join(directory, "agent-state");
    await probeAgentHandshake(
      {
        command: process.execPath,
        args: [join(import.meta.dir, "fixtures/agent.ts")],
        env: { RPRR_TEST_STATE_FILE: state },
      },
      directory,
      5,
    );
    expect(await Bun.file(state).exists()).toBe(false);
    await expect(
      probeAgentHandshake(
        { command: "/bin/echo", args: ["hello"] },
        directory,
        5,
      ),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
