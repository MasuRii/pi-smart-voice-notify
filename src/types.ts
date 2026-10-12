import type { EngineTtsSettings } from "./shared/index.ts";

export type NotificationType = "idle" | "permission" | "question" | "error";
export type NotificationMode = "sound-first" | "tts-first" | "both" | "sound-only";
export type TTSEngine = "auto" | "espeak-ng" | "edge" | "elevenlabs" | "openai" | "sapi";
export type ConcreteTTSEngine = Exclude<TTSEngine, "auto">;
export type NotifyLevel = "info" | "warning" | "error";

export interface ReminderIntervalsConfig {
	defaultSeconds: number;
	idleSeconds: number;
	permissionSeconds: number;
	questionSeconds: number;
	errorSeconds: number;
}

export interface ReminderEscalationConfig {
	enabled: boolean;
	maxFollowUps: number;
	backoffMultiplier: number;
}

export interface WebhookSettingsConfig {
	enabled: boolean;
	discordUrl: string;
	genericUrl: string;
	events: NotificationType[];
	mentionOnPermission: boolean;
	username: string;
	minIntervalMs: number;
	maxRetries: number;
	requestTimeoutMs: number;
}

export interface AIMessageCacheConfig {
	enabled: boolean;
	ttlMs: number;
	maxEntries: number;
}

export interface AIMessageSettingsConfig {
	enabled: boolean;
	endpoint: string;
	model: string;
	apiKey: string;
	timeoutMs: number;
	temperature: number;
	maxTokens: number;
	fallbackToTemplates: boolean;
	personality: string;
	tone: string;
	caching: AIMessageCacheConfig;
	templates: Partial<Record<string, string[]>>;
}

/** Flat AI message config properties (mirrored in VoiceNotifyConfig). */
export type FlatAIMessageConfig = {
	enableAIMessages: boolean;
	aiEndpoint: string;
	aiModel: string;
	aiApiKey: string;
	aiTimeoutMs: number;
	aiTemperature: number;
	aiMaxTokens: number;
	aiFallbackToTemplates: boolean;
	personality: string;
	tone: string;
	enableMessageCache: boolean;
	messageCacheTtlMs: number;
	maxCacheEntries: number;
};

export interface VoiceNotifyConfig extends EngineTtsSettings, FlatAIMessageConfig {
	version: 1;
	enabled: boolean;
	windowsOptimized: boolean;
	notificationMode: NotificationMode;
	enableSound: boolean;
	enableTts: boolean;
	ttsEngine: TTSEngine;
	enableDesktopNotification: boolean;
	desktopNotificationTimeout: number;
	showStatusBar: boolean;
	wakeMonitor: boolean;
	idleThresholdSeconds: number;
	enableIdleNotification: boolean;
	enablePermissionNotification: boolean;
	enableForwardedPermissionWatcher: boolean;
	includeForwardedPermissionAgentName: boolean;
	watchLegacyForwardedPermissionPath: boolean;
	enableQuestionNotification: boolean;
	enableErrorNotification: boolean;
	reminderEnabled: boolean;
	reminderDelaySeconds: number;
	followUpEnabled: boolean;
	maxFollowUps: number;
	followUpBackoffMultiplier: number;
	minNotificationIntervalMs: number;
	suppressIdleAfterError: boolean;

	// Focus detection
	skipWhenFocused: boolean;
	focusCacheTtl: number;
	focusCacheTtlMs: number;

	// Generic TTS controls
	voice: string;
	rate: number;
	volume: number;
	fallbackChain: ConcreteTTSEngine[];
	commandTimeoutMs: number;

	// Legacy/Windows compatibility aliases
	ttsVoice: string;
	ttsRate: number;
	sapiVoice: string;
	sapiRate: number;
	sapiPitch: string;
	sapiVolume: string;

	// Sound files and themes

	// Sound files and themes
	idleSoundFile: string;
	permissionSoundFile: string;
	questionSoundFile: string;
	errorSoundFile: string;
	themePath: string;
	themeName: string;
	themesRootPath: string;
	themeConfigPath: string;
	customSoundDirectories: string[];
	perProjectSounds: boolean;
	enablePerProjectSounds: boolean;
	randomizeThemeSounds: boolean;
	themeDefaultVolume: number;

	// Webhook (new nested + legacy flat mirrors)
	webhook: WebhookSettingsConfig;
	enableWebhook: boolean;
	webhookEnabled: boolean;
	discordWebhookUrl: string;
	genericWebhookUrl: string;
	webhookEvents: NotificationType[];

	// AI messages (new nested + legacy flat mirrors)
	aiMessages: AIMessageSettingsConfig;
	aiPersonality: string;
	aiTone: string;
	aiTemplates: Partial<Record<string, string[]>>;

	// Reminder orchestration (new nested + legacy mirrors)
	reminderIntervals: ReminderIntervalsConfig;
	reminderEscalation: ReminderEscalationConfig;

	debugLog: boolean;
}

export interface ReminderState {
	reminderKey: string;
	type: NotificationType;
	timeoutId: NodeJS.Timeout;
	scheduledAt: number;
	followUpCount: number;
	delaySeconds: number;
}

export interface MessageSet {
	initial: string[];
	reminder: string[];
}

export type SoundFileField =
	| "idleSoundFile"
	| "permissionSoundFile"
	| "questionSoundFile"
	| "errorSoundFile";
