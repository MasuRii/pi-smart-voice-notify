import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG, STATUS_KEY } from "../src/config-store.ts";
import smartVoiceNotifyExtension, {
	statusLine,
	type SmartVoiceNotifyDependencies,
} from "../src/index.ts";
import type { TTSAvailability, TTSConfig, TTSEngine, TTSService, SpeakOptions } from "../src/types/tts.ts";
import {
	PERMISSION_SYSTEM_EVENT_CHANNEL,
	PERMISSION_BATCH_WINDOW_MS,
	disableFocusDetection,
	enableFocusDetection,
	useMockClock,
	flushAsyncWork,
	tickAndFlush,
	permissionEvent,
	permissionSystemEvent,
	countReminderCalls,
	immediateNotificationCalls,
	reminderCalls,
	emitSessionStart,
	emitPermissionWait,
	emitPermissionResolve,
	assertSingleImmediateNotification,
	assertNoNotifications,
	assertSingleNotificationNoReminder,
	emitToolResult,
	emitAgentEndError,
} from "./helpers.ts";
import type { VoiceNotifyConfig } from "../src/types.ts";

interface FakeContext {
	hasUI: boolean;
	cwd?: string;
	hasPendingMessages?: () => boolean;
	ui?: {
		setStatus: (key: string, text: string | undefined) => void;
		notify: (message: string, level?: string) => void;
	};
}

interface SpeakCall {
	text: string;
	signal?: AbortSignal;
	aborted: boolean;
	complete: (result?: boolean) => void;
}

type EventHandler = (event: unknown, ctx: FakeContext) => Promise<unknown> | unknown;
type PermissionForwardingWatcherFactory = NonNullable<SmartVoiceNotifyDependencies["createPermissionForwardingWatcher"]>;
type PermissionForwardingWatcherOptions = Parameters<PermissionForwardingWatcherFactory>[0];
type PermissionForwardingWatcherController = ReturnType<PermissionForwardingWatcherFactory>;
type ForwardedPermissionRequestEvent = Parameters<PermissionForwardingWatcherOptions["onRequest"]>[0];
type ForwardedPermissionResolutionEvent = Parameters<PermissionForwardingWatcherOptions["onResolve"]>[0];
type PermissionForwardingWatcherConfig = Parameters<PermissionForwardingWatcherController["start"]>[0];
type EventBusHandler = (payload: unknown) => void;

const EMPTY_AVAILABILITY: TTSAvailability = {
	"espeak-ng": false,
	edge: false,
	elevenlabs: false,
	openai: false,
	sapi: false,
};

class FakeEventBus {
	private readonly handlers = new Map<string, EventBusHandler[]>();

	public on(channel: string, handler: EventBusHandler): () => void {
		const existing = this.handlers.get(channel) ?? [];
		existing.push(handler);
		this.handlers.set(channel, existing);
		return () => {
			const current = this.handlers.get(channel) ?? [];
			this.handlers.set(channel, current.filter((entry) => entry !== handler));
		};
	}

	public emit(channel: string, payload: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) {
			handler(payload);
		}
	}
}

class FakePi {
	private readonly handlers = new Map<string, EventHandler[]>();
	private tools: Array<{ name: string }> = [];

	public readonly events = new FakeEventBus();

	public on(eventName: string, handler: EventHandler): void {
		const existing = this.handlers.get(eventName) ?? [];
		existing.push(handler);
		this.handlers.set(eventName, existing);
	}

	public registerCommand(): void {
	}

	public setAvailableTools(tools: Array<{ name: string }>): void {
		this.tools = [...tools];
	}

	public getAllTools(): Array<{ name: string }> {
		return [...this.tools];
	}

	public sendMessage(): void {
	}

	public async fakeExec(): Promise<never> {
		throw new Error("Unexpected exec invocation in pi-smart-voice-notify index test");
	}

	public async emit(eventName: string, event: unknown, ctx: FakeContext): Promise<void> {
		for (const handler of this.handlers.get(eventName) ?? []) {
			await handler(event, ctx);
		}
	}
}

