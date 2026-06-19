import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { basename } from "node:path";

import type { AIMessageConfig, AIMessageService } from "./ai-messages.ts";
import {
	BOOLEAN_VALUES,
	clampInt,
	CONFIG_PATH,
	DEBUG_LOG_PATH,
	DEFAULT_CONFIG,
	EXTENSION_ID,
	INLINE_NOTIFY_TEXT,
	isNotificationEnabled,
	isWindows,
	MESSAGE_LIBRARY,
	normalizeConfig,
	QUESTION_HINTS,
	readConfigFromDisk,
	SOUND_LOOPS,
	STATUS_KEY,
	summarizeConfig,
	toRecord,
	TTS_ENGINE_VALUES,
	writeConfigToDisk,
	boolValue,
	ensureDebugDirectory,
} from "./config-store.ts";
import type { FocusDetectOptions } from "./focus-detect.ts";
import { createExtensionLogger, getErrorMessage } from "./logging.ts";
import type { AudioNotificationService } from "./notify-audio.ts";
import type {
	PermissionForwardingWatcherConfig,
	PermissionForwardingWatcherOptions,
} from "./permission-forwarding-watcher.ts";
import { ReminderPlaybackController } from "./reminder-playback.ts";
import type { SoundThemeConfig, SoundThemeService } from "./sound-theme.ts";
import type {
	NotificationType,
	NotifyLevel,
	ReminderState,
	VoiceNotifyConfig,
} from "./types.ts";
import type { TTSConfig, TTSService, TTSServiceOptions } from "./types/tts.ts";
import type { WebhookConfig, WebhookService } from "./webhook.ts";

type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

function pickRandom<T>(items: readonly T[]): T {
	const index = Math.floor(Math.random() * items.length);
	return items[index] ?? items[0];
}

function getSessionStartReason(event: object): SessionStartReason | undefined {
	if (!("reason" in event)) {
		return undefined;
	}

	const { reason } = event;
	if (
		reason === "startup"
		|| reason === "reload"
		|| reason === "new"
		|| reason === "resume"
		|| reason === "fork"
	) {
		return reason;
	}

	return undefined;
}

function getPreviousSessionFile(event: object): string | undefined {
	if (!("previousSessionFile" in event) || typeof event.previousSessionFile !== "string") {
		return undefined;
	}

	return event.previousSessionFile;
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const record = item as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			parts.push(record.text);
		}
	}
	return parts.join("\n");
}

function classifyToolResult(
	toolName: string,
	isError: boolean,
	textContent: string,
): NotificationType | null {
	const normalizedTool = toolName.toLowerCase();
	const normalizedText = textContent.toLowerCase().slice(0, 800);

	if (normalizedTool.includes("question")) {
		return "question";
	}
	// Tool errors are often recoverable within the same turn; terminal failures are handled at agent_end.
	if (!isError && QUESTION_HINTS.some((hint) => normalizedText.includes(hint))) {
		return "question";
	}

	return null;
}

type AgentEndStatus = "completed" | "error" | "aborted";

interface AgentEndOutcome {
	status: AgentEndStatus;
	reason?: string;
}

function readAgentEndOutcome(event: unknown): AgentEndOutcome {
	const messages = toRecord(event).messages;
	if (!Array.isArray(messages)) {
		return { status: "completed" };
	}

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = toRecord(messages[index]);
		if (message.role !== "assistant") {
			continue;
		}

		const stopReason = normalizeOptionalString(message.stopReason);
		const errorMessage = normalizeOptionalString(message.errorMessage);
		if (stopReason === "error") {
			return { status: "error", reason: errorMessage ?? extractTextContent(message.content) };
		}
		if (stopReason === "aborted") {
			return { status: "aborted", reason: errorMessage };
		}
		if (errorMessage) {
			return { status: "error", reason: errorMessage };
		}

		return { status: "completed" };
	}

	return { status: "completed" };
}

function formatAgentErrorNotification(reason: string | undefined): string {
	const normalizedReason = reason?.replace(/\s+/g, " ").trim();
	if (!normalizedReason) {
		return "❌ Agent ended with an error. Check the latest output before continuing.";
	}

	return `❌ Agent ended with an error: ${normalizedReason.slice(0, 160)}`;
}

function hasPendingAgentMessages(ctx: ExtensionContext): boolean {
	try {
		return ctx.hasPendingMessages();
	} catch {
		return false;
	}
}

function statusLine(config: VoiceNotifyConfig): string | undefined {
	if (!config.enabled) {
		return "voice:off";
	}

	const bits = [
		`voice:${config.notificationMode}`,
		config.enableSound ? "snd" : "no-snd",
		config.enableTts ? "tts" : "no-tts",
		config.enableDesktopNotification ? "toast" : "no-toast",
	];
	return bits.join(" ");
}

function queueTask(task: Promise<void>, onError: (error: unknown) => void): void {
	void task.catch(onError);
}

