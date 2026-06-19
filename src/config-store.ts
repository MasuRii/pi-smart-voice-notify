import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { resolvePiAgentDir } from "./agent-dir.ts";
import type {
	ConcreteTTSEngine,
	MessageSet,
	NotificationMode,
	NotificationType,
	SoundFileField,
	TTSEngine,
	VoiceNotifyConfig,
} from "./types.ts";

export const EXTENSION_ID = "pi-smart-voice-notify";
export const STATUS_KEY = "smart-voice-notify";
export const CONFIG_DIR = join(resolvePiAgentDir(), "extensions", EXTENSION_ID);
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/** Project-local override config: <projectRoot>/.pi/extensions/<id>/config.json (read-only). */
export function resolveProjectConfigPath(projectRoot: string): string {
	return join(projectRoot, ".pi", "extensions", EXTENSION_ID, "config.json");
}
export const DEBUG_DIR = join(CONFIG_DIR, "debug");
export const DEBUG_LOG_PATH = join(DEBUG_DIR, `${EXTENSION_ID}.log`);

export const NOTIFICATION_MODES = ["sound-first", "tts-first", "both", "sound-only"] as const;
export const BOOLEAN_VALUES = ["on", "off"] as const;
export const REMINDER_DELAY_VALUES = ["10", "20", "30", "45", "60", "90"] as const;
export const DESKTOP_NOTIFICATION_TIMEOUT_VALUES = ["3", "5", "8", "10", "15", "20", "30"] as const;
export const IDLE_THRESHOLD_VALUES = ["15", "30", "45", "60", "90", "120"] as const;
export const MAX_FOLLOW_UP_VALUES = ["1", "2", "3", "4", "5"] as const;
export const RATE_VALUES = ["-5", "-3", "-1", "0", "1", "3", "5"] as const;
export const TTS_ENGINE_VALUES = ["auto", "espeak-ng", "edge", "elevenlabs", "openai", "sapi"] as const;

const NOTIFICATION_TYPE_VALUES: NotificationType[] = ["idle", "permission", "question", "error"];
const CONCRETE_TTS_ENGINE_VALUES: ConcreteTTSEngine[] = ["espeak-ng", "edge", "elevenlabs", "openai", "sapi"];
const SAPI_VOLUME_VALUES = ["silent", "x-soft", "soft", "medium", "loud", "x-loud"] as const;

const SAPI_VOLUME_TO_PERCENT: Record<(typeof SAPI_VOLUME_VALUES)[number], number> = {
	silent: 0,
	"x-soft": 20,
	soft: 40,
	medium: 65,
	loud: 85,
	"x-loud": 100,
};

const DEFAULT_WEBHOOK_EVENTS: NotificationType[] = [...NOTIFICATION_TYPE_VALUES];

export const INLINE_NOTIFY_TEXT: Record<NotificationType, string> = {
	idle: "✅ Agent finished its current task.",
	permission: "⚠️ Permission approval is pending.",
	question: "❓ Agent needs your input.",
	error: "❌ Agent encountered an error.",
};

export const SOUND_FILE_FIELD: Record<NotificationType, SoundFileField> = {
	idle: "idleSoundFile",
	permission: "permissionSoundFile",
	question: "questionSoundFile",
	error: "errorSoundFile",
};

export const SOUND_LOOPS: Record<NotificationType, number> = {
	idle: 1,
	permission: 2,
	question: 1,
	error: 2,
};

export const MESSAGE_LIBRARY: Record<NotificationType, MessageSet> = {
	idle: {
		initial: [
			"All done. Your latest task has completed.",
			"Task finished. Ready whenever you are.",
			"Done. Please review the latest result.",
		],
		reminder: [
			"Reminder: the task is complete and waiting for you.",
			"Heads up, your finished result is still waiting.",
		],
	},
	permission: {
		initial: [
			"Permission required. Please check your terminal.",
			"I need approval before I can continue.",
		],
		reminder: [
			"Reminder: permission is still pending.",
			"I am still waiting for your approval.",
		],
	},
	question: {
		initial: [
			"I have a question for you in the terminal.",
			"Input required. Please answer the pending question.",
		],
		reminder: [
			"Reminder: I still need your answer.",
			"Question pending. Please respond when ready.",
		],
	},
	error: {
		initial: [
			"The agent hit an error. Please inspect the latest output.",
			"An error occurred and needs your attention.",
		],
		reminder: [
			"Reminder: there is still an unresolved error.",
			"The error is still pending your attention.",
		],
	},
};

export const QUESTION_HINTS = ["question", "need your input", "please answer", "requires your input"];