type FakePermissionForwardingWatcher = PermissionForwardingWatcherController & {
	currentConfig: PermissionForwardingWatcherConfig | null;
	emitRequest(event: ForwardedPermissionRequestEvent): void;
	emitResolve(event: ForwardedPermissionResolutionEvent): void;
};

function createFakePermissionForwardingWatcher(options: PermissionForwardingWatcherOptions): FakePermissionForwardingWatcher {
	const onRequest = options.onRequest;
	const onResolve = options.onResolve;
	let currentConfig: PermissionForwardingWatcherConfig | null = null;
	return {
		currentConfig,
		startWatching: (config: PermissionForwardingWatcherConfig): void => {
			currentConfig = config;
		},
		restart: (config: PermissionForwardingWatcherConfig): void => {
			currentConfig = config;
		},
		stop: (): void => {
			currentConfig = null;
		},
		emitRequest: (event: ForwardedPermissionRequestEvent): void => {
			onRequest(event);
		},
		emitResolve: (event: ForwardedPermissionResolutionEvent): void => {
			onResolve(event);
		},
		get currentConfig() {
			return currentConfig;
		},
	};
}

function createTestConfig(overrides: Partial<VoiceNotifyConfig> = {}): VoiceNotifyConfig {
	const baseConfig = structuredClone(DEFAULT_CONFIG);
	const reminderDelaySeconds = overrides.reminderDelaySeconds ?? 1;
	const followUpEnabled = overrides.followUpEnabled ?? false;
	const maxFollowUps = overrides.maxFollowUps ?? baseConfig.maxFollowUps;
	const followUpBackoffMultiplier =
		overrides.followUpBackoffMultiplier ?? baseConfig.followUpBackoffMultiplier;
	const reminderIntervals =
		overrides.reminderIntervals ??
		{
			defaultSeconds: reminderDelaySeconds,
			idleSeconds: reminderDelaySeconds,
			permissionSeconds: reminderDelaySeconds,
			questionSeconds: reminderDelaySeconds,
			errorSeconds: reminderDelaySeconds,
		};
	const reminderEscalation =
		overrides.reminderEscalation ??
		{
			enabled: followUpEnabled,
			maxFollowUps,
			backoffMultiplier: followUpBackoffMultiplier,
		};

	return {
		...baseConfig,
		enabled: true,
		enableIdleNotification: false,
		enablePermissionNotification: true,
		enableForwardedPermissionWatcher: false,
		enableQuestionNotification: false,
		enableErrorNotification: false,
		enableSound: false,
		enableDesktopNotification: false,
		notificationMode: "tts-first",
		wakeMonitor: false,
		reminderEnabled: true,
		reminderDelaySeconds,
		followUpEnabled,
		maxFollowUps,
		followUpBackoffMultiplier,
		reminderIntervals,
		reminderEscalation,
		minNotificationIntervalMs: 0,
		...overrides,
	};
}

function createControlledTTSService(): { calls: SpeakCall[]; service: TTSService } {
	const calls: SpeakCall[] = [];
	const service: TTSService = {
		speak: async (text: string, _engine: TTSEngine = "auto", options: SpeakOptions = {}): Promise<boolean> => {
			if (!options.signal) {
				calls.push({
					text,
					aborted: false,
					complete: () => {
					},
				});
				return true;
			}

			const call: SpeakCall = {
				text,
				signal: options.signal,
				aborted: options.signal.aborted,
				complete: () => {
				},
			};
			calls.push(call);

			if (options.signal.aborted) {
				return false;
			}

			return await new Promise<boolean>((resolve) => {
				let settled = false;
				const finish = (result: boolean): void => {
					if (settled) {
						return;
					}
					settled = true;
					resolve(result);
				};

				call.complete = (result = true) => {
					finish(result);
				};
				options.signal?.addEventListener(
					"abort",
					() => {
						call.aborted = true;
						finish(false);
					},
					{ once: true },
				);
			});
		},
		refreshEngineAvailability: async (): Promise<TTSAvailability> => {
			return EMPTY_AVAILABILITY;
		},
		getAvailableEngines: (): Readonly<TTSAvailability> => {
			return EMPTY_AVAILABILITY;
		},
		getConfig: (): Readonly<TTSConfig> => {
			return {} as TTSConfig;
		},
	};

	return { calls, service };
}

