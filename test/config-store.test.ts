import assert from "node:assert/strict";
import test from "node:test";

import {
	deepMergeConfigRecords,
	normalizeConfig,
	resolveProjectConfigPath,
} from "../src/config-store.ts";

test("resolveProjectConfigPath points at <repo>/.pi/extensions/<id>/config.json", () => {
	assert.equal(
		resolveProjectConfigPath("/repo"),
		"/repo/.pi/extensions/pi-smart-voice-notify/config.json",
	);
});

test("deepMergeConfigRecords overrides scalars and preserves untouched base keys", () => {
	const merged = deepMergeConfigRecords(
		{ windowsOptimized: true, enableSound: true },
		{ windowsOptimized: false },
	);
	assert.deepEqual(merged, { windowsOptimized: false, enableSound: true });
});

test("deepMergeConfigRecords deep-merges nested objects and replaces arrays", () => {
	const merged = deepMergeConfigRecords(
		{ webhook: { enabled: false, genericUrl: "https://g", events: ["idle", "error"] } },
		{ webhook: { enabled: true, events: ["permission"] } },
	);
	assert.deepEqual(merged, {
		webhook: { enabled: true, genericUrl: "https://g", events: ["permission"] },
	});
});

test("deepMergeConfigRecords does not mutate its inputs", () => {
	const base = { webhook: { enabled: false } };
	const override = { webhook: { enabled: true } };
	deepMergeConfigRecords(base, override);
	assert.deepEqual(base, { webhook: { enabled: false } });
	assert.deepEqual(override, { webhook: { enabled: true } });
});

test("a partial project record overrides only its keys through normalizeConfig", () => {
	const globalRecord = { windowsOptimized: true, notificationMode: "tts-first" };
	const projectRecord = { windowsOptimized: false };
	const config = normalizeConfig(deepMergeConfigRecords(globalRecord, projectRecord));
	assert.equal(config.windowsOptimized, false);
	assert.equal(config.notificationMode, "tts-first");
});