export const DEFAULT_CONFIG: VoiceNotifyConfig = {
	version: 1,
	enabled: true,
	windowsOptimized: true,
	notificationMode: "sound-first",
	enableSound: true,
	enableTts: true,
	ttsEngine: "auto",
	enableDesktopNotification: true,
	desktopNotificationTimeout: 8,
	wakeMonitor: true,
	idleThresholdSeconds: 30,
	enableIdleNotification: true,
	enablePermissionNotification: true,
	enableForwardedPermissionWatcher: true,
	includeForwardedPermissionAgentName: true,
	watchLegacyForwardedPermissionPath: true,
	enableQuestionNotification: true,
	enableErrorNotification: true,
	reminderEnabled: true,
	reminderDelaySeconds: 30,
	followUpEnabled: true,
	maxFollowUps: 3,
	followUpBackoffMultiplier: 1.5,
	minNotificationIntervalMs: 1500,
	suppressIdleAfterError: true,

	skipWhenFocused: false,
	focusCacheTtl: 400,
	focusCacheTtlMs: 400,

	voice: "Microsoft Zira Desktop",
	rate: -1,
	volume: 85,
	fallbackChain: ["edge", "espeak-ng", "sapi"],
	commandTimeoutMs: 30_000,

	ttsVoice: "Microsoft Zira Desktop",
	ttsRate: -1,
	sapiVoice: "Microsoft Zira Desktop",
	sapiRate: -1,
	sapiPitch: "medium",
	sapiVolume: "loud",

	edgeVoice: "en-US-JennyNeural",
	edgeRate: "+10%",
	edgePitch: "+0Hz",
	edgeVolume: "+0%",
	espeakVoice: "en",
	espeakRate: 175,
	espeakPitch: 50,
	elevenLabsApiKey: "",
	elevenLabsVoiceId: "cgSgspJ2msm6clMCkdW9",
	elevenLabsModel: "eleven_turbo_v2_5",
	elevenLabsStability: 0.5,
	elevenLabsSimilarity: 0.75,
	elevenLabsStyle: 0.5,
	openaiTtsEndpoint: "",
	openaiTtsApiKey: "",
	openaiTtsModel: "tts-1",
	openaiTtsVoice: "alloy",
	openaiTtsFormat: "mp3",
	openaiTtsSpeed: 1,

	idleSoundFile: "assets/soft-notification.mp3",
	permissionSoundFile: "assets/attention-alert.mp3",
	questionSoundFile: "assets/attention-alert.mp3",
	errorSoundFile: "assets/attention-alert.mp3",
	themePath: "",
	themeName: "default",
	themesRootPath: "",
	themeConfigPath: "",
	customSoundDirectories: [],
	perProjectSounds: false,
	enablePerProjectSounds: false,
	randomizeThemeSounds: true,
	themeDefaultVolume: 100,

	webhook: {
		enabled: false,
		discordUrl: "",
		genericUrl: "",
		events: [...DEFAULT_WEBHOOK_EVENTS],
		mentionOnPermission: false,
		username: "Pi Smart Notify",
		minIntervalMs: 1500,
		maxRetries: 3,
		requestTimeoutMs: 8000,
	},
	enableWebhook: false,
	webhookEnabled: false,
	discordWebhookUrl: "",
	genericWebhookUrl: "",
	webhookEvents: [...DEFAULT_WEBHOOK_EVENTS],

	aiMessages: {
		enabled: false,
		endpoint: "http://localhost:11434/v1",
		model: "llama3",
		apiKey: "",
		timeoutMs: 15000,
		temperature: 0.7,
		maxTokens: 120,
		fallbackToTemplates: true,
		personality: "helpful assistant",
		tone: "friendly and concise",
		caching: {
			enabled: true,
			ttlMs: 60_000,
			maxEntries: 200,
		},
		templates: {},
	},
	enableAIMessages: false,
	aiEndpoint: "http://localhost:11434/v1",
	aiModel: "llama3",
	aiApiKey: "",
	aiTimeoutMs: 15000,
	aiTemperature: 0.7,
	aiMaxTokens: 120,
	aiFallbackToTemplates: true,
	personality: "helpful assistant",
	tone: "friendly and concise",
	aiPersonality: "helpful assistant",
	aiTone: "friendly and concise",
	enableMessageCache: true,
	messageCacheTtlMs: 60_000,
	maxCacheEntries: 200,
	aiTemplates: {},

	reminderIntervals: {
		defaultSeconds: 30,
		idleSeconds: 30,
		permissionSeconds: 20,
		questionSeconds: 25,
		errorSeconds: 20,
	},
	reminderEscalation: {
		enabled: true,
		maxFollowUps: 3,
		backoffMultiplier: 1.5,
	},

	debugLog: false,
};

export function toRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function readEnv(...keys: string[]): string {
	for (const key of keys) {
		const value = process.env[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return "";
}

function parseEnvBool(value: string): boolean | undefined {
	if (!value) {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	return undefined;
}

function parseNumeric(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const numeric = parseNumeric(value);
	if (numeric === undefined) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	const numeric = parseNumeric(value);
	if (numeric === undefined) {
		return fallback;
	}
	return Math.min(max, Math.max(min, numeric));
}

export function normalizeFloat(value: number, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, value));
}

function boolOrDefault(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const parsed = parseEnvBool(value);
		if (parsed !== undefined) {
			return parsed;
		}
	}
	return fallback;
}

function stringOrDefault(value: unknown, fallback: string): string {
	if (typeof value === "string") {
		const normalized = value.trim();
		return normalized.length > 0 ? normalized : fallback;
	}
	return fallback;
}

const LEGACY_BUNDLED_SOUND_FILES: Record<string, string> = {
	"assets/machine-alert-beep-sound-effect.mp3": "assets/attention-alert.mp3",
	"assets/soft-high-tech-notification-sound-effect.mp3": "assets/soft-notification.mp3",
};

function normalizeSoundFileLookup(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function soundFileExists(value: string): boolean {
	return existsSync(isAbsolute(value) ? value : join(CONFIG_DIR, value));
}

function normalizeSoundFile(value: unknown, fallback: string): string {
	const selected = stringOrDefault(value, fallback);
	const lookup = normalizeSoundFileLookup(selected);
	const migrated = LEGACY_BUNDLED_SOUND_FILES[lookup];
	if (migrated) {
		return migrated;
	}

	if (lookup.startsWith("assets/") && !soundFileExists(selected) && soundFileExists(fallback)) {
		return fallback;
	}

	return selected;
}

function stringOrEmpty(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	return "";
}

function normalizeStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		const normalized = value
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter((entry) => entry.length > 0);
		return [...new Set(normalized)];
	}
	if (typeof value === "string") {
		const normalized = value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		return [...new Set(normalized)];
	}
	return [];
}

