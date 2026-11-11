import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Config } from "./config.ts";

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

function sandboxArguments(config: Config["agent"], cwd: string): string[] {
  if (process.platform !== "linux" || !Bun.which("bwrap"))
    throw new Error("Read-only review requires Linux and bubblewrap (bwrap)");
  const executable = Bun.which(config.command);
  if (!executable)
    throw new Error(`Agent executable not found: ${config.command}`);
  const args: string[] = [
    "--die-with-parent",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--tmpfs",
    "/tmp",
    "--dir",
    dirname(cwd),
    "--ro-bind",
    cwd,
    cwd,
    "--dev-bind",
    "/dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    cwd,
    "--clearenv",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "PATH",
    process.env.PATH ?? "/usr/bin:/bin",
  ];
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error(`Invalid agent environment variable: ${key}`);
    args.push("--setenv", key, value);
  }
  args.push("--", executable, ...config.args);
  return args;
}

async function exchange(
  child: ReturnType<typeof spawn>,
  cwd: string,
  prompt: string,
): Promise<string> {
  if (!child.stdin || !child.stdout)
    throw new Error("Could not start ACP agent");
  let response = "";
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const result = await acp
    .client({ name: "rprr" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      permission(ctx.params),
    )
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const update = ctx.params.update;
      if (update.sessionUpdate !== "agent_message_chunk") return;
      if (update.content.type !== "text") return;
      response += update.content.text;
      if (response.length > 1_000_000)
        throw new Error("ACP response exceeds 1 MB");
    })
    .connectWith(stream, async (ctx) => {
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
      return ctx.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
    });
  if (result.stopReason !== "end_turn")
    throw new Error(`ACP agent stopped: ${result.stopReason}`);
  if (!response.trim()) throw new Error("ACP agent returned no review text");
  return response;
}

export async function runAgent(
  config: Config["agent"],
  cwd: string,
  prompt: string,
  timeoutSeconds: number,
): Promise<string> {
  const args = sandboxArguments(config, cwd);
  const child = spawn("bwrap", args, { stdio: ["pipe", "pipe", "pipe"] });
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
    return await exchange(child, cwd, prompt);
  } catch (error) {
    if (timedOut)
      throw new Error(`ACP agent timed out after ${timeoutSeconds}s`);
    if (stderr.trim())
      throw new Error("ACP agent failed; check its command and sandbox setup", {
        cause: error,
      });
    throw error;
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}