function createHarness(
	configOverrides: Partial<VoiceNotifyConfig> = {},
	dependencyOverrides: Partial<SmartVoiceNotifyDependencies> = {},
): {
	ctx: FakeContext;
	forwardingWatcher: FakePermissionForwardingWatcher;
	pi: FakePi;
	ttsCalls: SpeakCall[];
} {
	const pi = new FakePi();
	const { calls, service } = createControlledTTSService();
	let forwardingWatcher: FakePermissionForwardingWatcher | null = null;

	smartVoiceNotifyExtension(pi as unknown as ExtensionAPI, {
		readConfigFromDisk: () => createTestConfig(configOverrides),
		initializeTTSService: () => service,
		createPermissionForwardingWatcher: (options) => {
			forwardingWatcher = createFakePermissionForwardingWatcher(options);
			return forwardingWatcher;
		},
		...dependencyOverrides,
	});

	if (!forwardingWatcher) {
		throw new Error("Expected permission forwarding watcher to be created");
	}

	return {
		ctx: { hasUI: false },
		forwardingWatcher,
		pi,
		ttsCalls: calls,
	};
}

function forwardedPermissionRequest(
	requestId: string,
	requesterAgentName = "Delegate Alpha",
): ForwardedPermissionRequestEvent {
	return {
		source: "primary",
		requestId,
		requesterAgentName,
		filePath: `/tmp/${requestId}.json`,
	};
}

function forwardedPermissionResolution(
	requestId: string,
	reason: ForwardedPermissionResolutionEvent["reason"] = "request_removed",
): ForwardedPermissionResolutionEvent {
	return {
		...forwardedPermissionRequest(requestId),
		reason,
	};
}

/**
 * Create a test harness with focus detection enabled and a focus-check
 * collector. Used by the skipWhenFocused true/false tests that share the
 * same isTerminalFocused callback shape.
 */
function createFocusDetectionHarness(
	t: TestContext,
	skipWhenFocused: boolean,
): {
	ctx: FakeContext;
	pi: FakePi;
	ttsCalls: SpeakCall[];
	focusChecks: Array<{ cacheTtlMs?: number }>;
} {
	enableFocusDetection(t);
	useMockClock(t);

	const focusChecks: Array<{ cacheTtlMs?: number }> = [];
	const { ctx, pi, ttsCalls } = createHarness(
		{
			skipWhenFocused,
			focusCacheTtlMs: 975,
		},
		{
			isTerminalFocused: async (options) => {
				focusChecks.push({ cacheTtlMs: options.cacheTtlMs });
				return true;
			},
		},
	);
	return { ctx, pi, ttsCalls, focusChecks };
}

test("skipWhenFocused=false still notifies even when the terminal is focused", async (t) => {
	const { ctx, pi, ttsCalls, focusChecks } = createFocusDetectionHarness(t, false);

	await emitSessionStart(pi, ctx);
	await emitPermissionWait(pi, "permission-focus-disabled", { toolCallId: "call-focus-disabled", toolName: "write_file" });
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assertSingleImmediateNotification(ttsCalls);
	assert.equal(focusChecks.length, 0);
});

test("skipWhenFocused=true suppresses focused notifications and uses config focus cache ttl", async (t) => {
	const { ctx, pi, ttsCalls, focusChecks } = createFocusDetectionHarness(t, true);

	await emitSessionStart(pi, ctx);
	await emitPermissionWait(pi, "permission-focus-enabled", { toolCallId: "call-focus-enabled", toolName: "write_file" });
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 0);
	assert.equal(focusChecks.length, 1);
	assert.equal(focusChecks[0]?.cacheTtlMs, 975);
});

