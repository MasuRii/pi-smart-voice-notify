import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG } from "../src/config-store.ts";
import smartVoiceNotifyExtension, { type SmartVoiceNotifyDependencies } from "../src/index.ts";
import type { TTSAvailability, TTSConfig, TTSEngine, TTSService, SpeakOptions } from "../src/types/tts.ts";
import type { VoiceNotifyConfig } from "../src/types.ts";

interface FakeContext {
	hasUI: boolean;
	cwd?: string;
	hasPendingMessages?: () => boolean;
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

const PERMISSION_SYSTEM_EVENT_CHANNEL = "pi-permission-system:permission-request";
const PERMISSION_BATCH_WINDOW_MS = 800;

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

	public async exec(): Promise<never> {
		throw new Error("Unexpected exec invocation in pi-smart-voice-notify index test");
	}

	public async emit(eventName: string, event: unknown, ctx: FakeContext): Promise<void> {
		for (const handler of this.handlers.get(eventName) ?? []) {
			await handler(event, ctx);
		}
	}
}

class FakePermissionForwardingWatcher implements PermissionForwardingWatcherController {
	private readonly onRequest: PermissionForwardingWatcherOptions["onRequest"];
	private readonly onResolve: PermissionForwardingWatcherOptions["onResolve"];

	public currentConfig: PermissionForwardingWatcherConfig | null = null;

	public constructor(options: PermissionForwardingWatcherOptions) {
		this.onRequest = options.onRequest;
		this.onResolve = options.onResolve;
	}

	public start(config: PermissionForwardingWatcherConfig): void {
		this.currentConfig = config;
	}

	public updateConfig(config: PermissionForwardingWatcherConfig): void {
		this.currentConfig = config;
	}

	public stop(): void {
		this.currentConfig = null;
	}

	public emitRequest(event: ForwardedPermissionRequestEvent): void {
		this.onRequest(event);
	}