function normalizeNotificationTypes(value: unknown, fallback: NotificationType[]): NotificationType[] {
	const candidates = normalizeStringArray(value)
		.map((entry) => entry.toLowerCase())
		.filter((entry): entry is NotificationType => NOTIFICATION_TYPE_VALUES.includes(entry as NotificationType));
	return candidates.length > 0 ? [...new Set(candidates)] : [...fallback];
}

function normalizeFallbackChain(value: unknown, fallback: ConcreteTTSEngine[]): ConcreteTTSEngine[] {
	const candidates = normalizeStringArray(value)
		.map((entry) => entry.toLowerCase())
		.filter((entry): entry is ConcreteTTSEngine => CONCRETE_TTS_ENGINE_VALUES.includes(entry as ConcreteTTSEngine));
	return candidates.length > 0 ? [...new Set(candidates)] : [...fallback];
}

function normalizeTemplates(value: unknown): Partial<Record<string, string[]>> {
	const record = toRecord(value);
	const templates: Partial<Record<string, string[]>> = {};

	for (const [eventType, rawTemplates] of Object.entries(record)) {
		if (typeof rawTemplates === "string") {
			const message = rawTemplates.trim();
			if (message.length > 0) {
				templates[eventType] = [message];
			}
			continue;
		}
		if (!Array.isArray(rawTemplates)) {
			continue;
		}
		const normalized = rawTemplates
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter((entry) => entry.length > 0);
		if (normalized.length > 0) {
			templates[eventType] = normalized;
		}
	}

	return templates;
}

function normalizeSapiVolume(value: unknown, fallback: VoiceNotifyConfig["sapiVolume"]): VoiceNotifyConfig["sapiVolume"] {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (SAPI_VOLUME_VALUES.includes(normalized as (typeof SAPI_VOLUME_VALUES)[number])) {
		return normalized as VoiceNotifyConfig["sapiVolume"];
	}
	return fallback;
}