test("initializeTTSService receives the full configured TTS settings", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const capturedConfigs: Array<Partial<TTSConfig> | undefined> = [];
	const { service } = createControlledTTSService();
	const { ctx, pi } = createHarness(
		{
			enableTts: false,
			ttsEngine: "openai",
			fallbackChain: ["openai", "edge"],
			commandTimeoutMs: 45_000,
			edgeVoice: "en-US-AvaNeural",
			edgeRate: "+20%",
			edgePitch: "+4Hz",
			edgeVolume: "+10%",
			espeakVoice: "en-us",
			espeakRate: 210,
			espeakPitch: 60,
			elevenLabsApiKey: "test-elevenlabs-key",
			elevenLabsVoiceId: "voice-123",
			elevenLabsModel: "eleven_multilingual_v2",
			elevenLabsStability: 0.7,
			elevenLabsSimilarity: 0.8,
			elevenLabsStyle: 0.6,
			openaiTtsEndpoint: "https://example.invalid/v1/audio/speech",
			openaiTtsApiKey: "test-openai-key",
			openaiTtsModel: "tts-1-hd",
			openaiTtsVoice: "nova",
			openaiTtsFormat: "wav",
			openaiTtsSpeed: 1.25,
			ttsVoice: "Generic TTS Voice",
			ttsRate: 1,
			sapiVoice: "Dedicated SAPI Voice",
			sapiRate: 4,
		},
		{
			initializeTTSService: (options) => {
				capturedConfigs.push(options?.config);
				return service;
			},
		},
	);

	await emitSessionStart(pi, ctx);

	const latestConfig = capturedConfigs.at(-1);
	assert.ok(latestConfig);
	assert.equal(latestConfig?.enableTts, false);
	assert.equal(latestConfig?.ttsEngine, "openai");
	assert.deepEqual(latestConfig?.fallbackChain, ["openai", "edge"]);
	assert.equal(latestConfig?.commandTimeoutMs, 45_000);
	assert.equal(latestConfig?.edgeVoice, "en-US-AvaNeural");
	assert.equal(latestConfig?.edgeRate, "+20%");
	assert.equal(latestConfig?.edgePitch, "+4Hz");
	assert.equal(latestConfig?.edgeVolume, "+10%");
	assert.equal(latestConfig?.espeakVoice, "en-us");
	assert.equal(latestConfig?.espeakRate, 210);
	assert.equal(latestConfig?.espeakPitch, 60);
	assert.equal(latestConfig?.elevenLabsApiKey, "test-elevenlabs-key");
	assert.equal(latestConfig?.elevenLabsVoiceId, "voice-123");
	assert.equal(latestConfig?.elevenLabsModel, "eleven_multilingual_v2");
	assert.equal(latestConfig?.elevenLabsStability, 0.7);
	assert.equal(latestConfig?.elevenLabsSimilarity, 0.8);
	assert.equal(latestConfig?.elevenLabsStyle, 0.6);
	assert.equal(latestConfig?.openaiTtsEndpoint, "https://example.invalid/v1/audio/speech");
	assert.equal(latestConfig?.openaiTtsApiKey, "test-openai-key");
	assert.equal(latestConfig?.openaiTtsModel, "tts-1-hd");
	assert.equal(latestConfig?.openaiTtsVoice, "nova");
	assert.equal(latestConfig?.openaiTtsFormat, "wav");
	assert.equal(latestConfig?.openaiTtsSpeed, 1.25);
	assert.equal(latestConfig?.sapiVoice, "Dedicated SAPI Voice");
	assert.equal(latestConfig?.sapiRate, 4);
});

test("permission reminders use the permission-specific reminder interval", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness({
		reminderDelaySeconds: 1,
		reminderIntervals: {
			...structuredClone(DEFAULT_CONFIG.reminderIntervals),
			defaultSeconds: 1,
			permissionSeconds: 3,
		},
	});

	await emitSessionStart(pi, ctx);
	await emitPermissionWait(pi, "permission-reminder-delay", { toolCallId: "call-permission-reminder-delay", toolName: "write_file" });
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assertSingleImmediateNotification(ttsCalls);
	assert.equal(countReminderCalls(ttsCalls), 0);

	await tickAndFlush(2_999);
	assert.equal(countReminderCalls(ttsCalls), 0);

	await tickAndFlush(1);
	assert.equal(countReminderCalls(ttsCalls), 1);
});

interface TestHarness {
	ctx: FakeContext;
	forwardingWatcher: FakePermissionForwardingWatcher;
	pi: FakePi;
	ttsCalls: SpeakCall[];
}

/**
 * Base test setup: disable focus detection, enable mock clock, create a
 * harness with the given config overrides, and emit session_start.
 */