	public emitResolve(event: ForwardedPermissionResolutionEvent): void {
		this.onResolve(event);
	}
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
		async speak(text: string, _engine: TTSEngine = "auto", options: SpeakOptions = {}): Promise<boolean> {
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
		async detectAvailableEngines(): Promise<TTSAvailability> {
			return EMPTY_AVAILABILITY;
		},
		getAvailableEngines(): Readonly<TTSAvailability> {
			return EMPTY_AVAILABILITY;
		},
		getConfig(): Readonly<TTSConfig> {
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
			forwardingWatcher = new FakePermissionForwardingWatcher(options);
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

function permissionEvent(toolCallId: string): { block: boolean; reason: string; toolCallId: string; toolName: string } {
	return {
		block: true,
		reason: "Requires approval from the user before continuing.",
		toolCallId,
		toolName: "write_file",
	};
}

function permissionSystemEvent(
	state: "waiting" | "approved" | "denied",
	requestId: string,
	overrides: Partial<{
		source: "tool_call" | "skill_input" | "skill_read";
		message: string;
		toolCallId: string;
		toolName: string;
		skillName: string;
		path: string;
		agentName: string | null;
	}> = {},
): Record<string, unknown> {
	return {
		requestId,
		state,
		source: overrides.source ?? "tool_call",
		message: overrides.message ?? "Current agent requested tool 'write'. Allow this call?",
		toolCallId: overrides.toolCallId,
		toolName: overrides.toolName,
		skillName: overrides.skillName,
		path: overrides.path,
		agentName: overrides.agentName ?? null,
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

function countReminderCalls(calls: SpeakCall[]): number {
	return calls.filter((call) => call.signal).length;
}

function immediateNotificationCalls(calls: SpeakCall[]): SpeakCall[] {
	return calls.filter((call) => !call.signal);
}

function reminderCalls(calls: SpeakCall[]): SpeakCall[] {
	return calls.filter((call) => call.signal);
}

function setFocusDetection(t: TestContext, value: "0" | "1"): void {
	const previousFocusDetection = process.env.PI_SMART_NOTIFY_FOCUS_DETECTION;
	process.env.PI_SMART_NOTIFY_FOCUS_DETECTION = value;
	t.after(() => {
		if (previousFocusDetection === undefined) {
			delete process.env.PI_SMART_NOTIFY_FOCUS_DETECTION;
			return;
		}
		process.env.PI_SMART_NOTIFY_FOCUS_DETECTION = previousFocusDetection;
	});
}

function disableFocusDetection(t: TestContext): void {
	setFocusDetection(t, "0");
}

function enableFocusDetection(t: TestContext): void {
	setFocusDetection(t, "1");
}

function useMockClock(t: TestContext): void {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	mock.timers.setTime(1_000);
	t.after(() => mock.timers.reset());
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

async function tickAndFlush(milliseconds: number): Promise<void> {
	mock.timers.tick(milliseconds);
	await flushAsyncWork();
	await flushAsyncWork();
}

test("skipWhenFocused=false still notifies even when the terminal is focused", async (t) => {
	enableFocusDetection(t);
	useMockClock(t);

	const focusChecks: Array<{ cacheTtlMs?: number }> = [];
	const { ctx, pi, ttsCalls } = createHarness(
		{
			skipWhenFocused: false,
			focusCacheTtlMs: 975,
		},
		{
			isTerminalFocused: async (options) => {
				focusChecks.push({ cacheTtlMs: options.cacheTtlMs });
				return true;
			},
		},
	);

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-focus-disabled", {
			toolCallId: "call-focus-disabled",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);
	assert.equal(focusChecks.length, 0);
});

test("skipWhenFocused=true suppresses focused notifications and uses config focus cache ttl", async (t) => {
	enableFocusDetection(t);
	useMockClock(t);

	const focusChecks: Array<{ cacheTtlMs?: number }> = [];
	const { ctx, pi, ttsCalls } = createHarness(
		{
			skipWhenFocused: true,
			focusCacheTtlMs: 975,
		},
		{
			isTerminalFocused: async (options) => {
				focusChecks.push({ cacheTtlMs: options.cacheTtlMs });
				return true;
			},
		},
	);

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-focus-enabled", {
			toolCallId: "call-focus-enabled",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
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

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();

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

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-reminder-delay", {
			toolCallId: "call-permission-reminder-delay",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);
	assert.equal(countReminderCalls(ttsCalls), 0);

	await tickAndFlush(2_999);
	assert.equal(countReminderCalls(ttsCalls), 0);

	await tickAndFlush(1);
	assert.equal(countReminderCalls(ttsCalls), 1);
});

test("blocked tool_call events do not trigger permission notifications without permission-system waiting state", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness();

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	await pi.emit("tool_call", permissionEvent("call-no-authoritative-wait"), ctx);
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 0);
	assert.equal(countReminderCalls(ttsCalls), 0);
});

test("permission-looking tool_result errors do not trigger permission notifications without permission-system waiting state", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness();

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	await pi.emit(
		"tool_result",
		{
			toolCallId: "result-no-authoritative-wait",
			toolName: "permission_guard",
			isError: true,
			content: [{ type: "text", text: "Requires approval from the user before continuing." }],
		},
		ctx,
	);
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 0);
	assert.equal(countReminderCalls(ttsCalls), 0);
});

test("permission-system waiting events trigger a permission notification and cancel on resolution", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness();

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-wait", {
			toolCallId: "call-wait",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);

	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("approved", "permission-wait", {
			toolCallId: "call-wait",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
	await tickAndFlush(1_000);

	assert.equal(countReminderCalls(ttsCalls), 0);
});

test("permission-system waiting events do not duplicate a later blocked tool_call notification", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness();

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-dedupe", {
			toolCallId: "call-dedupe",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);

	await pi.emit("tool_call", permissionEvent("call-dedupe"), ctx);
	await flushAsyncWork();

	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);
});

test("tool_execution_start only cancels the resolved permission reminder flow", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness();

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-call-a", {
			toolCallId: "call-a",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-call-b", {
			toolCallId: "call-b",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();

	assert.equal(countReminderCalls(ttsCalls), 0);

	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	await tickAndFlush(1_000);
	const activeReminderCalls = reminderCalls(ttsCalls);
	assert.equal(activeReminderCalls.length, 1);
	assert.equal(activeReminderCalls[0]?.aborted, false);

	await pi.emit("tool_execution_start", { toolCallId: "call-a", toolName: "write_file" }, ctx);
	await flushAsyncWork();
	assert.equal(activeReminderCalls[0]?.aborted, true);

	await flushAsyncWork();
	const remainingReminderCalls = reminderCalls(ttsCalls);
	assert.equal(remainingReminderCalls.length, 2);
	assert.equal(remainingReminderCalls[1]?.aborted, false);

	await pi.emit("tool_execution_start", { toolCallId: "call-b", toolName: "write_file" }, ctx);
	await flushAsyncWork();
	assert.equal(remainingReminderCalls[1]?.aborted, true);
});