function isDiscordWebhookUrl(url: string): boolean {
	if (!url) {
		return false;
	}
	try {
		const parsed = new URL(url);
		if (!["https:", "http:"].includes(parsed.protocol)) {
			return false;
		}
		const host = parsed.hostname.toLowerCase();
		if (!["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(host)) {
			return false;
		}
		return parsed.pathname.includes("/api/webhooks/");
	} catch {
		return false;
	}
}

function isHttpUrl(url: string): boolean {
	if (!url) {
		return false;
	}
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}

export function normalizeMode(value: unknown): NotificationMode {
	if (typeof value === "string" && NOTIFICATION_MODES.includes(value as NotificationMode)) {
		return value as NotificationMode;
	}
	return DEFAULT_CONFIG.notificationMode;
}

export function normalizeTtsEngine(value: unknown): TTSEngine {
	if (typeof value === "string" && TTS_ENGINE_VALUES.includes(value as TTSEngine)) {
		return value as TTSEngine;
	}
	return DEFAULT_CONFIG.ttsEngine;
}

export function normalizeConfig(raw: unknown): VoiceNotifyConfig {
	const record = toRecord(raw);
	const webhookRecord = toRecord(record.webhook);
	const aiMessagesRecord = toRecord(record.aiMessages);
	const aiCacheRecord = toRecord(aiMessagesRecord.caching);
	const reminderIntervalsRecord = toRecord(record.reminderIntervals);
	const reminderEscalationRecord = toRecord(record.reminderEscalation);

	const legacyWebhookUrl = stringOrEmpty(record.webhookUrl);
	const hasExplicitDiscordWebhook = stringOrEmpty(record.discordWebhookUrl).length > 0;
	const inferredDiscordWebhookUrl =
		isDiscordWebhookUrl(legacyWebhookUrl) && !hasExplicitDiscordWebhook ? legacyWebhookUrl : "";
	const inferredGenericWebhookUrl =
		!isDiscordWebhookUrl(legacyWebhookUrl) && legacyWebhookUrl.length > 0 ? legacyWebhookUrl : "";

	const reminderEnabled = boolOrDefault(record.reminderEnabled ?? record.enableTTSReminder, DEFAULT_CONFIG.reminderEnabled);
	const reminderDefaultSeconds = clampInt(
		record.reminderDelaySeconds ?? record.ttsReminderDelaySeconds ?? reminderIntervalsRecord.defaultSeconds,
		DEFAULT_CONFIG.reminderIntervals.defaultSeconds,
		5,
		1_800,
	);

	const reminderIntervals = {
		defaultSeconds: reminderDefaultSeconds,
		idleSeconds: clampInt(
			reminderIntervalsRecord.idleSeconds ?? record.idleReminderDelaySeconds,
			DEFAULT_CONFIG.reminderIntervals.idleSeconds,
			5,
			1_800,
		),
		permissionSeconds: clampInt(
			reminderIntervalsRecord.permissionSeconds ?? record.permissionReminderDelaySeconds,
			DEFAULT_CONFIG.reminderIntervals.permissionSeconds,
			5,
			1_800,
		),
		questionSeconds: clampInt(
			reminderIntervalsRecord.questionSeconds ?? record.questionReminderDelaySeconds,
			DEFAULT_CONFIG.reminderIntervals.questionSeconds,
			5,
			1_800,
		),
		errorSeconds: clampInt(
			reminderIntervalsRecord.errorSeconds ?? record.errorReminderDelaySeconds,
			DEFAULT_CONFIG.reminderIntervals.errorSeconds,
			5,
			1_800,
		),
	};

	const reminderEscalation = {
		enabled: boolOrDefault(
			reminderEscalationRecord.enabled ?? record.followUpEnabled ?? record.enableFollowUpReminders,
			DEFAULT_CONFIG.reminderEscalation.enabled,
		),
		maxFollowUps: clampInt(
			reminderEscalationRecord.maxFollowUps ?? record.maxFollowUps ?? record.maxFollowUpReminders,
			DEFAULT_CONFIG.reminderEscalation.maxFollowUps,
			0,
			10,
		),
		backoffMultiplier: clampNumber(
			reminderEscalationRecord.backoffMultiplier ??
				record.followUpBackoffMultiplier ??
				record.reminderBackoffMultiplier,
			DEFAULT_CONFIG.reminderEscalation.backoffMultiplier,
			1,
			5,
		),
	};

	const normalizedSapiVolume = normalizeSapiVolume(record.sapiVolume, DEFAULT_CONFIG.sapiVolume);
	const normalizedVolume = clampInt(
		record.volume ?? record.ttsVolume ?? SAPI_VOLUME_TO_PERCENT[normalizedSapiVolume],
		DEFAULT_CONFIG.volume,
		0,
		100,
	);

	const voice = stringOrDefault(record.voice ?? record.ttsVoice ?? record.sapiVoice, DEFAULT_CONFIG.voice);
	const rate = clampInt(record.rate ?? record.ttsRate ?? record.sapiRate, DEFAULT_CONFIG.rate, -10, 10);

	const aiTemplates = normalizeTemplates(aiMessagesRecord.templates ?? record.aiTemplates ?? record.aiPrompts);

	const webhookEvents = normalizeNotificationTypes(
		webhookRecord.events ?? record.webhookEvents ?? record.eventAllowList,
		DEFAULT_CONFIG.webhook.events,
	);

	const webhookEnabled = boolOrDefault(
		webhookRecord.enabled ?? record.webhookEnabled ?? record.enableWebhook,
		DEFAULT_CONFIG.webhook.enabled,
	);

	const webhookDiscordUrl = stringOrEmpty(
		webhookRecord.discordUrl ?? webhookRecord.discordWebhookUrl ?? record.discordWebhookUrl ?? inferredDiscordWebhookUrl,
	);
	const webhookGenericUrl = stringOrEmpty(
		webhookRecord.genericUrl ?? webhookRecord.genericWebhookUrl ?? record.genericWebhookUrl ?? inferredGenericWebhookUrl,
	);

	const webhookUsername = stringOrDefault(
		webhookRecord.username ?? record.webhookUsername,
		DEFAULT_CONFIG.webhook.username,
	);
	const webhookMentionOnPermission = boolOrDefault(
		webhookRecord.mentionOnPermission ?? record.webhookMentionOnPermission,
		DEFAULT_CONFIG.webhook.mentionOnPermission,
	);
	const webhookMinIntervalMs = clampInt(
		webhookRecord.minIntervalMs ?? record.webhookMinIntervalMs,
		DEFAULT_CONFIG.webhook.minIntervalMs,
		0,
		60_000,
	);
	const webhookMaxRetries = clampInt(
		webhookRecord.maxRetries ?? record.webhookMaxRetries,
		DEFAULT_CONFIG.webhook.maxRetries,
		0,
		10,
	);
	const webhookRequestTimeoutMs = clampInt(
		webhookRecord.requestTimeoutMs ?? record.webhookRequestTimeoutMs,
		DEFAULT_CONFIG.webhook.requestTimeoutMs,
		500,
		120_000,
	);

	const aiEnabled = boolOrDefault(
		aiMessagesRecord.enabled ?? record.enableAIMessages,
		DEFAULT_CONFIG.aiMessages.enabled,
	);
	const aiEndpoint = stringOrDefault(aiMessagesRecord.endpoint ?? record.aiEndpoint, DEFAULT_CONFIG.aiMessages.endpoint);
	const aiModel = stringOrDefault(aiMessagesRecord.model ?? record.aiModel, DEFAULT_CONFIG.aiMessages.model);
	const aiApiKey = stringOrEmpty(aiMessagesRecord.apiKey ?? record.aiApiKey);
	const aiTimeoutMs = clampInt(
		aiMessagesRecord.timeoutMs ?? record.aiTimeoutMs ?? record.aiTimeout,
		DEFAULT_CONFIG.aiMessages.timeoutMs,
		1_000,
		120_000,
	);
	const aiTemperature = clampNumber(
		aiMessagesRecord.temperature ?? record.aiTemperature,
		DEFAULT_CONFIG.aiMessages.temperature,
		0,
		2,
	);
	const aiMaxTokens = clampInt(
		aiMessagesRecord.maxTokens ?? record.aiMaxTokens,
		DEFAULT_CONFIG.aiMessages.maxTokens,
		40,
		2_000,
	);
	const aiFallbackToTemplates = boolOrDefault(
		aiMessagesRecord.fallbackToTemplates ?? record.aiFallbackToTemplates ?? record.aiFallbackToStatic,
		DEFAULT_CONFIG.aiMessages.fallbackToTemplates,
	);
	const personality = stringOrDefault(
		aiMessagesRecord.personality ?? record.aiPersonality ?? record.personality,
		DEFAULT_CONFIG.aiMessages.personality,
	);
	const tone = stringOrDefault(aiMessagesRecord.tone ?? record.aiTone ?? record.tone, DEFAULT_CONFIG.aiMessages.tone);
	const enableMessageCache = boolOrDefault(
		aiCacheRecord.enabled ?? record.enableMessageCache,
		DEFAULT_CONFIG.aiMessages.caching.enabled,
	);
	const messageCacheTtlMs = clampInt(
		aiCacheRecord.ttlMs ?? record.messageCacheTtlMs,
		DEFAULT_CONFIG.aiMessages.caching.ttlMs,
		5_000,
		600_000,
	);
	const maxCacheEntries = clampInt(
		aiCacheRecord.maxEntries ?? record.maxCacheEntries,
		DEFAULT_CONFIG.aiMessages.caching.maxEntries,
		20,
		5_000,
	);
	const focusCacheTtlMs = clampInt(
		record.focusCacheTtlMs ?? record.focusCacheTtl,
		DEFAULT_CONFIG.focusCacheTtlMs,
		100,
		60_000,
	);
	const perProjectSounds = boolOrDefault(
		record.enablePerProjectSounds ?? record.perProjectSounds,
		DEFAULT_CONFIG.perProjectSounds,
	);

	return {
		version: 1,
		enabled: boolOrDefault(record.enabled, DEFAULT_CONFIG.enabled),
		windowsOptimized: boolOrDefault(record.windowsOptimized, DEFAULT_CONFIG.windowsOptimized),
		notificationMode: normalizeMode(record.notificationMode),
		enableSound: boolOrDefault(record.enableSound, DEFAULT_CONFIG.enableSound),
		enableTts: boolOrDefault(record.enableTts ?? record.enableTTS, DEFAULT_CONFIG.enableTts),
		ttsEngine: normalizeTtsEngine(record.ttsEngine),
		enableDesktopNotification: boolOrDefault(
			record.enableDesktopNotification,
			DEFAULT_CONFIG.enableDesktopNotification,
		),
		desktopNotificationTimeout: clampInt(
			record.desktopNotificationTimeout,
			DEFAULT_CONFIG.desktopNotificationTimeout,
			1,
			60,
		),
		wakeMonitor: boolOrDefault(record.wakeMonitor, DEFAULT_CONFIG.wakeMonitor),
		idleThresholdSeconds: clampInt(record.idleThresholdSeconds, DEFAULT_CONFIG.idleThresholdSeconds, 5, 600),
		enableIdleNotification: boolOrDefault(record.enableIdleNotification, DEFAULT_CONFIG.enableIdleNotification),
		enablePermissionNotification: boolOrDefault(
			record.enablePermissionNotification,
			DEFAULT_CONFIG.enablePermissionNotification,
		),
		enableForwardedPermissionWatcher: boolOrDefault(
			record.enableForwardedPermissionWatcher,
			DEFAULT_CONFIG.enableForwardedPermissionWatcher,
		),
		includeForwardedPermissionAgentName: boolOrDefault(
			record.includeForwardedPermissionAgentName,
			DEFAULT_CONFIG.includeForwardedPermissionAgentName,
		),
		watchLegacyForwardedPermissionPath: boolOrDefault(
			record.watchLegacyForwardedPermissionPath,
			DEFAULT_CONFIG.watchLegacyForwardedPermissionPath,
		),
		enableQuestionNotification: boolOrDefault(
			record.enableQuestionNotification,
			DEFAULT_CONFIG.enableQuestionNotification,
		),
		enableErrorNotification: boolOrDefault(record.enableErrorNotification, DEFAULT_CONFIG.enableErrorNotification),
		reminderEnabled,
		reminderDelaySeconds: reminderDefaultSeconds,
		followUpEnabled: reminderEscalation.enabled,
		maxFollowUps: reminderEscalation.maxFollowUps,
		followUpBackoffMultiplier: reminderEscalation.backoffMultiplier,
		minNotificationIntervalMs: clampInt(
			record.minNotificationIntervalMs,
			DEFAULT_CONFIG.minNotificationIntervalMs,
			0,
			60_000,
		),
		suppressIdleAfterError: boolOrDefault(record.suppressIdleAfterError, DEFAULT_CONFIG.suppressIdleAfterError),

		skipWhenFocused: boolOrDefault(record.skipWhenFocused ?? record.suppressWhenFocused, DEFAULT_CONFIG.skipWhenFocused),
		focusCacheTtl: focusCacheTtlMs,
		focusCacheTtlMs,

		voice,
		rate,
		volume: normalizedVolume,
		fallbackChain: normalizeFallbackChain(record.fallbackChain, DEFAULT_CONFIG.fallbackChain),
		commandTimeoutMs: clampInt(record.commandTimeoutMs, DEFAULT_CONFIG.commandTimeoutMs, 3_000, 120_000),

		ttsVoice: stringOrDefault(record.ttsVoice ?? record.sapiVoice ?? record.voice, DEFAULT_CONFIG.ttsVoice),
		ttsRate: clampInt(record.ttsRate ?? record.sapiRate ?? record.rate, DEFAULT_CONFIG.ttsRate, -10, 10),
		sapiVoice: stringOrDefault(record.sapiVoice ?? record.ttsVoice ?? record.voice, DEFAULT_CONFIG.sapiVoice),
		sapiRate: clampInt(record.sapiRate ?? record.ttsRate ?? record.rate, DEFAULT_CONFIG.sapiRate, -10, 10),
		sapiPitch: stringOrDefault(record.sapiPitch, DEFAULT_CONFIG.sapiPitch),
		sapiVolume: normalizedSapiVolume,

		edgeVoice: stringOrDefault(record.edgeVoice, DEFAULT_CONFIG.edgeVoice),
		edgeRate: stringOrDefault(record.edgeRate, DEFAULT_CONFIG.edgeRate),
		edgePitch: stringOrDefault(record.edgePitch, DEFAULT_CONFIG.edgePitch),
		edgeVolume: stringOrDefault(record.edgeVolume, DEFAULT_CONFIG.edgeVolume),
		espeakVoice: stringOrDefault(record.espeakVoice, DEFAULT_CONFIG.espeakVoice),
		espeakRate: clampInt(record.espeakRate, DEFAULT_CONFIG.espeakRate, 80, 450),
		espeakPitch: clampInt(record.espeakPitch, DEFAULT_CONFIG.espeakPitch, 0, 99),
		elevenLabsApiKey: stringOrEmpty(record.elevenLabsApiKey),
		elevenLabsVoiceId: stringOrDefault(record.elevenLabsVoiceId, DEFAULT_CONFIG.elevenLabsVoiceId),
		elevenLabsModel: stringOrDefault(record.elevenLabsModel, DEFAULT_CONFIG.elevenLabsModel),
		elevenLabsStability: clampNumber(record.elevenLabsStability, DEFAULT_CONFIG.elevenLabsStability, 0, 1),
		elevenLabsSimilarity: clampNumber(record.elevenLabsSimilarity, DEFAULT_CONFIG.elevenLabsSimilarity, 0, 1),
		elevenLabsStyle: clampNumber(record.elevenLabsStyle, DEFAULT_CONFIG.elevenLabsStyle, 0, 1),
		openaiTtsEndpoint: stringOrEmpty(record.openaiTtsEndpoint),
		openaiTtsApiKey: stringOrEmpty(record.openaiTtsApiKey),
		openaiTtsModel: stringOrDefault(record.openaiTtsModel, DEFAULT_CONFIG.openaiTtsModel),
		openaiTtsVoice: stringOrDefault(record.openaiTtsVoice, DEFAULT_CONFIG.openaiTtsVoice),
		openaiTtsFormat: stringOrDefault(record.openaiTtsFormat, DEFAULT_CONFIG.openaiTtsFormat),
		openaiTtsSpeed: clampNumber(record.openaiTtsSpeed, DEFAULT_CONFIG.openaiTtsSpeed, 0.25, 4),

		idleSoundFile: normalizeSoundFile(record.idleSoundFile ?? record.idleSound, DEFAULT_CONFIG.idleSoundFile),
		permissionSoundFile: normalizeSoundFile(
			record.permissionSoundFile ?? record.permissionSound,
			DEFAULT_CONFIG.permissionSoundFile,
		),
		questionSoundFile: normalizeSoundFile(record.questionSoundFile ?? record.questionSound, DEFAULT_CONFIG.questionSoundFile),
		errorSoundFile: normalizeSoundFile(record.errorSoundFile ?? record.errorSound, DEFAULT_CONFIG.errorSoundFile),
		themePath: stringOrEmpty(record.themePath ?? record.soundThemeDir ?? record.themeDirectory),
		themeName: stringOrDefault(record.themeName, DEFAULT_CONFIG.themeName),
		themesRootPath: stringOrEmpty(record.themesRootPath ?? record.themesRootDirectory),
		themeConfigPath: stringOrEmpty(record.themeConfigPath),
		customSoundDirectories: normalizeStringArray(record.customSoundDirectories),
		perProjectSounds,
		enablePerProjectSounds: perProjectSounds,
		randomizeThemeSounds: boolOrDefault(
			record.randomizeThemeSounds ?? record.randomizeSoundFromTheme ?? record.randomizeSounds,
			DEFAULT_CONFIG.randomizeThemeSounds,
		),
		themeDefaultVolume: clampInt(
			record.themeDefaultVolume ?? record.defaultVolume,
			DEFAULT_CONFIG.themeDefaultVolume,
			0,
			100,
		),

		webhook: {
			enabled: webhookEnabled,
			discordUrl: webhookDiscordUrl,
			genericUrl: webhookGenericUrl,
			events: webhookEvents,
			mentionOnPermission: webhookMentionOnPermission,
			username: webhookUsername,
			minIntervalMs: webhookMinIntervalMs,
			maxRetries: webhookMaxRetries,
			requestTimeoutMs: webhookRequestTimeoutMs,
		},
		enableWebhook: webhookEnabled,
		webhookEnabled,
		discordWebhookUrl: webhookDiscordUrl,
		genericWebhookUrl: webhookGenericUrl,
		webhookEvents,

		aiMessages: {
			enabled: aiEnabled,
			endpoint: aiEndpoint,
			model: aiModel,
			apiKey: aiApiKey,
			timeoutMs: aiTimeoutMs,
			temperature: aiTemperature,
			maxTokens: aiMaxTokens,
			fallbackToTemplates: aiFallbackToTemplates,
			personality,
			tone,
			caching: {
				enabled: enableMessageCache,
				ttlMs: messageCacheTtlMs,
				maxEntries: maxCacheEntries,
			},
			templates: aiTemplates,
		},
		enableAIMessages: aiEnabled,
		aiEndpoint,
		aiModel,
		aiApiKey,
		aiTimeoutMs,
		aiTemperature,
		aiMaxTokens,
		aiFallbackToTemplates,
		personality,
		tone,
		aiPersonality: personality,
		aiTone: tone,
		enableMessageCache,
		messageCacheTtlMs,
		maxCacheEntries,
		aiTemplates,

		reminderIntervals,
		reminderEscalation,
		debugLog: boolOrDefault(record.debugLog, DEFAULT_CONFIG.debugLog),
	};
}

function applyEnvironmentOverrides(config: VoiceNotifyConfig): VoiceNotifyConfig {
	const elevenLabsApiKey = readEnv("ELEVENLABS_API_KEY", "PI_SMART_VOICE_NOTIFY_ELEVENLABS_API_KEY");
	const openaiTtsApiKey = readEnv("OPENAI_TTS_API_KEY", "PI_SMART_VOICE_NOTIFY_OPENAI_TTS_API_KEY", "OPENAI_API_KEY");
	const openaiTtsEndpoint = readEnv("OPENAI_TTS_ENDPOINT", "PI_SMART_VOICE_NOTIFY_OPENAI_TTS_ENDPOINT");
	const aiApiKey = readEnv("PI_SMART_NOTIFY_AI_API_KEY", "PI_SMART_VOICE_NOTIFY_AI_API_KEY", "OPENAI_API_KEY");
	const aiEndpoint = readEnv("PI_SMART_NOTIFY_AI_ENDPOINT", "PI_SMART_VOICE_NOTIFY_AI_ENDPOINT");
	const discordWebhookUrl = readEnv(
		"PI_SMART_NOTIFY_DISCORD_WEBHOOK_URL",
		"PI_SMART_VOICE_NOTIFY_DISCORD_WEBHOOK_URL",
		"DISCORD_WEBHOOK_URL",
	);
	const genericWebhookUrl = readEnv(
		"PI_SMART_NOTIFY_WEBHOOK_URL",
		"PI_SMART_VOICE_NOTIFY_WEBHOOK_URL",
		"WEBHOOK_URL",
	);
	const webhookEvents = normalizeNotificationTypes(
		readEnv("PI_SMART_NOTIFY_WEBHOOK_EVENTS", "WEBHOOK_EVENTS"),
		config.webhook.events,
	);
	const webhookEnabledFromEnv = parseEnvBool(readEnv("PI_SMART_NOTIFY_WEBHOOK_ENABLED", "WEBHOOK_ENABLED"));

	const nextConfig: VoiceNotifyConfig = {
		...config,
		elevenLabsApiKey: elevenLabsApiKey || config.elevenLabsApiKey,
		openaiTtsApiKey: openaiTtsApiKey || config.openaiTtsApiKey,
		openaiTtsEndpoint: openaiTtsEndpoint || config.openaiTtsEndpoint,
		aiApiKey: aiApiKey || config.aiApiKey,
		aiEndpoint: aiEndpoint || config.aiEndpoint,
		discordWebhookUrl: discordWebhookUrl || config.discordWebhookUrl,
		genericWebhookUrl: genericWebhookUrl || config.genericWebhookUrl,
		webhookEvents,
		enableWebhook: webhookEnabledFromEnv ?? config.webhookEnabled ?? config.enableWebhook,
		webhookEnabled: webhookEnabledFromEnv ?? config.webhookEnabled ?? config.enableWebhook,
	};

	nextConfig.webhook = {
		...nextConfig.webhook,
		discordUrl: nextConfig.discordWebhookUrl,
		genericUrl: nextConfig.genericWebhookUrl,
		events: [...nextConfig.webhookEvents],
		enabled: nextConfig.enableWebhook,
	};

	nextConfig.aiMessages = {
		...nextConfig.aiMessages,
		apiKey: nextConfig.aiApiKey,
		endpoint: nextConfig.aiEndpoint,
	};

	return nextConfig;
}

export interface ConfigValidationIssue {
	path: string;
	message: string;
}

export interface ConfigValidationResult {
	config: VoiceNotifyConfig;
	issues: ConfigValidationIssue[];
}

export function validateConfig(config: VoiceNotifyConfig): ConfigValidationResult {
	const issues: ConfigValidationIssue[] = [];
	const nextConfig = normalizeConfig(config);

	if (nextConfig.webhook.discordUrl.length > 0 && !isDiscordWebhookUrl(nextConfig.webhook.discordUrl)) {
		issues.push({
			path: "webhook.discordUrl",
			message: "Discord webhook URL must be a valid discord webhook endpoint.",
		});
		nextConfig.webhook.discordUrl = "";
		nextConfig.discordWebhookUrl = "";
	}

	if (nextConfig.webhook.genericUrl.length > 0 && !isHttpUrl(nextConfig.webhook.genericUrl)) {
		issues.push({
			path: "webhook.genericUrl",
			message: "Generic webhook URL must be a valid HTTP/HTTPS URL.",
		});
		nextConfig.webhook.genericUrl = "";
		nextConfig.genericWebhookUrl = "";
	}

	if (nextConfig.webhook.enabled && !nextConfig.webhook.discordUrl && !nextConfig.webhook.genericUrl) {
		issues.push({
			path: "webhook.enabled",
			message: "Webhook was enabled but no webhook URLs were configured. Auto-disabled.",
		});
		nextConfig.webhook.enabled = false;
		nextConfig.enableWebhook = false;
		nextConfig.webhookEnabled = false;
	}

	if (nextConfig.webhook.events.length === 0) {
		issues.push({
			path: "webhook.events",
			message: "Webhook events list was empty. Defaults restored.",
		});
		nextConfig.webhook.events = [...DEFAULT_WEBHOOK_EVENTS];
		nextConfig.webhookEvents = [...DEFAULT_WEBHOOK_EVENTS];
	}

	return {
		config: nextConfig,
		issues,
	};
}

export function ensureConfigDirectory(): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
	}
}