function envString(...keys: string[]): string {
	for (const key of keys) {
		const value = process.env[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return "";
}

function envBoolean(defaultValue: boolean, ...keys: string[]): boolean {
	const raw = envString(...keys).toLowerCase();
	if (!raw) {
		return defaultValue;
	}
	if (["1", "true", "yes", "on"].includes(raw)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(raw)) {
		return false;
	}
	return defaultValue;
}

function envInteger(defaultValue: number, ...keys: string[]): number {
	const raw = envString(...keys);
	if (!raw) {
		return defaultValue;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

function normalizePermissionForwardingSessionId(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === "unknown") {
		return null;
	}
	return trimmed;
}

function getPermissionForwardingSessionId(ctx: ExtensionContext): string | null {
	try {
		const sessionManager = "sessionManager" in ctx
			? ctx.sessionManager as { getSessionId?: () => unknown }
			: null;
		return normalizePermissionForwardingSessionId(sessionManager?.getSessionId?.());
	} catch {
		return null;
	}
}

function sanitizeAgentName(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.replace(/[^a-zA-Z0-9._ -]/g, "").trim().replace(/\s+/g, " ");
	if (normalized.length === 0) {
		return null;
	}
	return normalized.slice(0, 48);
}

function forwardedPermissionNotificationText(agentName: string | null, includeAgentName: boolean): string {
	const baseMessage = "A subagent permission request is waiting for your approval.";
	if (!includeAgentName) {
		return baseMessage;
	}

	const sanitized = sanitizeAgentName(agentName);
	if (!sanitized) {
		return baseMessage;
	}
	return `${baseMessage} Agent: ${sanitized}.`;
}

const REMINDER_EVENT_TYPE: Record<NotificationType, string> = {
	idle: "idleReminder",
	permission: "permissionReminder",
	question: "questionReminder",
	error: "errorReminder",
};

type ReminderKey = string;
type FocusDetector = (options?: FocusDetectOptions) => Promise<boolean>;

type PermissionForwardingWatcherController = {
	start(config: PermissionForwardingWatcherConfig): void;
	updateConfig(config: PermissionForwardingWatcherConfig): void;
	stop(): void;
};

export interface SmartVoiceNotifyDependencies {
	readConfigFromDisk?: typeof readConfigFromDisk;
	initializeTTSService?: (options?: TTSServiceOptions) => TTSService;
	createPermissionForwardingWatcher?: (
		options: PermissionForwardingWatcherOptions,
	) => PermissionForwardingWatcherController;
	isTerminalFocused?: FocusDetector;
}

function defaultReminderKey(type: NotificationType): ReminderKey {
	return `${type}:default`;
}

function permissionReminderKey(toolCallId: string): ReminderKey {
	const normalizedToolCallId = toolCallId.trim();
	return normalizedToolCallId.length > 0
		? `permission:tool-call:${normalizedToolCallId}`
		: defaultReminderKey("permission");
}

function forwardedPermissionReminderKey(requestId: string): ReminderKey {
	const normalizedRequestId = requestId.trim();
	return normalizedRequestId.length > 0
		? `permission:forwarded:${normalizedRequestId}`
		: defaultReminderKey("permission");
}

const PERMISSION_SYSTEM_EVENT_CHANNEL = "pi-permission-system:permission-request";
type PermissionSystemEventState = "waiting" | "approved" | "denied";
type PermissionSystemEventSource = "tool_call" | "skill_input" | "skill_read";

interface PermissionSystemEvent {
	requestId: string;
	state: PermissionSystemEventState;
	source: PermissionSystemEventSource;
	message: string;
	toolCallId?: string;
	toolName?: string;
	skillName?: string;
	path?: string;
	agentName?: string | null;
}

function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readPermissionSystemEvent(value: unknown): PermissionSystemEvent | null {
	const record = toRecord(value);
	const requestId = normalizeOptionalString(record.requestId);
	const state = normalizeOptionalString(record.state);
	const source = normalizeOptionalString(record.source);
	const message = normalizeOptionalString(record.message);
	if (!requestId || !message) {
		return null;
	}
	if (state !== "waiting" && state !== "approved" && state !== "denied") {
		return null;
	}
	if (source !== "tool_call" && source !== "skill_input" && source !== "skill_read") {
		return null;
	}

	return {
		requestId,
		state,
		source,
		message,
		toolCallId: normalizeOptionalString(record.toolCallId),
		toolName: normalizeOptionalString(record.toolName),
		skillName: normalizeOptionalString(record.skillName),
		path: normalizeOptionalString(record.path),
		agentName: typeof record.agentName === "string" ? record.agentName : null,
	};
}

function permissionSystemReminderKey(event: PermissionSystemEvent): ReminderKey {
	if (event.toolCallId) {
		return permissionReminderKey(event.toolCallId);
	}

	return `permission:request:${event.requestId}`;
}

export default function smartVoiceNotifyExtension(
	pi: ExtensionAPI,
	dependencies: SmartVoiceNotifyDependencies = {},
): void {
	const readConfig = dependencies.readConfigFromDisk ?? readConfigFromDisk;
	const createInjectedTTSService = dependencies.initializeTTSService;
	let config = readConfig();
	let lastUserActivityAt = Date.now();
	let hadErrorInTurn = false;
	let warnedNonWindows = false;
	let warnedDesktopUnsupported = false;
	let audioQueue: Promise<void> = Promise.resolve();
	let questionToolAvailable = false;
	let activeSessionContext: ExtensionContext | null = null;
	let shutdownRequested = false;
	let shutdownPromise: Promise<void> | null = null;
	let pendingAgentErrorNotification: NodeJS.Timeout | null = null;

	const pendingReminders = new Map<ReminderKey, ReminderState>();
	const reminderPlayback = new ReminderPlaybackController();
	const pendingPermissionToolCallIds = new Set<string>();
	const processedToolResultToolCallIds = new Set<string>();
	const lastNotificationAt = new Map<NotificationType, number>();

	// Batch near-simultaneous permission requests so we don't spam sound/toasts when the agent
	// issues multiple tool calls that all require approval at once.
	const permissionBatchWindowMs = Math.max(0, envInteger(800, "PI_SMART_NOTIFY_PERMISSION_BATCH_WINDOW_MS"));
	let permissionBatchTimeout: NodeJS.Timeout | null = null;
	let permissionBatchContext: ExtensionContext | null = null;
	let permissionBatchGeneration = 0;
	type PermissionBatchEntry = { reminderKey: ReminderKey; reason?: string; customMessage?: string };
	const pendingPermissionBatch = new Map<ReminderKey, PermissionBatchEntry>();
	const resolvedPermissionBatchKeys = new Set<ReminderKey>();

	const logger = createExtensionLogger({
		extensionId: EXTENSION_ID,
		debugLogPath: DEBUG_LOG_PATH,
		isDebugEnabled: () => config.debugLog,
		ensureDebugDirectory,
	});

	let audioService: AudioNotificationService | null = null;
	let ttsService: TTSService | null = null;
	let aiMessageService: AIMessageService | null = null;
	let webhookService: WebhookService | null = null;
	let soundThemeService: SoundThemeService | null = null;
	let permissionForwardingWatcher: PermissionForwardingWatcherController | null = null;
	let focusModulePromise: Promise<typeof import("./focus-detect.ts")> | null = null;

	const projectName = basename(process.cwd()) || "project";
	const injectedTerminalFocusDetector = dependencies.isTerminalFocused;
	const focusDetectionEnabled = envBoolean(
		process.platform === "linux" || process.platform === "win32",
		"PI_SMART_NOTIFY_FOCUS_DETECTION",
	);
	const notifyWhenFocused = envBoolean(false, "PI_SMART_NOTIFY_NOTIFY_WHEN_FOCUSED");
	const focusTimeoutMs = Math.max(500, envInteger(1_500, "PI_SMART_NOTIFY_FOCUS_TIMEOUT_MS"));
	const agentErrorNotificationGraceMs = Math.max(
		0,
		envInteger(10_000, "PI_SMART_NOTIFY_AGENT_ERROR_GRACE_MS"),
	);
	const buildTTSServiceConfig = (): TTSConfig => {
		return {
			enableTts: config.enableTts,
			ttsEngine: config.ttsEngine,
			fallbackChain: [...config.fallbackChain],
			commandTimeoutMs: config.commandTimeoutMs,
			edgeVoice: config.edgeVoice,
			edgeRate: config.edgeRate,
			edgePitch: config.edgePitch,
			edgeVolume: config.edgeVolume,
			espeakVoice: config.espeakVoice,
			espeakRate: config.espeakRate,
			espeakPitch: config.espeakPitch,
			elevenLabsApiKey: config.elevenLabsApiKey,
			elevenLabsVoiceId: config.elevenLabsVoiceId,
			elevenLabsModel: config.elevenLabsModel,
			elevenLabsStability: config.elevenLabsStability,
			elevenLabsSimilarity: config.elevenLabsSimilarity,
			elevenLabsStyle: config.elevenLabsStyle,
			openaiTtsEndpoint: config.openaiTtsEndpoint,
			openaiTtsApiKey: config.openaiTtsApiKey,
			openaiTtsModel: config.openaiTtsModel,
			openaiTtsVoice: config.openaiTtsVoice,
			openaiTtsFormat: config.openaiTtsFormat,
			openaiTtsSpeed: config.openaiTtsSpeed,
			sapiVoice: config.sapiVoice,
			sapiRate: config.sapiRate,
		};
	};
	const buildAIMessageConfig = (): AIMessageConfig => {
		const aiSettings = config.aiMessages;
		return {
			enableAIMessages: aiSettings.enabled,
			aiEndpoint: aiSettings.endpoint,
			aiModel: aiSettings.model,
			aiApiKey: aiSettings.apiKey,
			aiTimeoutMs: aiSettings.timeoutMs,
			aiTemperature: aiSettings.temperature,
			aiMaxTokens: aiSettings.maxTokens,
			aiFallbackToTemplates: aiSettings.fallbackToTemplates,
			personality: aiSettings.personality,
			tone: aiSettings.tone,
			enableMessageCache: aiSettings.caching.enabled,
			messageCacheTtlMs: aiSettings.caching.ttlMs,
			maxCacheEntries: aiSettings.caching.maxEntries,
			templates: aiSettings.templates,
		};
	};
	const buildWebhookConfig = (): WebhookConfig => {
		return {
			enabled: config.webhook.enabled,
			discordWebhookUrl: config.webhook.discordUrl,
			genericWebhookUrl: config.webhook.genericUrl,
			eventAllowList: [...config.webhook.events],
			eventTriggers: {
				idle: config.enableIdleNotification,
				permission: config.enablePermissionNotification,
				question: config.enableQuestionNotification,
				error: config.enableErrorNotification,
			},
			minIntervalMs: config.webhook.minIntervalMs,
			maxRetries: config.webhook.maxRetries,
			requestTimeoutMs: config.webhook.requestTimeoutMs,
			discordUsername: config.webhook.username,
			logger: (message, details = {}) => {
				logger.debug(`webhook.${message}`, details);
			},
		};
	};
	const buildSoundThemeConfig = (): SoundThemeConfig => {
		const configuredCustomSoundDirectories = config.customSoundDirectories
			.map((value) => value.trim())
			.filter((value) => value.length > 0);
		const configuredSoundFiles: NonNullable<SoundThemeConfig["soundFiles"]> = {};
		const notificationSound = normalizeOptionalString(config.questionSoundFile);
		const successSound = normalizeOptionalString(config.idleSoundFile);
		const alertSound = normalizeOptionalString(config.permissionSoundFile);
		const errorSound = normalizeOptionalString(config.errorSoundFile);
		if (notificationSound) {
			configuredSoundFiles.notification = notificationSound;
		}
		if (successSound) {
			configuredSoundFiles.success = successSound;
		}
		if (alertSound) {
			configuredSoundFiles.alert = alertSound;
		}
		if (errorSound) {
			configuredSoundFiles.error = errorSound;
		}
		return {
			themeName: normalizeOptionalString(config.themeName),
			themeDirectory: normalizeOptionalString(config.themePath),
			themesRootDirectory: normalizeOptionalString(config.themesRootPath),
			themeConfigPath: normalizeOptionalString(config.themeConfigPath),
			projectCwd: process.cwd(),
			enablePerProjectSounds: config.enablePerProjectSounds,
			randomizeSounds: config.randomizeThemeSounds,
			defaultVolume: config.themeDefaultVolume,
			soundFiles: Object.keys(configuredSoundFiles).length > 0 ? configuredSoundFiles : undefined,
			customSoundDirectories: configuredCustomSoundDirectories.length > 0 ? configuredCustomSoundDirectories : undefined,
		};
	};
	const getAudioService = async (): Promise<AudioNotificationService> => {
		if (!audioService) {
			const { AudioNotificationService: AudioNotificationServiceCtor } = await import("./notify-audio.ts");
			audioService = new AudioNotificationServiceCtor({
				execRunner: pi,
				getConfig: () => config,
				debug: logger.debug,
			});
		}
		return audioService;
	};

	const getTTSService = async (): Promise<TTSService> => {
		if (!ttsService) {
			const createTTSService = createInjectedTTSService
				?? (await import("./tts.ts")).initializeTTSService;
			ttsService = createTTSService({
				execRunner: pi,
				config: buildTTSServiceConfig(),
				debug: logger.debug,
			});
		}
		return ttsService;
	};

	const getAIMessageService = async (): Promise<AIMessageService> => {
		if (!aiMessageService) {
			const { initializeAIMessageService } = await import("./ai-messages.ts");
			aiMessageService = initializeAIMessageService({
				config: buildAIMessageConfig(),
				debugLog: (message, details = {}) => {
					logger.debug(`ai_messages.${message}`, details);
				},
			});
		}
		return aiMessageService;
	};

	const getWebhookService = async (): Promise<WebhookService> => {
		if (!webhookService) {
			const { createWebhookService } = await import("./webhook.ts");
			webhookService = createWebhookService(buildWebhookConfig());
		}
		return webhookService;
	};

	const getSoundThemeService = async (): Promise<SoundThemeService> => {
		if (!soundThemeService) {
			const { SoundThemeService: SoundThemeServiceCtor } = await import("./sound-theme.ts");
			soundThemeService = new SoundThemeServiceCtor({
				debugLog: (message) => {
					logger.debug("sound_theme.debug", { message });
				},
			});
		}
		return soundThemeService;
	};

	const getTerminalFocusDetector = async (): Promise<FocusDetector> => {
		if (injectedTerminalFocusDetector) {
			return injectedTerminalFocusDetector;
		}
		focusModulePromise ??= import("./focus-detect.ts");
		const module = await focusModulePromise;
		return module.isTerminalFocused;
	};

	const clearFocusDetectCacheIfLoaded = (): void => {
		if (!focusModulePromise) {
			return;
		}
		void focusModulePromise
			.then((module) => module.clearFocusDetectCache())
			.catch((error) => {
				logger.debug("focus.cache_clear_failed", { error: getErrorMessage(error) });
			});
	};

	const clearProjectSoundCacheIfLoaded = (): void => {
		if (!soundThemeService) {
			return;
		}
		void import("./per-project-sound.ts")
			.then((module) => module.clearProjectSoundCache())
			.catch((error) => {
				logger.debug("sound_theme.cache_clear_failed", { error: getErrorMessage(error) });
			});
	};

	const permissionForwardingWatcherOptions: PermissionForwardingWatcherOptions = {
		onRequest: (event) => {
			if (!config.enabled || !config.enablePermissionNotification || !config.enableForwardedPermissionWatcher) {
				return;
			}
			if (!activeSessionContext) {
				logger.debug("permission_forwarding.notification_skipped", {
					reason: "missing_session_context",
					requestId: event.requestId,
					source: event.source,
				});
				return;
			}

			const customMessage = forwardedPermissionNotificationText(
				event.requesterAgentName,
				config.includeForwardedPermissionAgentName,
			);
			logger.debug("permission_forwarding.request_detected", {
				requestId: event.requestId,
				source: event.source,
				requesterAgentName: sanitizeAgentName(event.requesterAgentName),
				filePath: event.filePath,
			});
			queuePermissionNotification(activeSessionContext, {
				reminderKey: forwardedPermissionReminderKey(event.requestId),
				reason: `forwarded_permission:${event.requestId}`,
				customMessage,
			});
		},
		onResolve: (event) => {
			logger.debug("permission_forwarding.request_resolved", {
				requestId: event.requestId,
				source: event.source,
				requesterAgentName: sanitizeAgentName(event.requesterAgentName),
				filePath: event.filePath,
				reason: event.reason,
			});
			const reminderKey = forwardedPermissionReminderKey(event.requestId);
			removePermissionFromBatch(reminderKey, "forwarded_permission_resolved", {
				requestId: event.requestId,
				source: event.source,
				resolutionReason: event.reason,
			});
			cancelReminderActivityForKey(
				reminderKey,
				"forwarded_permission_resolved",
				{
					requestId: event.requestId,
					source: event.source,
					resolutionReason: event.reason,
				},
			);
		},
		debugLog: (event, details = {}) => {
			logger.debug(event, details);
		},
	};

	if (dependencies.createPermissionForwardingWatcher) {
		permissionForwardingWatcher = dependencies.createPermissionForwardingWatcher(permissionForwardingWatcherOptions);
	}

	const getPermissionForwardingWatcher = async (): Promise<PermissionForwardingWatcherController> => {
		if (!permissionForwardingWatcher) {
			const { PermissionForwardingWatcher } = await import("./permission-forwarding-watcher.ts");
			permissionForwardingWatcher = new PermissionForwardingWatcher(permissionForwardingWatcherOptions);
		}
		return permissionForwardingWatcher;
	};

	const syncPermissionForwardingWatcher = async (): Promise<void> => {
		if (!activeSessionContext) {
			permissionForwardingWatcher?.stop();
			return;
		}

		const watcherConfig: PermissionForwardingWatcherConfig = {
			enabled: config.enabled && config.enablePermissionNotification && config.enableForwardedPermissionWatcher,
			watchLegacyPath: config.watchLegacyForwardedPermissionPath,
			targetSessionId: getPermissionForwardingSessionId(activeSessionContext),
		};

		if (!watcherConfig.enabled && !permissionForwardingWatcher) {
			return;
		}

		const watcher = watcherConfig.enabled
			? await getPermissionForwardingWatcher()
			: permissionForwardingWatcher;
		watcher?.start(watcherConfig);
	};

	const refreshIntegratedServiceConfig = (): void => {
		ttsService = createInjectedTTSService
			? createInjectedTTSService({
				execRunner: pi,
				config: buildTTSServiceConfig(),
				debug: logger.debug,
			})
			: null;
		aiMessageService?.updateConfig(buildAIMessageConfig());
		webhookService?.updateConfig(buildWebhookConfig());
	};

	const rememberScopedToolCallId = (toolCallId: string, seenToolCallIds: Set<string>): boolean => {
		if (seenToolCallIds.has(toolCallId)) {
			return false;
		}
		seenToolCallIds.add(toolCallId);
		if (seenToolCallIds.size > 500) {
			seenToolCallIds.clear();
			seenToolCallIds.add(toolCallId);
		}
		return true;
	};

	const logError = (error: unknown): void => {
		logger.error(error);
	};

	const refreshQuestionToolAvailability = (): void => {
		try {
			questionToolAvailable = pi.getAllTools().some((tool) => tool.name.toLowerCase() === "question");
		} catch {
			questionToolAvailable = false;
		}
	};

	const notifyUser = (ctx: ExtensionContext, message: string, level: NotifyLevel): void => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.notify(message, level);
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, statusLine(config));
	};

	const persistConfig = (ctx?: ExtensionContext): void => {
		try {
			writeConfigToDisk(config);
			logger.debug("config.persisted", {
				configPath: CONFIG_PATH,
				debugLogPath: DEBUG_LOG_PATH,
				enabled: config.enabled,
				notificationMode: config.notificationMode,
			});
		} catch (error) {
			if (ctx) {
				notifyUser(ctx, `Failed to save ${EXTENSION_ID} config: ${getErrorMessage(error)}`, "warning");
			}
			logError(error);
		}
	};

	const enqueueAudio = (job: () => Promise<void>): void => {
		audioQueue = audioQueue.then(job).catch(logError);
	};

	const cancelReminder = (reminderKey: ReminderKey): boolean => {
		const reminder = pendingReminders.get(reminderKey);
		if (!reminder) {
			return false;
		}
		clearTimeout(reminder.timeoutId);
		pendingReminders.delete(reminderKey);
		logger.debug("reminder.cancelled", {
			reminderKey,
			type: reminder.type,
			followUpCount: reminder.followUpCount,
		});
		return true;
	};

	const cancelAllReminders = (): number => {
		const count = pendingReminders.size;
		for (const reminder of pendingReminders.values()) {
			clearTimeout(reminder.timeoutId);
		}
		pendingReminders.clear();
		if (count > 0) {
			logger.debug("reminder.cancelled_all", { count });
		}
		return count;
	};

	const cancelReminderActivity = (reason: string, details: Record<string, unknown> = {}): void => {
		const cancelledTimers = cancelAllReminders();
		const { cancelledActivePlayback, nextGeneration } = reminderPlayback.cancelAll();
		if (cancelledTimers > 0 || cancelledActivePlayback) {
			logger.debug("reminder.activity_cancelled", {
				reason,
				cancelledTimers,
				cancelledActivePlayback,
				playbackGeneration: nextGeneration,
				...details,
			});
		}
	};

	const cancelReminderActivityForKey = (
		reminderKey: ReminderKey,
		reason: string,
		details: Record<string, unknown> = {},
	): void => {
		const cancelledTimer = cancelReminder(reminderKey);
		const { cancelledActivePlayback, nextVersion } = reminderPlayback.cancel(reminderKey);
		if (cancelledTimer || cancelledActivePlayback) {
			logger.debug("reminder.activity_cancelled", {
				reason,
				reminderKey,
				cancelledTimers: cancelledTimer ? 1 : 0,
				cancelledActivePlayback,
				playbackVersion: nextVersion,
				...details,
			});
		}
	};

	const resolvePermissionInteraction = (
		toolCallId: string,
		stage: "tool_execution_start" | "tool_result",
		details: Record<string, unknown> = {},
	): void => {
		if (!pendingPermissionToolCallIds.delete(toolCallId)) {
			return;
		}
		const reminderKey = permissionReminderKey(toolCallId);
		removePermissionFromBatch(reminderKey, "permission_interaction_resolved", {
			toolCallId,
			stage,
			...details,
		});
		cancelReminderActivityForKey(reminderKey, "permission_interaction_resolved", {
			toolCallId,
			stage,
			...details,
		});
	};

	const shouldThrottle = (type: NotificationType): boolean => {
		const now = Date.now();
		const last = lastNotificationAt.get(type) ?? 0;
		if (now - last < config.minNotificationIntervalMs) {
			return true;
		}
		lastNotificationAt.set(type, now);
		return false;
	};

	const shouldSkipFocusedNotification = async (type: NotificationType): Promise<boolean> => {
		if (!config.skipWhenFocused || !focusDetectionEnabled || notifyWhenFocused) {
			return false;
		}

		try {
			const detectTerminalFocus = await getTerminalFocusDetector();
			const focused = await detectTerminalFocus({
				debug: config.debugLog,
				cacheTtlMs: config.focusCacheTtlMs,
				timeoutMs: focusTimeoutMs,
				logger: (message, details = {}) => {
					logger.debug("focus.detect", {
						message,
						...details,
					});
				},
			});
			if (focused) {
				logger.debug("notification.skipped.focused", { type });
				return true;
			}
		} catch (error) {
			logger.debug("focus.detect.error", {
				type,
				error: getErrorMessage(error),
			});
		}

		return false;
	};

	const buildNotificationMessage = async (
		type: NotificationType,
		options: {
			customMessage?: string;
			isReminder?: boolean;
			followUpCount?: number;
			reason?: string;
		} = {},
	): Promise<string> => {
		if (options.customMessage?.trim()) {
			return options.customMessage.trim();
		}

		const eventType = options.isReminder ? REMINDER_EVENT_TYPE[type] : type;
		if (config.aiMessages.enabled) {
			try {
				const service = await getAIMessageService();
				const generated = await service.generateMessage(eventType, {
					projectName,
					time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
					count: options.followUpCount,
					reason: options.reason,
				});
				if (generated.trim().length > 0) {
					return generated;
				}
			} catch (error) {
				logger.debug("message.generate.error", {
					type,
					eventType,
					error: getErrorMessage(error),
				});
			}
		}

		return pickRandom(MESSAGE_LIBRARY[type][options.isReminder ? "reminder" : "initial"]);
	};

	const wakeForNotification = async (): Promise<void> => {
		if (!config.wakeMonitor) {
			return;
		}

		if (process.platform === "linux") {
			const { getIdleTime, wakeMonitor: wakeLinuxMonitor } = await import("./linux.ts");
			const idleSeconds = await getIdleTime({
				debugLog: (message) => {
					logger.debug("linux.idle", { message });
				},
			});
			if (idleSeconds >= 0 && idleSeconds < config.idleThresholdSeconds) {
				logger.debug("wake.monitor.skipped", {
					reason: "below_threshold",
					idleSeconds,
					threshold: config.idleThresholdSeconds,
				});
				return;
			}
			await wakeLinuxMonitor({
				debugLog: (message) => {
					logger.debug("linux.wake", { message });
				},
			});
			return;
		}

		const service = await getAudioService();
		await service.wakeMonitor();
	};

	const playNotificationSound = async (type: NotificationType): Promise<boolean> => {
		if (!config.enableSound) {
			return false;
		}

		if (process.platform === "linux") {
			try {
				const service = await getSoundThemeService();
				const played = await service.playEventSound(type, buildSoundThemeConfig(), SOUND_LOOPS[type]);
				if (played) {
					return true;
				}
			} catch (error) {
				logger.debug("sound.play.theme_failed", {
					type,
					error: getErrorMessage(error),
				});
			}
		}

		try {
			const service = await getAudioService();
			await service.playWindowsSound(type);
			return isWindows();
		} catch (error) {
			logger.debug("sound.play.legacy_failed", {
				type,
				error: getErrorMessage(error),
			});
			return false;
		}
	};

	const speakNotification = async (message: string, signal?: AbortSignal): Promise<boolean> => {
		if (!config.enableTts || !message.trim() || signal?.aborted) {
			return false;
		}

		const service = await getTTSService();
		const spoken = await service.speak(message, config.ttsEngine, {
			signal,
			sapiVoice: config.sapiVoice,
			sapiRate: config.sapiRate,
		});
		if (spoken || signal?.aborted) {
			return spoken;
		}

		if (isWindows()) {
			try {
				const audio = await getAudioService();
				await audio.speakWithSapi(message, signal);
				return !signal?.aborted;
			} catch (error) {
				logger.debug("tts.sapi_fallback_failed", {
					error: getErrorMessage(error),
				});
			}
		}

		return false;
	};

	const dispatchDesktop = async (type: NotificationType, message: string, ctx: ExtensionContext): Promise<void> => {
		if (!config.enableDesktopNotification) {
			return;
		}

		try {
			const { sendDesktopNotification } = await import("./desktop-notify.ts");
			const result = await sendDesktopNotification({
				type,
				message,
				timeoutSeconds: config.desktopNotificationTimeout,
				debugLog: config.debugLog,
			});
			if (result.success) {
				logger.debug("desktop.notify.sent", {
					type,
					platform: result.platform,
					timeoutSeconds: config.desktopNotificationTimeout,
				});
				return;
			}

			logger.debug("desktop.notify.failed", {
				type,
				platform: result.platform,
				unsupported: Boolean(result.unsupported),
				error: result.error,
			});
			if (result.unsupported && !warnedDesktopUnsupported) {
				warnedDesktopUnsupported = true;
				notifyUser(ctx, result.error ?? "Desktop notifications are not supported on this platform.", "warning");
			}
		} catch (error) {
			logger.debug("desktop.notify.error", {
				type,
				error: getErrorMessage(error),
			});
		}
	};

	const dispatchWebhook = async (type: NotificationType, message: string): Promise<void> => {
		if (!config.webhook.enabled) {
			return;
		}

		try {
			const service = await getWebhookService();
			const dispatchResult = service.dispatch({
				type,
				title: `Pi Notification - ${type}`,
				message,
				projectName,
				mention: type === "permission" && config.webhook.mentionOnPermission ? true : undefined,
			});
			logger.debug("webhook.dispatch", {
				type,
				queued: dispatchResult.queued,
				skipped: dispatchResult.skipped,
			});
		} catch (error) {
			logger.debug("webhook.dispatch.error", {
				type,
				error: getErrorMessage(error),
			});
		}
	};

	const getReminderDelaySeconds = (type: NotificationType): number => {
		const typeDelaySeconds =
			type === "idle"
				? config.reminderIntervals.idleSeconds
				: type === "permission"
					? config.reminderIntervals.permissionSeconds
					: type === "question"
						? config.reminderIntervals.questionSeconds
						: config.reminderIntervals.errorSeconds;
		const defaultDelaySeconds = config.reminderIntervals.defaultSeconds || config.reminderDelaySeconds;
		const defaultTypeDelaySeconds =
			type === "idle"
				? DEFAULT_CONFIG.reminderIntervals.idleSeconds
				: type === "permission"
					? DEFAULT_CONFIG.reminderIntervals.permissionSeconds
					: type === "question"
						? DEFAULT_CONFIG.reminderIntervals.questionSeconds
						: DEFAULT_CONFIG.reminderIntervals.errorSeconds;
		const shouldUseGlobalDefaultDelay =
			defaultDelaySeconds !== DEFAULT_CONFIG.reminderIntervals.defaultSeconds &&
			typeDelaySeconds === defaultTypeDelaySeconds;
		return Math.max(1, shouldUseGlobalDefaultDelay ? defaultDelaySeconds : typeDelaySeconds || defaultDelaySeconds);
	};

	const scheduleReminder = (
		reminderKey: ReminderKey,
		type: NotificationType,
		delaySeconds: number,
		followUpCount: number,
	): void => {
		if (
			shutdownRequested
			|| !config.enabled
			|| !config.reminderEnabled
			|| !config.enableTts
			|| config.notificationMode === "sound-only"
		) {
			return;
		}

		cancelReminder(reminderKey);
		const scheduledAt = Date.now();
		const reminderCheckpoint = reminderPlayback.captureCheckpoint(reminderKey);
		const delayMs = Math.max(1, delaySeconds) * 1000;

		const timeoutId = setTimeout(() => {
			queueTask(
				(async () => {
					const current = pendingReminders.get(reminderKey);
					if (!current || current.scheduledAt !== scheduledAt) {
						return;
					}
					if (shutdownRequested) {
						pendingReminders.delete(reminderKey);
						logger.debug("reminder.skipped_shutdown", {
							reminderKey,
							type,
							followUpCount,
						});
						return;
					}

					if (!reminderPlayback.isCurrent(reminderCheckpoint, scheduledAt, lastUserActivityAt)) {
						pendingReminders.delete(reminderKey);
						logger.debug("reminder.skipped_user_active", {
							reminderKey,
							type,
							followUpCount,
							reminderVersion: reminderCheckpoint.version,
						});
						return;
					}

					const reminderMessage = await buildNotificationMessage(type, {
						isReminder: true,
						followUpCount: followUpCount + 1,
					});
					if (!reminderPlayback.isCurrent(reminderCheckpoint, scheduledAt, lastUserActivityAt)) {
						pendingReminders.delete(reminderKey);
						logger.debug("reminder.skipped_stale", {
							reminderKey,
							type,
							followUpCount,
							reminderVersion: reminderCheckpoint.version,
						});
						return;
					}

					logger.debug("reminder.fired", {
						reminderKey,
						type,
						followUpCount,
						delaySeconds,
						reminderVersion: reminderCheckpoint.version,
					});
					enqueueAudio(async () => {
						if (!reminderPlayback.isCurrent(reminderCheckpoint, scheduledAt, lastUserActivityAt)) {
							logger.debug("reminder.playback_skipped", {
								reminderKey,
								type,
								followUpCount,
								reason: "stale_before_start",
							});
							return;
						}

						const playbackHandle = reminderPlayback.start(reminderCheckpoint, type, followUpCount + 1);
						try {
							if (!reminderPlayback.isCurrent(playbackHandle, scheduledAt, lastUserActivityAt)) {
								logger.debug("reminder.playback_skipped", {
									reminderKey,
									type,
									followUpCount,
									reason: "stale_after_start",
								});
								return;
							}
							await wakeForNotification();
							if (!reminderPlayback.isCurrent(playbackHandle, scheduledAt, lastUserActivityAt)) {
								logger.debug("reminder.playback_cancelled", {
									reminderKey,
									type,
									followUpCount,
									reason: "stale_before_speak",
								});
								return;
							}
							await speakNotification(reminderMessage, playbackHandle.signal);
						} finally {
							reminderPlayback.finish(playbackHandle);
						}
					});

					pendingReminders.delete(reminderKey);
					const shouldScheduleFollowUp =
						config.followUpEnabled &&
						followUpCount + 1 < config.maxFollowUps &&
						reminderPlayback.isCurrent(reminderCheckpoint, scheduledAt, lastUserActivityAt);
					if (!shouldScheduleFollowUp) {
						return;
					}

					const nextDelay = Math.round(Math.max(5, delaySeconds * config.followUpBackoffMultiplier));
					logger.debug("reminder.follow_up_scheduled", {
						reminderKey,
						type,
						followUpCount: followUpCount + 1,
						delaySeconds: nextDelay,
					});
					scheduleReminder(reminderKey, type, nextDelay, followUpCount + 1);
				})(),
				logError,
			);
		}, delayMs);

		pendingReminders.set(reminderKey, {
			reminderKey,
			type,
			timeoutId,
			scheduledAt,
			followUpCount,
			delaySeconds,
		});
		logger.debug("reminder.scheduled", {
			reminderKey,
			type,
			followUpCount,
			delaySeconds,
			reminderVersion: reminderCheckpoint.version,
		});
	};

	const triggerNotification = (
		type: NotificationType,
		ctx: ExtensionContext,
		options: {
			bypassThrottle?: boolean;
			customMessage?: string;
			reason?: string;
			reminderKey?: ReminderKey;
			scheduleReminder?: boolean;
		} = {},
	): void => {
		if (shutdownRequested) {
			logger.debug("notification.skipped_shutdown", {
				type,
				reason: options.reason,
			});
			return;
		}

		queueTask(
			(async () => {
				if (shutdownRequested || !config.enabled || !isNotificationEnabled(config, type)) {
					return;
				}
				if (!options.bypassThrottle && shouldThrottle(type)) {
					return;
				}

				if (process.platform !== "linux" && !isWindows() && config.windowsOptimized && !warnedNonWindows) {
					warnedNonWindows = true;
					notifyUser(
						ctx,
						"smart-voice-notify has limited native channels on this platform. Using available fallback channels. Set windowsOptimized to false to hide this notice.",
						"warning",
					);
				}

				if (await shouldSkipFocusedNotification(type)) {
					return;
				}

				const spokenMessage = await buildNotificationMessage(type, {
					customMessage: options.customMessage,
					reason: options.reason,
				});
				const displayMessage = options.customMessage ?? INLINE_NOTIFY_TEXT[type];
				logger.debug("notification.triggered", {
					type,
					bypassThrottle: Boolean(options.bypassThrottle),
					notificationMode: config.notificationMode,
					text: displayMessage,
				});
				logger.debug("notification.channels", {
					type,
					hasUI: ctx.hasUI,
					wakeMonitor: config.wakeMonitor,
					idleThresholdSeconds: config.idleThresholdSeconds,
					enableSound: config.enableSound,
					enableTts: config.enableTts,
					enableDesktopNotification: config.enableDesktopNotification,
					desktopNotificationTimeout: config.desktopNotificationTimeout,
				});

				enqueueAudio(async () => {
					if (shutdownRequested) {
						logger.debug("notification.playback_skipped", {
							type,
							reason: "session_shutdown",
						});
						return;
					}

					const mode = config.notificationMode;
					const shouldPlaySoundNow =
						config.enableSound && (mode === "sound-first" || mode === "both" || mode === "sound-only");
					const shouldSpeakNow = config.enableTts && (mode === "tts-first" || mode === "both");

					try {
						if (shouldPlaySoundNow || shouldSpeakNow) {
							await wakeForNotification();
						}
					} catch (error) {
						logger.debug("wake.monitor.error", { error: getErrorMessage(error) });
					}

					if (shutdownRequested) {
						return;
					}

					let soundPlayed = false;
					if (shouldPlaySoundNow) {
						soundPlayed = await playNotificationSound(type);
						if (!soundPlayed && mode === "sound-first" && config.enableTts) {
							await speakNotification(spokenMessage);
						}
					}

					if (shutdownRequested) {
						return;
					}

					await dispatchDesktop(type, displayMessage, ctx);

					if (shutdownRequested) {
						return;
					}

					if (shouldSpeakNow) {
						const spoken = await speakNotification(spokenMessage);
						if (!spoken && !shouldPlaySoundNow && config.enableSound) {
							await playNotificationSound(type);
						}
					}

					if (!shutdownRequested) {
						await dispatchWebhook(type, spokenMessage);
					}
				});
				if (!shutdownRequested && options.scheduleReminder !== false) {
					scheduleReminder(options.reminderKey ?? defaultReminderKey(type), type, getReminderDelaySeconds(type), 0);
				}
			})(),
			logError,
		);
	};

	const cancelPendingAgentErrorNotification = (reason: string): void => {
		if (!pendingAgentErrorNotification) {
			return;
		}

		clearTimeout(pendingAgentErrorNotification);
		pendingAgentErrorNotification = null;
		logger.debug("agent.error_notification.cancelled", { reason });
	};

	const scheduleAgentErrorNotification = (ctx: ExtensionContext, outcome: AgentEndOutcome): void => {
		cancelPendingAgentErrorNotification("rescheduled");
		if (!config.enabled || !config.enableErrorNotification) {
			return;
		}
		if (hasPendingAgentMessages(ctx)) {
			logger.debug("agent.error_notification.skipped", {
				reason: "pending_messages",
				errorReason: outcome.reason,
				stage: "schedule",
			});
			return;
		}

		const timeoutId = setTimeout(() => {
			if (pendingAgentErrorNotification !== timeoutId) {
				return;
			}
			pendingAgentErrorNotification = null;

			if (shutdownRequested || !config.enabled || !config.enableErrorNotification) {
				logger.debug("agent.error_notification.skipped", {
					reason: shutdownRequested ? "session_shutdown" : "disabled",
				});
				return;
			}

			if (hasPendingAgentMessages(ctx)) {
				logger.debug("agent.error_notification.skipped", {
					reason: "pending_messages",
					errorReason: outcome.reason,
					stage: "fire",
				});
				return;
			}

			logger.debug("agent.error_notification.fired", {
				reason: outcome.reason,
				graceMs: agentErrorNotificationGraceMs,
			});
			triggerNotification("error", ctx, {
				customMessage: formatAgentErrorNotification(outcome.reason),
				reason: outcome.reason,
			});
		}, agentErrorNotificationGraceMs);
		timeoutId.unref?.();
		pendingAgentErrorNotification = timeoutId;
		logger.debug("agent.error_notification.scheduled", {
			reason: outcome.reason,
			graceMs: agentErrorNotificationGraceMs,
		});
	};

	const resetPermissionBatch = (reason: string): void => {
		permissionBatchGeneration += 1;

		if (permissionBatchTimeout) {
			clearTimeout(permissionBatchTimeout);
			permissionBatchTimeout = null;
		}

		const count = pendingPermissionBatch.size;
		if (count > 0) {
			pendingPermissionBatch.clear();
		}
		permissionBatchContext = null;
		resolvedPermissionBatchKeys.clear();

		if (count > 0) {
			logger.debug("permission.batch.reset", { reason, count });
		}
	};

	const removePermissionFromBatch = (
		reminderKey: ReminderKey,
		reason: string,
		details: Record<string, unknown> = {},
	): void => {
		resolvedPermissionBatchKeys.add(reminderKey);
		if (resolvedPermissionBatchKeys.size > 2000) {
			resolvedPermissionBatchKeys.clear();
			resolvedPermissionBatchKeys.add(reminderKey);
		}

		if (!pendingPermissionBatch.delete(reminderKey)) {
			return;
		}

		logger.debug("permission.batch.removed", {
			reason,
			reminderKey,
			remaining: pendingPermissionBatch.size,
			...details,
		});

		if (pendingPermissionBatch.size === 0 && permissionBatchTimeout) {
			clearTimeout(permissionBatchTimeout);
			permissionBatchTimeout = null;
			permissionBatchContext = null;
			logger.debug("permission.batch.timer_cancelled", { reason, reminderKey });
		}
	};

	const queuePermissionNotification = (ctx: ExtensionContext, entry: PermissionBatchEntry): void => {
		if (!config.enabled || !isNotificationEnabled(config, "permission")) {
			return;
		}

		permissionBatchContext = ctx;
		pendingPermissionBatch.set(entry.reminderKey, entry);

		if (permissionBatchTimeout) {
			clearTimeout(permissionBatchTimeout);
		}

		const windowMs = Math.max(0, permissionBatchWindowMs);
		const generation = permissionBatchGeneration;
		permissionBatchTimeout = setTimeout(() => {
			const batchCtx = permissionBatchContext;
			const batch = Array.from(pendingPermissionBatch.values());
			pendingPermissionBatch.clear();
			permissionBatchTimeout = null;
			permissionBatchContext = null;

			queueTask(
				(async () => {
					if (!batchCtx || batch.length === 0) {
						return;
					}
					if (!config.enabled || !isNotificationEnabled(config, "permission")) {
						return;
					}
					if (generation !== permissionBatchGeneration) {
						return;
					}

					if (await shouldSkipFocusedNotification("permission")) {
						return;
					}
					if (generation !== permissionBatchGeneration) {
						return;
					}

					const activeBatch = batch.filter(
						(batchedEntry) => !resolvedPermissionBatchKeys.has(batchedEntry.reminderKey),
					);
					if (activeBatch.length === 0) {
						return;
					}

					for (const batchedEntry of activeBatch) {
						scheduleReminder(batchedEntry.reminderKey, "permission", getReminderDelaySeconds("permission"), 0);
					}

					const count = activeBatch.length;
					logger.debug("permission.batch.fired", { count, windowMs });

					if (count === 1) {
						const first = activeBatch[0];
						triggerNotification("permission", batchCtx, {
							customMessage: first.customMessage,
							reason: first.reason,
							scheduleReminder: false,
						});
						return;
					}

					triggerNotification("permission", batchCtx, {
						customMessage: `⚠️ ${count} permission requests are waiting for your approval.`,
						reason: `permission_batch:${count}`,
						scheduleReminder: false,
					});
				})(),
				logError,
			);
		}, windowMs);
		permissionBatchTimeout.unref?.();
	};

	pi.events.on(PERMISSION_SYSTEM_EVENT_CHANNEL, (payload: unknown) => {
		const event = readPermissionSystemEvent(payload);
		if (!event) {
			return;
		}
		if (!config.enabled || !config.enablePermissionNotification) {
			return;
		}
		if (!activeSessionContext) {
			logger.debug("permission_system.notification_skipped", {
				reason: "missing_session_context",
				requestId: event.requestId,
				state: event.state,
				source: event.source,
			});
			return;
		}

		const reminderKey = permissionSystemReminderKey(event);
		if (event.state === "waiting") {
			if (event.toolCallId) {
				pendingPermissionToolCallIds.add(event.toolCallId);
			}
			logger.debug("permission_system.wait_detected", {
				requestId: event.requestId,
				toolCallId: event.toolCallId ?? null,
				toolName: event.toolName ?? null,
				skillName: event.skillName ?? null,
				source: event.source,
			});
			queuePermissionNotification(activeSessionContext, {
				reminderKey,
				reason: event.message,
			});
			return;
		}

		if (event.toolCallId) {
			pendingPermissionToolCallIds.delete(event.toolCallId);
		}
		removePermissionFromBatch(reminderKey, "permission_system_wait_resolved", {
			requestId: event.requestId,
			toolCallId: event.toolCallId ?? null,
			toolName: event.toolName ?? null,
			skillName: event.skillName ?? null,
			state: event.state,
			source: event.source,
		});
		cancelReminderActivityForKey(reminderKey, "permission_system_wait_resolved", {
			requestId: event.requestId,
			toolCallId: event.toolCallId ?? null,
			toolName: event.toolName ?? null,
			skillName: event.skillName ?? null,
			state: event.state,
			source: event.source,
		});
	});

	const applySetting = (draft: VoiceNotifyConfig, id: string, value: string): void => {
		switch (id) {
			case "enabled":
				draft.enabled = boolValue(value);
				return;
			case "enableTts":
				draft.enableTts = boolValue(value);
				return;
			case "ttsEngine":
				if (TTS_ENGINE_VALUES.includes(value as VoiceNotifyConfig["ttsEngine"])) {
					draft.ttsEngine = value as VoiceNotifyConfig["ttsEngine"];
				}
				return;
			case "enableDesktopNotification":
				draft.enableDesktopNotification = boolValue(value);
				return;
			case "skipWhenFocused":
				draft.skipWhenFocused = boolValue(value);
				return;
			case "volume":
				draft.volume = clampInt(Number(value), draft.volume, 0, 100);
				return;
			default:
				return;
		}
	};

	const buildSettings = (draft: VoiceNotifyConfig): SettingItem[] => {
		const volumeValues = Array.from(new Set(["0", "25", "50", "75", "85", "100", String(draft.volume)])).sort(
			(a, b) => Number(a) - Number(b),
		);

		return [
			{ id: "enabled", label: "Extension Enabled", currentValue: draft.enabled ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{ id: "enableTts", label: "Speak TTS", currentValue: draft.enableTts ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{ id: "ttsEngine", label: "TTS Engine", currentValue: draft.ttsEngine, values: [...TTS_ENGINE_VALUES] },
			{
				id: "enableDesktopNotification",
				label: "Desktop Notifications",
				currentValue: draft.enableDesktopNotification ? "on" : "off",
				values: [...BOOLEAN_VALUES],
			},
			{
				id: "skipWhenFocused",
				label: "Skip Notifications When Focused",
				currentValue: draft.skipWhenFocused ? "on" : "off",
				values: [...BOOLEAN_VALUES],
			},
			{ id: "volume", label: "Volume (%)", currentValue: String(draft.volume), values: volumeValues },
		];
	};

	const openConfigModal = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.hasUI) {
			pi.sendMessage({
				customType: EXTENSION_ID,
				content: `Configuration UI requires interactive mode.\n\n${summarizeConfig(config)}`,
				display: true,
			});
			return;
		}

		const draft: VoiceNotifyConfig = { ...config };
		const items = buildSettings(draft);
		const overlayOptions = { anchor: "center" as const, width: 92, maxHeight: "85%" as const, margin: 1 };
		const advancedConfigPath = CONFIG_PATH;
		const description = `Recommended settings only.\nFor advanced settings, manually edit: ${advancedConfigPath}`;
		const { ZellijModal, ZellijSettingsModal } = await import("./zellij-modal.ts");

		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const settingsModal = new ZellijSettingsModal(
					{
						title: "Voice Notify Settings",
						description,
						settings: items,
						onChange: (id, newValue) => {
							const previousConfig = config;
							applySetting(draft, id, newValue);
							config = normalizeConfig(draft);
							refreshIntegratedServiceConfig();
							void syncPermissionForwardingWatcher();
							if (config.debugLog && !previousConfig.debugLog) {
								logger.debug("debug.enabled", { debugLogPath: DEBUG_LOG_PATH });
							}
							logger.debug("config.setting_updated", { id, newValue });
							if (!config.enabled || !config.reminderEnabled) {
								cancelReminderActivity("config_disabled", { id, newValue });
							}
							persistConfig(ctx);
							updateStatus(ctx);
						},
						onClose: () => done(),
						helpText: `Active config: ${CONFIG_PATH} • Debug: ${DEBUG_LOG_PATH}`,
						enableSearch: true,
					},
					theme,
				);

				const modal = new ZellijModal(
					settingsModal,
					{
						borderStyle: "rounded",
						titleBar: {
							left: "Voice Notify Settings",
							right: EXTENSION_ID,
						},
						helpUndertitle: {
							text: "Esc: close | ↑↓: navigate | Space: toggle",
							color: "dim",
						},
						overlay: overlayOptions,
					},
					theme,
				);

				return {
					render(width: number): string[] {
						return modal.renderModal(width).lines;
					},
					invalidate(): void {
						modal.invalidate();
					},
					handleInput(data: string): void {
						modal.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true, overlayOptions },
		);
	};

	const runCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const trimmed = args.trim();
		logger.debug("command.invoked", { args: trimmed || "(open-config-modal)" });
		if (!trimmed) {
			await openConfigModal(ctx);
			return;
		}

		const [subcommandRaw, typeRaw] = trimmed.split(/\s+/, 2);
		const subcommand = subcommandRaw.toLowerCase();

		if (subcommand === "status") {
			const summary = `${summarizeConfig(config)}\nquestionToolAvailable=${questionToolAvailable}`;
			if (ctx.hasUI) {
				notifyUser(ctx, summary, "info");
			} else {
				pi.sendMessage({ customType: EXTENSION_ID, content: summary, display: true });
			}
			return;
		}

		if (subcommand === "reload") {
			config = readConfig(ctx.cwd);
			refreshIntegratedServiceConfig();
			await syncPermissionForwardingWatcher();
			refreshQuestionToolAvailability();
			cancelReminderActivity("command_reload");
			updateStatus(ctx);
			notifyUser(ctx, "Reloaded smart voice notify config from disk.", "info");
			return;
		}

		if (subcommand === "on" || subcommand === "off") {
			config.enabled = subcommand === "on";
			refreshIntegratedServiceConfig();
			await syncPermissionForwardingWatcher();
			persistConfig(ctx);
			if (!config.enabled) {
				cancelReminderActivity("command_disabled");
			}
			updateStatus(ctx);
			notifyUser(ctx, `smart-voice-notify ${config.enabled ? "enabled" : "disabled"}.`, "info");
			return;
		}

		if (subcommand === "test") {
			const type = (typeRaw || "idle").toLowerCase() as NotificationType;
			if (type !== "idle" && type !== "permission" && type !== "question" && type !== "error") {
				notifyUser(ctx, "Usage: /voice-notify test [idle|permission|question|error]", "warning");
				return;
			}
			if (type === "question" && !questionToolAvailable) {
				notifyUser(ctx, "Question notifications are unavailable because no custom 'question' tool is loaded.", "warning");
				return;
			}
			triggerNotification(type, ctx, {
				bypassThrottle: true,
				customMessage: `Test ${type} notification from /voice-notify test.`,
			});
			return;
		}

		notifyUser(ctx, "Usage: /voice-notify [status|reload|on|off|test <type>]", "warning");
	};

	pi.registerCommand("voice-notify", {
		description: "Configure Windows smart voice notifications",
		handler: async (args, ctx) => {
			await runCommand(args, ctx);
		},
	});

	pi.on("resources_discover", (event, _ctx) => {
		if (event.reason === "reload") {
			// Clear caches on reload
			clearFocusDetectCacheIfLoaded();
			clearProjectSoundCacheIfLoaded();
			aiMessageService?.clearCache();
		}
	});

	pi.on("session_start", async (event, ctx) => {
		const reason = getSessionStartReason(event);
		const previousSessionFile = getPreviousSessionFile(event);

		shutdownRequested = false;
		shutdownPromise = null;
		cancelPendingAgentErrorNotification("session_start");
		config = readConfig(ctx.cwd);
		refreshIntegratedServiceConfig();
		activeSessionContext = ctx;
		await syncPermissionForwardingWatcher();
		refreshQuestionToolAvailability();
		clearFocusDetectCacheIfLoaded();
		clearProjectSoundCacheIfLoaded();

		// Clear AI message cache on reload to pick up config changes
		if (reason === "reload") {
			aiMessageService?.clearCache();
		}
		lastUserActivityAt = Date.now();
		hadErrorInTurn = false;
		warnedDesktopUnsupported = false;
		pendingPermissionToolCallIds.clear();
		processedToolResultToolCallIds.clear();
		lastNotificationAt.clear();

		if (reason === "new" || reason === "resume" || reason === "fork") {
			resetPermissionBatch(`session_start:${reason}`);
			cancelReminderActivity(`session_start:${reason}`);
			updateStatus(ctx);
			logger.debug("session.start", {
				reason,
				previousSessionFile,
				configPath: CONFIG_PATH,
				debugLogPath: DEBUG_LOG_PATH,
				notificationMode: config.notificationMode,
			});
			return;
		}

		warnedNonWindows = false;
		resetPermissionBatch("session_start");
		cancelReminderActivity("session_start");
		updateStatus(ctx);
		logger.debug("session.start", {
			reason: reason ?? "startup",
			previousSessionFile,
			configPath: CONFIG_PATH,
			debugLogPath: DEBUG_LOG_PATH,
			notificationMode: config.notificationMode,
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shutdownRequested = true;
		cancelPendingAgentErrorNotification("session_shutdown");
		if (shutdownPromise) {
			await shutdownPromise;
			return;
		}

		shutdownPromise = (async () => {
			logger.debug("session.shutdown", {});
			activeSessionContext = null;
			permissionForwardingWatcher?.stop();
			pendingPermissionToolCallIds.clear();
			processedToolResultToolCallIds.clear();
			resetPermissionBatch("session_shutdown");
			cancelReminderActivity("session_shutdown");
			clearFocusDetectCacheIfLoaded();
			clearProjectSoundCacheIfLoaded();
			try {
				// Forward abort signal to flush if available (added in pi-coding-agent 0.67.x)
				const abortSignal = 'signal' in ctx ? (ctx as { signal?: AbortSignal }).signal : undefined;
				await webhookService?.flush(abortSignal);
			} catch (error) {
				const message = `Failed to flush webhook queue during shutdown: ${getErrorMessage(error)}`;
				logger.error(new Error(message));
				if (ctx.hasUI) {
					ctx.ui.notify(message, "warning");
				}
			} finally {
				if (ctx.hasUI) {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				}
			}
		})();

		await shutdownPromise;
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			lastUserActivityAt = Date.now();
			cancelPendingAgentErrorNotification("user_input");
			cancelReminderActivity("user_input", { source: event.source });
		}
	});

	pi.on("agent_start", async () => {
		cancelPendingAgentErrorNotification("agent_start");
		hadErrorInTurn = false;
		pendingPermissionToolCallIds.clear();
		processedToolResultToolCallIds.clear();
		resetPermissionBatch("agent_start");
		cancelReminderActivity("agent_start");
		logger.debug("agent.start", {});
	});

	pi.on("tool_call", async (_event, ctx) => {
		activeSessionContext = ctx;
		return {};
	});

	pi.on("tool_execution_start", async (event) => {
		resolvePermissionInteraction(event.toolCallId, "tool_execution_start", {
			toolName: event.toolName,
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		activeSessionContext = ctx;
		resolvePermissionInteraction(event.toolCallId, "tool_result", {
			toolName: event.toolName,
			isError: event.isError,
		});
		if (!config.enabled) {
			return;
		}

		if (!rememberScopedToolCallId(event.toolCallId, processedToolResultToolCallIds)) {
			return;
		}

		const toolName = typeof event.toolName === "string" ? event.toolName : "";
		const text = extractTextContent(event.content);
		const type = classifyToolResult(toolName, event.isError, text);
		if (!type) {
			return;
		}
		if (type === "question" && !questionToolAvailable) {
			return;
		}

		logger.debug("tool_result.classified", {
			toolCallId: event.toolCallId,
			toolName,
			isError: event.isError,
			notificationType: type,
		});
		triggerNotification(type, ctx, {
			reason: event.isError ? text.slice(0, 120) : undefined,
		});
	});

	pi.on("agent_end", async (event, ctx) => {
		activeSessionContext = ctx;
		const outcome = readAgentEndOutcome(event);
		if (outcome.status === "error") {
			hadErrorInTurn = true;
			logger.debug("agent.end.error_detected", {
				reason: outcome.reason,
				graceMs: agentErrorNotificationGraceMs,
			});
			scheduleAgentErrorNotification(ctx, outcome);
			return;
		}
		if (outcome.status === "aborted") {
			hadErrorInTurn = true;
			logger.debug("agent.end.idle_skipped", {
				reason: "agent_aborted",
				errorMessage: outcome.reason,
			});
			return;
		}
		if (!config.enabled || !config.enableIdleNotification) {
			logger.debug("agent.end.idle_skipped", {
				reason: "idle_notification_disabled",
				enabled: config.enabled,
				enableIdleNotification: config.enableIdleNotification,
			});
			return;
		}
		if (config.suppressIdleAfterError && hadErrorInTurn) {
			logger.debug("agent.end.idle_skipped", { reason: "suppressed_after_error" });
			return;
		}
		logger.debug("agent.end.idle_trigger", {});
		triggerNotification("idle", ctx);
	});
}