async function createTestHarness(
	t: TestContext,
	configOverrides: Partial<VoiceNotifyConfig> = {},
): Promise<TestHarness> {
	disableFocusDetection(t);
	useMockClock(t);
	const harness = createHarness(configOverrides);
	await emitSessionStart(harness.pi, harness.ctx);
	return harness;
}

/**
 * Standard permission-notification test setup: default harness with session_start.
 */
async function setupPermissionTest(t: TestContext): Promise<TestHarness> {
	return createTestHarness(t);
}

/**
 * Forwarded-permission-watcher test setup: harness with the watcher enabled.
 */
async function setupForwardedPermissionTest(
	t: TestContext,
	configOverrides: Partial<VoiceNotifyConfig> = {},
): Promise<TestHarness> {
	return createTestHarness(t, {
		enableForwardedPermissionWatcher: true,
		...configOverrides,
	});
}

test("blocked tool_call events do not trigger permission notifications without permission-system waiting state", async (t) => {
	const { ctx, pi, ttsCalls } = await setupPermissionTest(t);

	await pi.emit("tool_call", permissionEvent("call-no-authoritative-wait"), ctx);
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assertNoNotifications(ttsCalls);
});

test("permission-looking tool_result errors do not trigger permission notifications without permission-system waiting state", async (t) => {
	const { ctx, pi, ttsCalls } = await setupPermissionTest(t);

	await emitToolResult(pi, ctx, {
		toolCallId: "result-no-authoritative-wait",
		toolName: "permission_guard",
		isError: true,
		text: "Requires approval from the user before continuing.",
	});
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assertNoNotifications(ttsCalls);
});

test("permission-system waiting events trigger a permission notification and cancel on resolution", async (t) => {
	const { ctx, pi, ttsCalls } = await setupPermissionTest(t);

	await emitPermissionWait(pi, "permission-wait", { toolCallId: "call-wait", toolName: "write_file" });
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assertSingleImmediateNotification(ttsCalls);

	await emitPermissionResolve(pi, "permission-wait", "approved", { toolCallId: "call-wait", toolName: "write_file" });
	await tickAndFlush(1_000);

	assert.equal(countReminderCalls(ttsCalls), 0);
});

test("resolved permission does not suppress a subsequent waiting event with the same toolCallId", async (t) => {
	const { ctx, pi, ttsCalls } = await setupPermissionTest(t);

	// First permission request — waiting, then resolved
	await emitPermissionWait(pi, "request-1", { toolCallId: "call-retry", toolName: "write_file" });
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	assert.equal(immediateNotificationCalls(ttsCalls).length, 1, "first waiting event should notify");

	await emitPermissionResolve(pi, "request-1", "approved", { toolCallId: "call-retry", toolName: "write_file" });

	// Second permission request with the SAME toolCallId — simulates the agent
	// retrying the same tool call after a prior approval/denial
	await emitPermissionWait(pi, "request-2", { toolCallId: "call-retry", toolName: "write_file" });
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 2, "second waiting event with same toolCallId must notify");
});

test("resolved permission does not suppress a subsequent waiting event with the same requestId (no toolCallId)", async (t) => {
	const { pi, ttsCalls } = await setupPermissionTest(t);

	const emitWaiting = (): void => {
		pi.events.emit(
			PERMISSION_SYSTEM_EVENT_CHANNEL,
			permissionSystemEvent("waiting", "request-same"),
		);
	};

	emitWaiting();
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	assert.equal(immediateNotificationCalls(ttsCalls).length, 1, "first waiting event should notify");

	await emitPermissionResolve(pi, "request-same", "denied");

	emitWaiting();
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 2, "second waiting event with same requestId must notify");
});

test("resolved forwarded permission does not suppress a subsequent forwarded request with the same requestId", async (t) => {
	const { forwardingWatcher, pi, ttsCalls } = await setupForwardedPermissionTest(t);

	const emitForwardedRequest = (): void => {
		forwardingWatcher.emitRequest(forwardedPermissionRequest("forwarded-retry", "Builder Beta"));
	};

	emitForwardedRequest();
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	assert.equal(immediateNotificationCalls(ttsCalls).length, 1, "first forwarded request should notify");

	forwardingWatcher.emitResolve(forwardedPermissionResolution("forwarded-retry"));
	await flushAsyncWork();

	emitForwardedRequest();
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 2, "second forwarded request with same requestId must notify");
});

