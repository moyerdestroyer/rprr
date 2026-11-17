import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { configuredAgentCommand } from "./agent-command.ts";
import type { Config } from "./config.ts";
import { parseReview } from "./findings.ts";
import { ProcessTimeoutError, withProcessTimeout } from "./process.ts";
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

type AgentTurn = {
  response: string;
  commands: AdvertisedCommand[];
  thoughts: string;
  trace: string;
};

const traceLimit = 4_000;

function note(turn: AgentTurn, line: string): void {
  const next = `${turn.trace}${turn.trace ? "\n" : ""}${line}`;
  turn.trace = next.length > traceLimit ? next.slice(-traceLimit) : next;
}

function field(value: object, key: string): string {
  if (!(key in value)) return "";
  const item = value[key as keyof typeof value];
  return typeof item === "string" ? item : "";
}

function blockText(content: unknown): string {
  if (!content || typeof content !== "object" || !("type" in content))
    return "";
  if (
    content.type !== "text" ||
    !("text" in content) ||
    typeof content.text !== "string"
  )
    return "";
  return content.text;
}

function blocksText(content: unknown): string | undefined {
  if (content == null) return "";
  if (!Array.isArray(content)) return undefined;
  return content.map((block) => blockText(block)).join("");
}

function keepResponse(turn: AgentTurn, text: string, append: boolean): void {
  const next = append ? turn.response + text : text;
  if (next.length > 1_000_000) throw new Error("ACP response exceeds 1 MB");
  turn.response = next;
}

function noteTool(turn: AgentTurn, update: object): void {
  const title =
    field(update, "title") ||
    field(update, "name") ||
    field(update, "toolCallId") ||
    "tool";
  const status = field(update, "status");
  note(turn, `tool ${title}${status ? ` (${status})` : ""}`);
}

function updateContent(update: object): unknown {
  return "content" in update ? update.content : undefined;
}

function recordReply(turn: AgentTurn, update: object, kind: string): boolean {
  if (kind === "agent_message_chunk") {
    const text = blockText(updateContent(update));
    if (text) keepResponse(turn, text, true);
    else note(turn, "agent_message_chunk without text");
    return true;
  }
  if (kind !== "agent_message") return false;
  const text = blocksText(updateContent(update));
  if (text !== undefined) keepResponse(turn, text, false);
  return true;
}

function rememberThought(turn: AgentTurn, text: string | undefined): void {
  const trimmed = text?.trim();
  if (!trimmed) return;
  const next = `${turn.thoughts}${turn.thoughts ? "\n" : ""}${trimmed}`;
  turn.thoughts = next.length > traceLimit ? next.slice(-traceLimit) : next;
  note(turn, `thought: ${trimmed.slice(0, 300)}`);
}

function recordAside(turn: AgentTurn, update: object, kind: string): boolean {
  if (kind === "agent_thought_chunk" || kind === "agent_thought") {
    const text =
      kind === "agent_thought"
        ? blocksText(updateContent(update))
        : blockText(updateContent(update));
    rememberThought(turn, text);
    return true;
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    noteTool(turn, update);
    return true;
  }
  if (kind !== "state_update") return false;
  const reason = field(update, "stopReason");
  note(turn, `state ${field(update, "state")} ${reason}`.trim());
  return true;
}

function recordUpdate(turn: AgentTurn, update: object): void {
  if (!("sessionUpdate" in update) || typeof update.sessionUpdate !== "string")
    return;
  const kind = update.sessionUpdate;
  if (kind === "available_commands_update") {
    rememberCommands(turn, update);
    return;
  }
  if (recordReply(turn, update, kind) || recordAside(turn, update, kind))
    return;
  note(turn, kind);
}

function parsedReview(text: string): string | undefined {
  const body = text.trim();
  if (!body) return undefined;
  try {
    parseReview(body, Number.MAX_SAFE_INTEGER);
    return body;
  } catch {
    return undefined;
  }
}

function reviewFailure(turn: AgentTurn): Error {
  const body = turn.response.trim().slice(0, 2_000);
  const trace = turn.trace.trim();
  const detail = [body, trace].filter(Boolean).join("\n");
  const headline = body
    ? "ACP agent returned a review that could not be parsed"
    : "ACP agent returned no review text";
  return new Error(detail ? `${headline}\n${detail}` : headline);
}

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
      recordUpdate(turn, ctx.params.update);
    });
  return { stream, app };
}

async function promptTurn(
  request: (
    method: typeof acp.methods.agent.session.prompt,
    params: {
      sessionId: string;
      prompt: [{ type: "text"; text: string }];
    },
  ) => Promise<{ stopReason?: string | null }>,
  turn: AgentTurn,
  sessionId: string,
  text: string,
): Promise<string | undefined> {
  if (turn.response.trim())
    note(turn, `earlier reply: ${turn.response.trim().slice(0, 1_500)}`);
  turn.response = "";
  const result = await request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text }],
  });
  if (result.stopReason !== "end_turn")
    throw new Error(
      `ACP agent stopped: ${result.stopReason}${turn.trace.trim() ? `\n${turn.trace.trim()}` : ""}`,
    );
  return parsedReview(turn.response);
}

async function exchange(
  child: ReturnType<typeof spawn>,
  cwd: string,
  prompt: string,
  skill: string | undefined,
): Promise<string> {
  const turn: AgentTurn = {
    response: "",
    commands: [],
    thoughts: "",
    trace: "",
  };
  const { stream, app } = clientSession(child, turn);
  let review: string | undefined;
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
      review =
        (await promptTurn(
          ctx.request.bind(ctx),
          turn,
          session.sessionId,
          text,
        )) ?? parsedReview(turn.thoughts);
      if (review) return;
    }
  });
  if (review) return review;
  throw reviewFailure(turn);
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
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stderr) throw new Error("Could not start ACP agent");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  try {
    return await withProcessTimeout(
      child,
      timeoutSeconds * 1000,
      "ACP agent",
      () => body(child),
    );
  } catch (error) {
    if (error instanceof ProcessTimeoutError) throw error;
    if (stderr.trim()) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}\n${stderr.trim()}`, { cause: error });
    }
    throw error;
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
  const turn: AgentTurn = {
    response: "",
    commands: [],
    thoughts: "",
    trace: "",
  };
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

export async function probeAgentHandshake(
  config: Config["agent"],
  cwd: string,
  timeoutSeconds: number,
): Promise<void> {
  const turn: AgentTurn = {
    response: "",
    commands: [],
    thoughts: "",
    trace: "",
  };
  await withAgent(config, cwd, timeoutSeconds, async (child) => {
    const { stream, app } = clientSession(child, turn);
    await app.connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      if (init.protocolVersion !== acp.PROTOCOL_VERSION)
        throw new Error(`Unsupported ACP version: ${init.protocolVersion}`);
    });
  });
}
