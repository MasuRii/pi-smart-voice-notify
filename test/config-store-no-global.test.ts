import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// config-store resolves its global config path once at module load, from
// PI_CODING_AGENT_DIR. Point it at a throwaway, empty dir *before* importing so
// that no global config exists for this test. The dynamic import below runs
// after this assignment (static imports would be hoisted ahead of it).
const agentDir = mkdtempSync(join(tmpdir(), "svn-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { readConfigFromDisk, resolveProjectConfigPath, CONFIG_PATH } = await import(
	"../src/config-store.ts"
);

test("a project config applies over defaults when no global config exists", () => {
	// Guard: confirm this process really resolved the isolated, empty agent dir.
	assert.ok(CONFIG_PATH.startsWith(agentDir), `expected isolated CONFIG_PATH, got ${CONFIG_PATH}`);
	assert.equal(existsSync(CONFIG_PATH), false, "global config must be absent at the start");

	const projectRoot = mkdtempSync(join(tmpdir(), "svn-repo-"));
	const projectConfigPath = resolveProjectConfigPath(projectRoot);
	mkdirSync(dirname(projectConfigPath), { recursive: true });
	writeFileSync(
		projectConfigPath,
		JSON.stringify({ windowsOptimized: false, notificationMode: "tts-first" }),
		"utf-8",
	);

	// Must not throw even though the global config file does not exist.
	const config = readConfigFromDisk(projectRoot);

	// Project values win over the defaults base.
	assert.equal(config.windowsOptimized, false);
	assert.equal(config.notificationMode, "tts-first");
	// Keys the project file omits fall back to defaults, never undefined.
	assert.equal(config.enabled, true);
	// The absent global config is created with defaults as a side effect.
	assert.equal(existsSync(CONFIG_PATH), true);
});