test("permission-system waiting events do not duplicate a later blocked tool_call notification", async (t) => {
	const { ctx, pi, ttsCalls } = await setupPermissionTest(t);

	await emitPermissionWait(pi, "permission-dedupe", { toolCallId: "call-dedupe", toolName: "write_file" });
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	assertSingleImmediateNotification(ttsCalls);

	await pi.emit("tool_call", permissionEvent("call-dedupe"), ctx);
	await flushAsyncWork();

	assertSingleImmediateNotification(ttsCalls);
});

/**
 * Assert that exactly one active (non-aborted) reminder call exists.
 */
function assertSingleActiveReminder(calls: SpeakCall[]): SpeakCall {
	const activeReminderCalls = reminderCalls(calls);
	assert.equal(activeReminderCalls.length, 1);
	assert.equal(activeReminderCalls[0]?.aborted, false);
	return activeReminderCalls[0];
}

test("tool_execution_start only cancels the resolved permission reminder flow", async (t) => {
	const { ctx, pi, ttsCalls } = await setupPermissionTest(t);

	await emitPermissionWait(pi, "permission-call-a", { toolCallId: "call-a", toolName: "write_file" });
	await emitPermissionWait(pi, "permission-call-b", { toolCallId: "call-b", toolName: "write_file" });

	assert.equal(countReminderCalls(ttsCalls), 0);

	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	await tickAndFlush(1_000);
	const activeReminder = assertSingleActiveReminder(ttsCalls);

	await pi.emit("tool_execution_start", { toolCallId: "call-a", toolName: "write_file" }, ctx);
	await flushAsyncWork();
	assert.equal(activeReminder.aborted, true);

	await flushAsyncWork();
	const remainingReminderCalls = reminderCalls(ttsCalls);
	assert.equal(remainingReminderCalls.length, 2);
	assert.equal(remainingReminderCalls[1]?.aborted, false);

	await pi.emit("tool_execution_start", { toolCallId: "call-b", toolName: "write_file" }, ctx);
	await flushAsyncWork();
	assert.equal(remainingReminderCalls[1]?.aborted, true);
});

test("tool_result resolution keeps another permission reminder active while dropping the resolved queued flow", async (t) => {
	const { ctx, pi, ttsCalls } = await setupPermissionTest(t);

	await emitPermissionWait(pi, "permission-result-call-a", { toolCallId: "call-a", toolName: "write_file" });
	await emitPermissionWait(pi, "permission-result-call-b", { toolCallId: "call-b", toolName: "write_file" });
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	await tickAndFlush(1_000);

	const pendingReminderCalls = reminderCalls(ttsCalls);
	assert.equal(pendingReminderCalls.length, 1);
	assert.equal(pendingReminderCalls[0]?.aborted, false);

	await pi.emit("tool_result", { toolCallId: "call-b", toolName: "write_file", isError: false, content: [] }, ctx);
	await flushAsyncWork();
	assert.equal(pendingReminderCalls[0]?.aborted, false);

	pendingReminderCalls[0]?.complete(true);
	await flushAsyncWork();
	await flushAsyncWork();

	assert.equal(countReminderCalls(ttsCalls), 1);
});

test("tool_result errors resolve permission flows without error notifications while the agent can continue", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness({
		enableErrorNotification: true,
	});

	await emitSessionStart(pi, ctx);
	await emitPermissionWait(pi, "permission-shared", { toolCallId: "call-shared", toolName: "write_file" });
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	assertSingleImmediateNotification(ttsCalls);

	await emitToolResult(pi, ctx, {
		toolCallId: "call-shared",
		toolName: "write_file",
		isError: true,
		text: "Write failed because the destination disk is full.",
	});

	assertSingleImmediateNotification(ttsCalls);
});

/**
 * Setup for agent_end error notification tests: harness with error
 * notifications enabled, set hasPendingMessages callback, emit session_start,
 * then emit an agent_end error.
 */
