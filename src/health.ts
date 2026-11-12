import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdvertisedCommand, listAgentCommands, runAgent } from "./acp.ts";
import { appPaths, type Config, loadConfig } from "./config.ts";
import { parseReview } from "./findings.ts";

export function commandAvailable(command: string): boolean {
  return Bun.which(command) !== null;
}

export function githubAuthenticated(): boolean {
  if (!commandAvailable("gh")) return false;
  return (
    Bun.spawnSync(["gh", "auth", "status"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}

export async function probeAgent(config: Config): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "rprr-agent-probe-"));
  try {
    const response = await runAgent(
      config.agent,
      directory,
      'Setup check. Return only this JSON: {"summary":"ready","findings":[]}',
      Math.min(config.review.timeoutSeconds, 45),
    );
    parseReview(response, config.review.maxFindings);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function advertisedSkills(
  config: Config,
): Promise<AdvertisedCommand[]> {
  const directory = await mkdtemp(join(tmpdir(), "rprr-skills-"));
  try {
    return await listAgentCommands(
      config.agent,
      directory,
      Math.min(config.review.timeoutSeconds, 45),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function healthSnapshot() {
  let config: Config | undefined;
  try {
    config = await loadConfig(appPaths().config);
  } catch {
    // The status command reports invalid or missing configuration without failing.
  }
  return {
    githubAuthenticated: githubAuthenticated(),
    sandboxAvailable: process.platform === "linux" && commandAvailable("bwrap"),
    configurationValid: config !== undefined,
    agentAvailable: config ? commandAvailable(config.agent.command) : false,
    publishingEnabled: config?.review.publish ?? false,
  };
}
