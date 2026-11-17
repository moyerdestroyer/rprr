import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

let cwd = "";
if (process.env.RPRR_TEST_STDERR) console.error(process.env.RPRR_TEST_STDERR);

function echoedReview(received: string): string | undefined {
  const firstLine = received.split("\n")[0] ?? "";
  if (process.env.RPRR_TEST_HOME === "1")
    return JSON.stringify({ summary: process.env.HOME ?? "", findings: [] });
  if (process.env.RPRR_TEST_INHERITED)
    return JSON.stringify({
      summary: process.env.RPRR_TEST_INHERITED,
      findings: [],
    });
  if (process.env.RPRR_TEST_ECHO === "1")
    return JSON.stringify({ summary: firstLine, findings: [] });
  if (process.env.RPRR_TEST_NARRATE !== "1") return undefined;
  if (!received.startsWith("Complete the review now"))
    return "Working on the review.";
  return JSON.stringify({ summary: firstLine, findings: [] });
}
const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp
  .agent({ name: "rprr-test-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    cwd = ctx.params.cwd;
    const advertised = process.env.RPRR_TEST_COMMANDS;
    if (advertised) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "test-session",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: advertised.split(",").map((name) => ({
            name,
            description: `${name} skill`,
          })),
        },
      });
    }
    return { sessionId: "test-session" };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const decision = await ctx.client.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId: ctx.params.sessionId,
        toolCall: {
          toolCallId: "write-test",
          title: "Write to checkout",
          kind: "edit",
          status: "pending",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    );
    let blocked = false;
    if (process.env.RPRR_TEST_STATE_FILE)
      await writeFile(process.env.RPRR_TEST_STATE_FILE, "agent state");
    try {
      await writeFile(join(cwd, "should-not-exist"), "bad");
    } catch {
      blocked = true;
    }
    const block = ctx.params.prompt[0];
    const received =
      block && "text" in block && typeof block.text === "string"
        ? block.text
        : "";
    const reviewText =
      echoedReview(received) ??
      process.env.RPRR_TEST_RESPONSE ??
      JSON.stringify({
        summary: `${blocked ? "write blocked" : "write succeeded"}; ${decision.outcome.outcome === "selected" ? decision.outcome.optionId : "cancelled"}`,
        findings: [],
      });
    if (process.env.RPRR_TEST_SILENT === "1") {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "looked around" },
        },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read-1",
          title: "Read plugin.php",
          status: "completed",
        },
      });
    } else if (process.env.RPRR_TEST_THOUGHT_REVIEW === "1") {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: reviewText },
        },
      });
    } else {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reviewText },
        },
      });
    }
    return { stopReason: "end_turn" };
  })
  .connect(stream);