async function setupAgentEndErrorTest(
	t: TestContext,
	errorMessage: string,
	hasPendingMessages: () => boolean,
): Promise<{
	ctx: FakeContext;
	pi: FakePi;
	ttsCalls: SpeakCall[];
}> {
	const harness = await createTestHarness(t, {
		enableErrorNotification: true,
		reminderEnabled: false,
	});
	harness.ctx.hasPendingMessages = hasPendingMessages;
	await emitAgentEndError(harness.pi, harness.ctx, errorMessage);
	return harness;
}

test("agent_end error is suppressed when continuation messages are pending", async (t) => {
	let hasPendingMessages = true;
	const { ctx, pi, ttsCalls } = await setupAgentEndErrorTest(
		t,
		"bash tool failed; retry queued",
		() => hasPendingMessages,
	);
	await tickAndFlush(10_000);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 0);

	hasPendingMessages = false;
	await pi.emit("agent_start", {}, ctx);
	await flushAsyncWork();
	assert.equal(immediateNotificationCalls(ttsCalls).length, 0);
});

test("agent_end error still notifies when no continuation messages are pending", async (t) => {
	const { pi, ttsCalls } = await setupAgentEndErrorTest(
		t,
		"terminal failure",
		() => false,
	);
	await tickAndFlush(10_000);

	const calls = immediateNotificationCalls(ttsCalls);
	assert.equal(calls.length, 1);
	assert.match(calls[0]?.text ?? "", /terminal failure/);
});

/**
 * Setup for single-notification tests: harness with a specific notification
 * type enabled and reminders disabled, then emit session_start.
 */
async function setupSingleNotificationTest(
	t: TestContext,
	configOverrides: Partial<VoiceNotifyConfig>,
): Promise<{
	ctx: FakeContext;
	pi: FakePi;
	ttsCalls: SpeakCall[];
}> {
	return createTestHarness(t, {
		reminderEnabled: false,
		...configOverrides,
	});
}

test("agent_end triggers an idle notification when idle notifications are enabled", async (t) => {
	const { ctx, pi, ttsCalls } = await setupSingleNotificationTest(t, {
		enableIdleNotification: true,
	});

	await pi.emit("agent_end", {}, ctx);
	await flushAsyncWork();

	assertSingleNotificationNoReminder(ttsCalls);
});

test("question-classified tool_result triggers a question notification when the question tool is available", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness({
		enableQuestionNotification: true,
		reminderEnabled: false,
	});
	pi.setAvailableTools([{ name: "question" }]);

	await emitSessionStart(pi, ctx);
	await emitToolResult(pi, ctx, {
		toolCallId: "call-question-available",
		toolName: "custom_tool",
		text: "This request requires your input before continuing.",
	});

	assertSingleNotificationNoReminder(ttsCalls);
});

test("question-classified tool_result does not notify when the question tool is unavailable", async (t) => {
	const { ctx, pi, ttsCalls } = await setupSingleNotificationTest(t, {
		enableQuestionNotification: true,
	});

	await emitToolResult(pi, ctx, {
		toolCallId: "call-question-unavailable",
		toolName: "custom_tool",
		text: "This request requires your input before continuing.",
	});

	assertNoNotifications(ttsCalls);
});

test("forwarded permission resolution cancels a queued reminder before it fires", async (t) => {
	const { forwardingWatcher, pi, ttsCalls } = await setupForwardedPermissionTest(t, {
		includeForwardedPermissionAgentName: true,
	});

	forwardingWatcher.emitRequest(forwardedPermissionRequest("forwarded-queued", "Builder Beta"));
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	const initialCalls = immediateNotificationCalls(ttsCalls);
	assert.equal(initialCalls.length, 1);
	assert.match(initialCalls[0]?.text ?? "", /builder beta/i);

	forwardingWatcher.emitResolve(forwardedPermissionResolution("forwarded-queued"));
	await flushAsyncWork();
	await tickAndFlush(1_000);

	assert.equal(countReminderCalls(ttsCalls), 0);
});