export function ensureDebugDirectory(): void {
	if (!existsSync(DEBUG_DIR)) {
		mkdirSync(DEBUG_DIR, { recursive: true });
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge `override` onto `base`. Nested objects merge; arrays and scalars replace. */
export function deepMergeConfigRecords(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = result[key];
		result[key] = isPlainObject(existing) && isPlainObject(value)
			? deepMergeConfigRecords(existing, value)
			: value;
	}
	return result;
}

function readConfigRecord(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) {
		return null;
	}
	try {
		return toRecord(JSON.parse(readFileSync(path, "utf-8")) as unknown);
	} catch {
		return null;
	}
}

/** Load and self-heal the global config file, returning its raw record. */
function loadGlobalConfigRecord(): Record<string, unknown> {
	ensureConfigDirectory();
	const defaultsSerialized = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
	if (!existsSync(CONFIG_PATH)) {
		writeFileSync(CONFIG_PATH, defaultsSerialized, "utf-8");
		return toRecord(JSON.parse(defaultsSerialized));
	}

	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		const serialized = `${JSON.stringify(validateConfig(normalizeConfig(parsed)).config, null, 2)}\n`;
		if (raw !== serialized) {
			writeFileSync(CONFIG_PATH, serialized, "utf-8");
		}
		return toRecord(parsed);
	} catch {
		writeFileSync(CONFIG_PATH, defaultsSerialized, "utf-8");
		return toRecord(JSON.parse(defaultsSerialized));
	}
}

