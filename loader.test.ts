import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pi = Bun.which("pi");

// Direct Bun imports do not reproduce compiled pi's Jiti/native binding path.
test.skipIf(!pi)("installed pi loads goal and registers its command", () => {
  const home = mkdtempSync(join(tmpdir(), "goal-loader-"));
  try {
    const result = spawnSync(pi!, [
      "--offline", "--mode", "rpc", "--no-session",
      "-ne", "-ns", "-np", "-nc",
      "-e", fileURLToPath(new URL("./index.ts", import.meta.url)),
    ], {
      cwd: home,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: home },
      input: '{"id":"load-check","type":"get_commands"}\n',
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain("Failed to load extension");
    expect(result.status).toBe(0);
    const response = result.stdout.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((message) => message.id === "load-check");
    expect(response?.success).toBe(true);
    expect(response?.data.commands).toContainEqual(expect.objectContaining({ name: "goal", source: "extension" }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
