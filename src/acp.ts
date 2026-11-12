import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { configuredAgentCommand } from "./agent-command.ts";
import type { Config } from "./config.ts";
import { parseReview } from "./findings.ts";
import { reviewSkill } from "./prompt.ts";

export type AdvertisedCommand = { name: string; description: string };

function advertisedCommands(value: unknown): AdvertisedCommand[] {
  if (!value || typeof value !== "object" || !("availableCommands" in value))
    return [];
  const list = value.availableCommands;
  if (!Array.isArray(list)) return [];
  const commands: AdvertisedCommand[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || !("name" in item)) continue;
    if (typeof item.name !== "string" || !item.name) continue;
    const description =
      "description" in item && typeof item.description === "string"
        ? item.description
        : "";
    commands.push({ name: item.name, description });
  }
  return commands;
}

function assertAdvertisedSkill(
  skill: string,
  commands: readonly AdvertisedCommand[],
): void {
  if (!commands.length || commands.some((command) => command.name === skill))
    return;
  const names = commands.map((command) => `/${command.name}`).join(", ");
  throw new Error(
    `Agent did not advertise /${skill}. Available commands: ${names}`,
  );
}

function permission(
  params: acp.RequestPermissionRequest,
): acp.RequestPermissionResponse {
  const kind = params.toolCall.kind;
  const allowed = kind === "read" || kind === "search";
  const option = params.options.find((item) =>
    allowed ? item.kind === "allow_once" : item.kind === "reject_once",
  );
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function agentEnvironment(config: Config["agent"]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error(`Invalid agent environment variable: ${key}`);
    env[key] = value;
  }
  return env;
}

type AgentTurn = { response: string; commands: AdvertisedCommand[] };

function rememberCommands(turn: AgentTurn, value: unknown): void {
  const advertised = advertisedCommands(value);
  if (advertised.length) turn.commands = advertised;
}

function clientSession(child: ReturnType<typeof spawn>, turn: AgentTurn) {
  if (!child.stdin || !child.stdout)
    throw new Error("Could not start ACP agent");
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const app = acp
    .client({ name: "rprr" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      permission(ctx.params),
    )
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const update = ctx.params.update;
      if (update.sessionUpdate === "available_commands_update") {
        rememberCommands(turn, update);
        return;
      }
      if (update.sessionUpdate !== "agent_message_chunk") return;
      if (update.content.type !== "text") return;
      turn.response += update.content.text;
      if (turn.response.length > 1_000_000)
        throw new Error("ACP response exceeds 1 MB");
    });
  return { stream, app };
}

async function exchange(
  child: ReturnType<typeof spawn>,
  cwd: string,
  prompt: string,
  skill: string | undefined,
): Promise<string> {
  const turn: AgentTurn = { response: "", commands: [] };
  const { stream, app } = clientSession(child, turn);
  await app.connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    if (init.protocolVersion !== acp.PROTOCOL_VERSION)
      throw new Error(`Unsupported ACP version: ${init.protocolVersion}`);
    const session = await ctx.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    rememberCommands(turn, session);
    if (skill) assertAdvertisedSkill(skill, turn.commands);
    const prompts = [
      skill ? `/${skill}\n${prompt}` : prompt,
      'Complete the review now. Return only a JSON object with "summary" and "findings". Do not narrate progress.',
    ];
    for (const text of prompts) {
      turn.response = "";
      const result = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text }],
      });
      if (result.stopReason !== "end_turn")
        throw new Error(`ACP agent stopped: ${result.stopReason}`);
      try {
        parseReview(turn.response, Number.MAX_SAFE_INTEGER);
        return;
      } catch {
        // A follow-up turn asks the agent to finish in the required format.
      }
    }
  });
  if (!turn.response.trim())
    throw new Error("ACP agent returned no review text");
  return turn.response;
}

async function withAgent<T>(
  config: Config["agent"],
  cwd: string,
  timeoutSeconds: number,
  body: (child: ReturnType<typeof spawn>) => Promise<T>,
): Promise<T> {
  const child = spawn(configuredAgentCommand(config.command), config.args, {
    cwd,
    env: agentEnvironment(config),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stderr) throw new Error("Could not start ACP agent");
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutSeconds * 1000);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  try {
    return await body(child);
  } catch (error) {
    if (timedOut)
      throw new Error(`ACP agent timed out after ${timeoutSeconds}s`);
    if (stderr.trim()) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}\n${stderr.trim()}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

export async function runAgent(
  config: Config["agent"],
  cwd: string,
  prompt: string,
  timeoutSeconds: number,
  skill?: string,
): Promise<string> {
  return withAgent(config, cwd, timeoutSeconds, (child) =>
    exchange(child, cwd, prompt, reviewSkill(skill)),
  );
}

export async function listAgentCommands(
  config: Config["agent"],
  cwd: string,
  timeoutSeconds: number,
): Promise<AdvertisedCommand[]> {
  const turn: AgentTurn = { response: "", commands: [] };
  await withAgent(config, cwd, timeoutSeconds, async (child) => {
    const { stream, app } = clientSession(child, turn);
    await app.connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      if (init.protocolVersion !== acp.PROTOCOL_VERSION)
        throw new Error(`Unsupported ACP version: ${init.protocolVersion}`);
      const session = await ctx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      rememberCommands(turn, session);
    });
  });
  return turn.commands;
}
