import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const program = `import { notifyDraft } from ${JSON.stringify(join(import.meta.dir, "../src/notify.ts"))}; await notifyDraft({ repository: "org/repo", number: 12 }, { url: "https://github.com/org/repo/pull/12#pullrequestreview-1" });`;

test("draft toast passes the RPRR mascot to notify-send", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rprr-notify-test-"));
  try {
    const executable = join(directory, "notify-send");
    const log = join(directory, "args.json");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\0' "$@" > "$RPRR_NOTIFY_TEST_LOG"\n`,
    );
    await chmod(executable, 0o755);
    const child = Bun.spawn(["bun", "-e", program], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        XDG_CURRENT_DESKTOP: "GNOME",
        RPRR_NOTIFY_TEST_LOG: log,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    const args = (await readFile(log, "utf8")).split("\0");
    expect(args).toContain("--app-name=RPRR");
    const icon = args.find((arg) => arg.startsWith("--icon="));
    expect(icon).toBeDefined();
    expect(args.some((arg) => arg.startsWith("--hint="))).toBe(false);
    expect(await Bun.file(icon?.slice("--icon=".length) ?? "").exists()).toBe(
      true,
    );
    expect(args).toContain("Draft review ready");
    expect(args).toContain(
      "org/repo#12\nhttps://github.com/org/repo/pull/12#pullrequestreview-1",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cinnamon draft toast uses one large mascot image", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rprr-cinnamon-notify-test-"));
  try {
    const executable = join(directory, "notify-send");
    const log = join(directory, "args.json");
    const copiedImage = join(directory, "copied-image.png");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\0' "$@" > "$RPRR_NOTIFY_TEST_LOG"\nfor arg in "$@"; do\n  case "$arg" in\n    --hint=string:image-path:*) cp "\${arg#--hint=string:image-path:}" "$RPRR_IMAGE_COPY" ;;\n  esac\ndone\n`,
    );
    await chmod(executable, 0o755);
    const child = Bun.spawn(["bun", "-e", program], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        XDG_CURRENT_DESKTOP: "X-Cinnamon",
        RPRR_NOTIFY_TEST_LOG: log,
        RPRR_IMAGE_COPY: copiedImage,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const args = (await readFile(log, "utf8")).split("\0");
    const icon = args.find((arg) => arg.startsWith("--icon="));
    expect(icon).toBeDefined();
    expect(icon?.endsWith("empty-icon.svg")).toBe(true);
    expect(
      args.some((arg) => arg.startsWith("--hint=string:image-path:")),
    ).toBe(true);
    expect(await readFile(copiedImage)).toEqual(
      await readFile(join(import.meta.dir, "../assets/mascot-v3.png")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiled toast extracts its embedded mascot for notify-send", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rprr-compiled-notify-test-"));
  try {
    const entrypoint = join(directory, "entry.ts");
    const binary = join(directory, "rprr-notify-test");
    const copiedIcon = join(directory, "copied-icon.png");
    const copiedImage = join(directory, "copied-image.png");
    const executable = join(directory, "notify-send");
    await writeFile(entrypoint, program);
    await writeFile(
      executable,
      `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    --icon=*) cp "\${arg#--icon=}" "$RPRR_ICON_COPY" ;;\n    --hint=string:image-path:*) cp "\${arg#--hint=string:image-path:}" "$RPRR_IMAGE_COPY" ;;\n  esac\ndone\n`,
    );
    await chmod(executable, 0o755);
    const build = Bun.spawn(
      ["bun", "build", "--compile", entrypoint, "--outfile", binary],
      { stdout: "pipe", stderr: "pipe" },
    );
    const buildError = await new Response(build.stderr).text();
    expect(await build.exited).toBe(0);
    expect(buildError).not.toContain("error:");
    const child = Bun.spawn([binary], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        XDG_CURRENT_DESKTOP: "GNOME",
        RPRR_ICON_COPY: copiedIcon,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await readFile(copiedIcon)).toEqual(
      await readFile(join(import.meta.dir, "../assets/mascot-v3.png")),
    );
    const cinnamon = Bun.spawn([binary], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        XDG_CURRENT_DESKTOP: "X-Cinnamon",
        RPRR_ICON_COPY: copiedIcon,
        RPRR_IMAGE_COPY: copiedImage,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await cinnamon.exited).toBe(0);
    expect(await readFile(copiedIcon, "utf8")).toContain("<svg");
    expect(await readFile(copiedImage)).toEqual(
      await readFile(join(import.meta.dir, "../assets/mascot-v3.png")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