/**
 * Read the effective config. When `projectRoot` is given and a project config
 * exists, it deep-merges over the global config; environment variables still
 * override both. The project file is read-only — only the global file is healed.
 */
export function readConfigFromDisk(projectRoot?: string): VoiceNotifyConfig {
	let record = loadGlobalConfigRecord();
	if (projectRoot) {
		const projectRecord = readConfigRecord(resolveProjectConfigPath(projectRoot));
		if (projectRecord) {
			record = deepMergeConfigRecords(record, projectRecord);
		}
	}
	const runtimeConfig = applyEnvironmentOverrides(validateConfig(normalizeConfig(record)).config);
	return validateConfig(runtimeConfig).config;
}

export function writeConfigToDisk(config: VoiceNotifyConfig): void {
	ensureConfigDirectory();
	const normalized = normalizeConfig(config);
	const validation = validateConfig(normalized);
	writeFileSync(CONFIG_PATH, `${JSON.stringify(validation.config, null, 2)}\n`, "utf-8");
}

export function boolValue(value: string): boolean {
	return value === "on";
}

export function isWindows(): boolean {
	return process.platform === "win32";
}

export function resolveSoundFile(config: VoiceNotifyConfig, type: NotificationType): string | null {
	const field = SOUND_FILE_FIELD[type];
	const value = normalizeSoundFile(config[field], DEFAULT_CONFIG[field]);
	if (!value.trim()) {
		return null;
	}
	if (isAbsolute(value)) {
		return value;
	}
	return join(CONFIG_DIR, value);
}