test("tool_result resolution keeps another permission reminder active while dropping the resolved queued flow", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness();

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-result-call-a", {
			toolCallId: "call-a",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-result-call-b", {
			toolCallId: "call-b",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
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

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-shared", {
			toolCallId: "call-shared",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);

	await pi.emit(
		"tool_result",
		{
			toolCallId: "call-shared",
			toolName: "write_file",
			isError: true,
			content: [{ type: "text", text: "Write failed because the destination disk is full." }],
		},
		ctx,
	);
	await flushAsyncWork();

	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);
});

test("agent_end error is suppressed when continuation messages are pending", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	let hasPendingMessages = true;
	const { ctx, pi, ttsCalls } = createHarness({
		enableErrorNotification: true,
		reminderEnabled: false,
	});
	ctx.hasPendingMessages = () => hasPendingMessages;

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	await pi.emit(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "bash tool failed; retry queued",
				},
			],
		},
		ctx,
	);
	await flushAsyncWork();
	await tickAndFlush(10_000);

	assert.equal(immediateNotificationCalls(ttsCalls).length, 0);

	hasPendingMessages = false;
	await pi.emit("agent_start", {}, ctx);
	await flushAsyncWork();
	assert.equal(immediateNotificationCalls(ttsCalls).length, 0);
});

test("agent_end error still notifies when no continuation messages are pending", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness({
		enableErrorNotification: true,
		reminderEnabled: false,
	});
	ctx.hasPendingMessages = () => false;

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	await pi.emit(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "terminal failure",
				},
			],
		},
		ctx,
	);
	await flushAsyncWork();
	await tickAndFlush(10_000);

	const calls = immediateNotificationCalls(ttsCalls);
	assert.equal(calls.length, 1);
	assert.match(calls[0]?.text ?? "", /terminal failure/);
});

test("agent_end triggers an idle notification when idle notifications are enabled", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness({
		enableIdleNotification: true,
		reminderEnabled: false,
	});

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	await pi.emit("agent_end", {}, ctx);
	await flushAsyncWork();

	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);
	assert.equal(countReminderCalls(ttsCalls), 0);
});

test("question-classified tool_result triggers a question notification when the question tool is available", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness({
		enableQuestionNotification: true,
		reminderEnabled: false,
	});
	pi.setAvailableTools([{ name: "question" }]);

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	await pi.emit(
		"tool_result",
		{
			toolCallId: "call-question-available",
			toolName: "custom_tool",
			isError: false,
			content: [{ type: "text", text: "This request requires your input before continuing." }],
		},
		ctx,
	);
	await flushAsyncWork();

	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);
	assert.equal(countReminderCalls(ttsCalls), 0);
});

test("question-classified tool_result does not notify when the question tool is unavailable", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness({
		enableQuestionNotification: true,
		reminderEnabled: false,
	});

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	await pi.emit(
		"tool_result",
		{
			toolCallId: "call-question-unavailable",
			toolName: "custom_tool",
			isError: false,
			content: [{ type: "text", text: "This request requires your input before continuing." }],
		},
		ctx,
	);
	await flushAsyncWork();

	assert.equal(immediateNotificationCalls(ttsCalls).length, 0);
	assert.equal(countReminderCalls(ttsCalls), 0);
});

test("forwarded permission resolution cancels a queued reminder before it fires", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, forwardingWatcher, pi, ttsCalls } = createHarness({
		enableForwardedPermissionWatcher: true,
		includeForwardedPermissionAgentName: true,
	});

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
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
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, forwardingWatcher, pi, ttsCalls } = createHarness({
		enableForwardedPermissionWatcher: true,
	});

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	forwardingWatcher.emitRequest(forwardedPermissionRequest("forwarded-active"));
	await flushAsyncWork();
	await tickAndFlush(PERMISSION_BATCH_WINDOW_MS);
	await tickAndFlush(1_000);

	const activeReminderCalls = reminderCalls(ttsCalls);
	assert.equal(activeReminderCalls.length, 1);
	assert.equal(activeReminderCalls[0]?.aborted, false);

	forwardingWatcher.emitResolve(forwardedPermissionResolution("forwarded-active"));
	await flushAsyncWork();

	assert.equal(activeReminderCalls[0]?.aborted, true);
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
		createPermissionForwardingWatcher: (options) => new FakePermissionForwardingWatcher(options),
	});

	await pi.emit("session_start", { reason: "startup" }, { hasUI: false, cwd: "/repo" });

	assert.ok(
		seenProjectRoots.includes("/repo"),
		`expected readConfig to be called with ctx.cwd; saw ${JSON.stringify(seenProjectRoots)}`,
	);
});
