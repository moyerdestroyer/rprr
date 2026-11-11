import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

let cwd = "";
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
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    cwd = ctx.params.cwd;
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
    try {
      await writeFile(join(cwd, "should-not-exist"), "bad");
    } catch {
      blocked = true;
    }
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text:
            process.env.RPRR_TEST_RESPONSE ??
            JSON.stringify({
              summary: `${blocked ? "write blocked" : "write succeeded"}; ${decision.outcome.outcome === "selected" ? decision.outcome.optionId : "cancelled"}`,
              findings: [],
            }),
        },
      },
    });
    return { stopReason: "end_turn" };
  })
  .connect(stream);