export function summarizeConfig(config: VoiceNotifyConfig): string {
	return [
		`enabled=${config.enabled}`,
		`mode=${config.notificationMode}`,
		`sound=${config.enableSound}`,
		`tts=${config.enableTts}`,
		`ttsEngine=${config.ttsEngine}`,
		`desktopNotify=${config.enableDesktopNotification}`,
		`desktopNotifyTimeout=${config.desktopNotificationTimeout}s`,
		`wakeMonitor=${config.wakeMonitor}`,
		`idleThreshold=${config.idleThresholdSeconds}s`,
		`forwardedPermissionWatcher=${config.enableForwardedPermissionWatcher}`,
		`includeForwardedPermissionAgentName=${config.includeForwardedPermissionAgentName}`,
		`watchLegacyForwardedPermissionPath=${config.watchLegacyForwardedPermissionPath}`,
		`focusSkip=${config.skipWhenFocused}`,
		`focusCacheTtl=${config.focusCacheTtl}ms`,
		`reminder=${config.reminderEnabled}`,
		`reminderDelay=${config.reminderIntervals.defaultSeconds}s`,
		`followUps=${config.reminderEscalation.enabled ? config.reminderEscalation.maxFollowUps : 0}`,
		`voice=${config.voice}`,
		`rate=${config.rate}`,
		`volume=${config.volume}`,
		`themePath=${config.themePath || "<default>"}`,
		`perProjectSounds=${config.perProjectSounds}`,
		`webhook=${config.webhook.enabled}`,
		`aiMessages=${config.aiMessages.enabled}`,
		`debugLog=${config.debugLog}`,
		`debugLogPath=${DEBUG_LOG_PATH}`,
		`config=${CONFIG_PATH}`,
	].join("\n");
}

export function isNotificationEnabled(config: VoiceNotifyConfig, type: NotificationType): boolean {
	if (type === "idle") return config.enableIdleNotification;
	if (type === "permission") return config.enablePermissionNotification;
	if (type === "question") return config.enableQuestionNotification;
	return config.enableErrorNotification;
}