test("forwarded permission resolution aborts active reminder playback for that request", async (t) => {
	const { forwardingWatcher, pi, ttsCalls } = await setupForwardedPermissionTest(t);

	forwardingWatcher.emitRequest(forwardedPermissionRequest("forwarded-active"));
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	await tickAndFlush(1_000);

	const activeReminder = assertSingleActiveReminder(ttsCalls);

	forwardingWatcher.emitResolve(forwardedPermissionResolution("forwarded-active"));
	await flushAsyncWork();

	assert.equal(activeReminder.aborted, true);
});

test("session_start reads project config using ctx.cwd", async () => {
	const seenProjectRoots: Array<string | undefined> = [];
	const pi = new FakePi();
	const { service } = createControlledTTSService();

	smartVoiceNotifyExtension(pi as unknown as ExtensionAPI, {
		readConfigFromDisk: (projectRoot?: string) => {
			seenProjectRoots.push(projectRoot);
			return createTestConfig({});
		},
		initializeTTSService: () => service,
		createPermissionForwardingWatcher: (options) => createFakePermissionForwardingWatcher(options),
	});

	await pi.emit("session_start", { reason: "startup" }, { hasUI: false, cwd: "/repo" });

	assert.ok(
		seenProjectRoots.includes("/repo"),
		`expected readConfig to be called with ctx.cwd; saw ${JSON.stringify(seenProjectRoots)}`,
	);
});

/**
 * Build a UI-capable context that records `ctx.ui.setStatus` calls so the
 * status bar indicator wiring can be asserted. The shared harness returns a
 * headless ctx (hasUI: false), which would make updateStatus a no-op.
 */
function createStatusRecordingContext(): { ctx: FakeContext; statusCalls: Array<[string, string | undefined]> } {
	const statusCalls: Array<[string, string | undefined]> = [];
	const ctx: FakeContext = {
		hasUI: true,
		ui: {
			setStatus: (key: string, text: string | undefined): void => {
				statusCalls.push([key, text]);
			},
			notify: (): void => {
			},
		},
	};
	return { ctx, statusCalls };
}

test("session_start renders the voice status indicator when showStatusBar is enabled", async () => {
	const { pi } = createHarness({ showStatusBar: true });
	const { ctx, statusCalls } = createStatusRecordingContext();

	await emitSessionStart(pi, ctx);

	assert.equal(statusCalls.length, 1);
	assert.equal(statusCalls[0]?.[0], STATUS_KEY);
	assert.match(statusCalls[0]?.[1] ?? "", /^voice:/);
});

test("session_start clears the status indicator when showStatusBar is disabled", async () => {
	const { pi } = createHarness({ showStatusBar: false });
	const { ctx, statusCalls } = createStatusRecordingContext();

	await emitSessionStart(pi, ctx);

	assert.equal(statusCalls.length, 1);
	assert.equal(statusCalls[0]?.[0], STATUS_KEY);
	assert.equal(statusCalls[0]?.[1], undefined);
});

test("statusLine hides the indicator whenever showStatusBar is off", () => {
	assert.equal(statusLine(createTestConfig({ showStatusBar: false })), undefined);
	// Hiding must win over the disabled state too, otherwise a disabled extension
	// would keep rendering "voice:off" against the user's wish.
	assert.equal(statusLine(createTestConfig({ showStatusBar: false, enabled: false })), undefined);
});

test("statusLine reports voice:off when the extension is disabled but showStatusBar is on", () => {
	assert.equal(statusLine(createTestConfig({ showStatusBar: true, enabled: false })), "voice:off");
});

test("statusLine summarizes the active channels when enabled", () => {
	assert.equal(
		statusLine(
			createTestConfig({
				showStatusBar: true,
				enabled: true,
				notificationMode: "sound-first",
				enableSound: true,
				enableTts: false,
				enableDesktopNotification: false,
			}),
		),
		"voice:sound-first snd no-tts no-toast",
	);
});

test("settings modal exposes the showStatusBar toggle and applies it", () => {
	const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf-8");
	// Contract guard: the modal item id, the applySetting case, and the toggle
	// must stay wired together or the setting becomes unreachable from the UI.
	assert.match(source, /id: "showStatusBar"/);
	assert.match(source, /case "showStatusBar":\s*\n\s*draft\.showStatusBar = boolValue\(value\)/);
});
