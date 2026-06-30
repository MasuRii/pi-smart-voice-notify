import { lookup as lookupDns } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";

import type { NotificationType } from "./types.ts";
import { getErrorMessage } from "./logging.ts";

export type WebhookEventType = NotificationType | (string & {});
export type WebhookProvider = "discord" | "generic";

type MentionValue = string | boolean;

export interface DiscordEmbedField {
	name: string;
	value: string;
	inline?: boolean;
}

export interface WebhookEvent {
	type: WebhookEventType;
	title: string;
	message: string;
	projectName?: string;
	sessionId?: string;
	count?: number;
	mention?: MentionValue;
	metadata?: Record<string, unknown>;
	payload?: unknown;
}

export interface WebhookTargetConfig {
	provider?: WebhookProvider;
	url: string;
	enabled?: boolean;
	events?: string[];
	headers?: Record<string, string>;
	mention?: MentionValue;
	username?: string;
	avatarUrl?: string;
}

export type WebhookDnsLookup = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
export type WebhookFetch = typeof fetch;

export interface WebhookConfig {
	enabled?: boolean;
	discordWebhookUrl?: string;
	genericWebhookUrl?: string;
	targets?: WebhookTargetConfig[];
	eventTriggers?: Partial<Record<string, boolean>>;
	eventAllowList?: string[];
	maxQueueSize?: number;
	minIntervalMs?: number;
	maxRetries?: number;
	baseRetryDelayMs?: number;
	requestTimeoutMs?: number;
	discordMention?: MentionValue;
	discordUsername?: string;
	discordAvatarUrl?: string;
	genericHeaders?: Record<string, string>;
	logger?: (message: string, details?: Record<string, unknown>) => void;
	dnsLookup?: WebhookDnsLookup;
	fetch?: WebhookFetch;
}

export interface WebhookDispatchResult {
	queued: number;
	skipped: boolean;
}

interface ResolvedWebhookTarget {
	provider: WebhookProvider;
	url: string;
	events: string[];
	headers: Record<string, string>;
	mention?: MentionValue;
	username?: string;
	avatarUrl?: string;
}

interface ResolvedWebhookConfig {
	enabled: boolean;
	targets: ResolvedWebhookTarget[];
	eventTriggers: Partial<Record<string, boolean>>;
	eventAllowList: string[];
	maxQueueSize: number;
	minIntervalMs: number;
	maxRetries: number;
	baseRetryDelayMs: number;
	requestTimeoutMs: number;
	discordMention?: MentionValue;
	discordUsername?: string;
	discordAvatarUrl?: string;
	logger: (message: string, details?: Record<string, unknown>) => void;
	dnsLookup: WebhookDnsLookup;
	fetch: WebhookFetch;
}

interface QueueItem {
	target: ResolvedWebhookTarget;
	event: WebhookEvent;
}

interface SendAttemptResult {
	success: boolean;
	statusCode?: number;
	retryAfterMs?: number;
	error?: string;
}

interface RateLimitState {
	lastSentAt: number;
	nextAllowedAt: number;
}

const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_MIN_INTERVAL_MS = 1_500;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 700;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

async function defaultDnsLookup(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
	const addresses = await lookupDns(hostname, { all: true, verbatim: true });
	return addresses
		.filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6)
		.map((entry) => ({ address: entry.address, family: entry.family }));
}

function defaultLogger(_message: string, _details: Record<string, unknown> = {}): void {
	// Extension logging is file-based and injected by the extension entry point when enabled.
}

const DISCORD_COLORS: Record<NotificationType | "default", number> = {
	idle: 0x2ecc71,
	permission: 0xf39c12,
	question: 0x3498db,
	error: 0xe74c3c,
	default: 0x5865f2,
};

function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Sleep with abort signal support.
 */
function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Wait was aborted."));
			return;
		}

		const handle = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		const onAbort = () => {
			clearTimeout(handle);
			reject(new Error("Wait was aborted."));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function parseBoolean(value: string | undefined): boolean | undefined {
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

function parseInteger(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed)) {
		return undefined;
	}
	return parsed;
}

function isPrivateOrReservedIPv4(address: string): boolean {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return true;
	}

	const [a = 0, b = 0] = parts;
	return (
		a === 0
		|| a === 10
		|| a === 127
		|| (a === 100 && b >= 64 && b <= 127)
		|| (a === 169 && b === 254)
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168)
		|| (a === 198 && (b === 18 || b === 19))
		|| a >= 224
	);
}

function isPrivateOrReservedIPv6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized === "::" || normalized === "::1") {
		return true;
	}

	// IPv4-mapped IPv6 in dotted-decimal form: ::ffff:127.0.0.1
	const mappedIPv4Decimal = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	if (mappedIPv4Decimal) {
		return isPrivateOrReservedIPv4(mappedIPv4Decimal);
	}

	// IPv4-mapped IPv6 in hex form: ::ffff:7f00:1 (Node.js URL parser normalizes to this)
	const mappedIPv4Hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (mappedIPv4Hex) {
		const high = Number.parseInt(mappedIPv4Hex[1]!, 16);
		const low = Number.parseInt(mappedIPv4Hex[2]!, 16);
		const a = (high >> 8) & 0xff;
		const b = high & 0xff;
		const c = (low >> 8) & 0xff;
		const d = low & 0xff;
		return isPrivateOrReservedIPv4(`${a}.${b}.${c}.${d}`);
	}

	return (
		normalized.startsWith("fc")
		|| normalized.startsWith("fd")
		|| normalized.startsWith("fe8")
		|| normalized.startsWith("fe9")
		|| normalized.startsWith("fea")
		|| normalized.startsWith("feb")
		|| normalized.startsWith("ff")
	);
}

function isPrivateOrReservedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		return isPrivateOrReservedIPv4(address);
	}
	if (family === 6) {
		return isPrivateOrReservedIPv6(address);
	}
	return true;
}

function normalizeUrlHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isInternalHostname(hostname: string): boolean {
	const normalized = normalizeUrlHostname(hostname).toLowerCase().replace(/\.$/, "");
	return (
		normalized === "localhost"
		|| normalized.endsWith(".localhost")
		|| normalized.endsWith(".local")
		|| normalized.endsWith(".internal")
		|| normalized.endsWith(".lan")
		|| normalized.endsWith(".home.arpa")
	);
}

export function isWebhookUrlAllowed(value: string): boolean {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return false;
		}

		const hostname = normalizeUrlHostname(parsed.hostname);
		if (isInternalHostname(hostname)) {
			return false;
		}

		return isIP(hostname) === 0 || !isPrivateOrReservedAddress(hostname);
	} catch {
		return false;
	}
}

interface PinnedWebhookDestination {
	allowed: boolean;
	reason?: string;
	dispatcher?: Dispatcher;
}

function normalizeHostnameForComparison(hostname: string): string {
	return normalizeUrlHostname(hostname).toLowerCase().replace(/\.$/, "");
}

function selectPinnedAddress(
	addresses: readonly { address: string; family: 4 | 6 }[],
	options: unknown,
): { address: string; family: 4 | 6 } {
	const requestedFamily = typeof options === "number"
		? options
		: options && typeof options === "object" && "family" in options
			? (options as { family?: unknown }).family
			: undefined;

	if (requestedFamily === 4 || requestedFamily === 6) {
		return addresses.find((entry) => entry.family === requestedFamily) ?? addresses[0]!;
	}

	return addresses[0]!;
}

function createPinnedDispatcher(hostname: string, addresses: readonly { address: string; family: 4 | 6 }[]): Dispatcher {
	const expectedHostname = normalizeHostnameForComparison(hostname);
	return new Agent({
		connect: {
			lookup: (lookupHostname: string, options: unknown, callback: (...args: unknown[]) => void): void => {
				if (normalizeHostnameForComparison(lookupHostname) !== expectedHostname) {
					callback(new Error("Webhook DNS pinning rejected an unexpected lookup host."));
					return;
				}

				const wantsAll = options && typeof options === "object" && (options as { all?: unknown }).all === true;
				if (wantsAll) {
					callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
					return;
				}

				const selected = selectPinnedAddress(addresses, options);
				callback(null, selected.address, selected.family);
			},
		},
	} as never);
}

async function validateWebhookDestination(
	value: string,
	dnsLookup: WebhookDnsLookup,
): Promise<PinnedWebhookDestination> {
	if (!isWebhookUrlAllowed(value)) {
		return { allowed: false, reason: "Webhook URL must target a public http(s) host." };
	}

	const parsed = new URL(value);
	const hostname = normalizeUrlHostname(parsed.hostname);
	if (isIP(hostname) !== 0) {
		return { allowed: true };
	}

	let addresses: Array<{ address: string; family: 4 | 6 }>;
	try {
		addresses = await dnsLookup(hostname);
	} catch (error) {
		return {
			allowed: false,
			reason: `Webhook host DNS validation failed: ${getErrorMessage(error)}`,
		};
	}

	if (addresses.length === 0) {
		return { allowed: false, reason: "Webhook host did not resolve to a connectable address." };
	}

	if (addresses.some((entry) => isPrivateOrReservedAddress(entry.address))) {
		return { allowed: false, reason: "Webhook host resolved to a private or reserved network address." };
	}

	return { allowed: true, dispatcher: createPinnedDispatcher(hostname, addresses) };
}

function isValidHttpUrl(value: string): boolean {
	return isWebhookUrlAllowed(value);
}

function isDiscordUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		if (!DISCORD_HOSTS.has(parsed.hostname.toLowerCase())) {
			return false;
		}
		return parsed.pathname.includes("/api/webhooks/");
	} catch {
		return false;
	}
}

function maskWebhookUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}/***`;
	} catch {
		return "<invalid-url>";
	}
}

function normalizeList(values: string[] | undefined): string[] {
	if (!values || values.length === 0) {
		return [];
	}
	const unique = new Set<string>();
	for (const value of values) {
		const normalized = value.trim().toLowerCase();
		if (normalized.length > 0) {
			unique.add(normalized);
		}
	}
	return [...unique];
}

function parseEnvConfig(env: NodeJS.ProcessEnv): WebhookConfig {
	const eventListRaw = env.PI_SMART_NOTIFY_WEBHOOK_EVENTS ?? env.WEBHOOK_EVENTS;
	const eventAllowList = eventListRaw
		? eventListRaw
				.split(",")
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
		: [];

	const enabled =
		parseBoolean(env.PI_SMART_NOTIFY_WEBHOOK_ENABLED) ?? parseBoolean(env.WEBHOOK_ENABLED) ?? false;

	return {
		enabled,
		discordWebhookUrl:
			env.PI_SMART_NOTIFY_DISCORD_WEBHOOK_URL ?? env.PI_SMART_VOICE_NOTIFY_DISCORD_WEBHOOK_URL ?? env.DISCORD_WEBHOOK_URL,
		genericWebhookUrl:
			env.PI_SMART_NOTIFY_WEBHOOK_URL ?? env.PI_SMART_VOICE_NOTIFY_WEBHOOK_URL ?? env.WEBHOOK_URL,
		eventAllowList,
		minIntervalMs: parseInteger(env.PI_SMART_NOTIFY_WEBHOOK_MIN_INTERVAL_MS),
		maxRetries: parseInteger(env.PI_SMART_NOTIFY_WEBHOOK_MAX_RETRIES),
		baseRetryDelayMs: parseInteger(env.PI_SMART_NOTIFY_WEBHOOK_BASE_RETRY_DELAY_MS),
		requestTimeoutMs: parseInteger(env.PI_SMART_NOTIFY_WEBHOOK_TIMEOUT_MS),
		discordMention: env.PI_SMART_NOTIFY_DISCORD_MENTION,
		discordUsername: env.PI_SMART_NOTIFY_DISCORD_USERNAME,
		discordAvatarUrl: env.PI_SMART_NOTIFY_DISCORD_AVATAR_URL,
	};
}

function mergeHeaders(
	genericHeaders: Record<string, string> | undefined,
	targetHeaders: Record<string, string> | undefined,
): Record<string, string> {
	return {
		...(genericHeaders ?? {}),
		...(targetHeaders ?? {}),
	};
}

function resolveTargets(config: WebhookConfig): ResolvedWebhookTarget[] {
	const targets: ResolvedWebhookTarget[] = [];

	const addTarget = (target: WebhookTargetConfig): void => {
		if (target.enabled === false || !target.url || !isValidHttpUrl(target.url)) {
			return;
		}
		const provider =
			target.provider ?? (isDiscordUrl(target.url) ? "discord" : "generic");
		if (provider === "discord" && !isDiscordUrl(target.url)) {
			return;
		}
		targets.push({
			provider,
			url: target.url,
			events: normalizeList(target.events),
			headers: mergeHeaders(config.genericHeaders, target.headers),
			mention: target.mention,
			username: target.username,
			avatarUrl: target.avatarUrl,
		});
	};

	if (config.discordWebhookUrl && isValidHttpUrl(config.discordWebhookUrl)) {
		addTarget({
			provider: "discord",
			url: config.discordWebhookUrl,
			mention: config.discordMention,
			username: config.discordUsername,
			avatarUrl: config.discordAvatarUrl,
		});
	}

	if (config.genericWebhookUrl && isValidHttpUrl(config.genericWebhookUrl)) {
		addTarget({
			provider: "generic",
			url: config.genericWebhookUrl,
			headers: config.genericHeaders,
		});
	}

	for (const target of config.targets ?? []) {
		addTarget(target);
	}

	const unique = new Map<string, ResolvedWebhookTarget>();
	for (const target of targets) {
		const key = `${target.provider}:${target.url}`;
		if (!unique.has(key)) {
			unique.set(key, target);
		}
	}

	return [...unique.values()];
}

function resolveConfig(config: WebhookConfig = {}, env: NodeJS.ProcessEnv = process.env): ResolvedWebhookConfig {
	const envConfig = parseEnvConfig(env);
	const merged: WebhookConfig = {
		...envConfig,
		...config,
		eventTriggers: {
			...(envConfig.eventTriggers ?? {}),
			...(config.eventTriggers ?? {}),
		},
		genericHeaders: {
			...(envConfig.genericHeaders ?? {}),
			...(config.genericHeaders ?? {}),
		},
	};

	const maxQueueSize = Math.max(1, merged.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
	const minIntervalMs = Math.max(0, merged.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
	const maxRetries = Math.max(0, merged.maxRetries ?? DEFAULT_MAX_RETRIES);
	const baseRetryDelayMs = Math.max(100, merged.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS);
	const requestTimeoutMs = Math.max(500, merged.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

	const logger = merged.logger ?? defaultLogger;
	const dnsLookup = merged.dnsLookup ?? defaultDnsLookup;
	const fetchImpl = merged.fetch ?? fetch;
	const targets = resolveTargets(merged);
	const isEnabled = merged.enabled === true && targets.length > 0;

	return {
		enabled: isEnabled,
		targets,
		eventTriggers: merged.eventTriggers ?? {},
		eventAllowList: normalizeList(merged.eventAllowList),
		maxQueueSize,
		minIntervalMs,
		maxRetries,
		baseRetryDelayMs,
		requestTimeoutMs,
		discordMention: merged.discordMention,
		discordUsername: merged.discordUsername,
		discordAvatarUrl: merged.discordAvatarUrl,
		logger,
		dnsLookup,
		fetch: fetchImpl,
	};
}

function eventColor(eventType: WebhookEventType): number {
	const normalized = eventType.toLowerCase();
	if (normalized === "idle") return DISCORD_COLORS.idle;
	if (normalized === "permission") return DISCORD_COLORS.permission;
	if (normalized === "question") return DISCORD_COLORS.question;
	if (normalized === "error") return DISCORD_COLORS.error;
	return DISCORD_COLORS.default;
}

function shouldRetry(statusCode: number | undefined): boolean {
	if (statusCode === undefined) {
		return true;
	}
	if (statusCode === 408 || statusCode === 429) {
		return true;
	}
	return statusCode >= 500;
}

function parseRetryAfterMs(value: string | null): number {
	if (!value) {
		return 0;
	}
	const numeric = Number.parseFloat(value);
	if (!Number.isFinite(numeric) || numeric <= 0) {
		return 0;
	}
	if (numeric <= 60) {
		return Math.round(numeric * 1_000);
	}
	return Math.round(numeric);
}

function buildDiscordPayload(target: ResolvedWebhookTarget, event: WebhookEvent, config: ResolvedWebhookConfig): unknown {
	const mention =
		typeof event.mention !== "undefined"
			? event.mention
			: typeof target.mention !== "undefined"
				? target.mention
				: config.discordMention;
	const mentionContent = mention === true ? "@everyone" : typeof mention === "string" ? mention : undefined;

	const fields: DiscordEmbedField[] = [];
	if (event.projectName) {
		fields.push({ name: "Project", value: event.projectName, inline: true });
	}
	if (event.sessionId) {
		fields.push({ name: "Session", value: `${event.sessionId.slice(0, 8)}...`, inline: true });
	}
	if (typeof event.count === "number" && event.count > 1) {
		fields.push({ name: "Count", value: String(event.count), inline: true });
	}

	return {
		username: target.username ?? config.discordUsername ?? "Pi Smart Notify",
		avatar_url: target.avatarUrl ?? config.discordAvatarUrl,
		content: mentionContent,
		embeds: [
			{
				title: event.title,
				description: event.message,
				color: eventColor(event.type),
				timestamp: new Date().toISOString(),
				fields: fields.length > 0 ? fields : undefined,
				footer: {
					text: "pi-smart-voice-notify",
				},
			},
		],
	};
}

function buildGenericPayload(event: WebhookEvent): unknown {
	if (typeof event.payload !== "undefined") {
		return event.payload;
	}

	return {
		event: event.type,
		title: event.title,
		message: event.message,
		projectName: event.projectName,
		sessionId: event.sessionId,
		count: event.count,
		metadata: event.metadata,
		timestamp: new Date().toISOString(),
	};
}

export class WebhookService {
	private sourceConfig: WebhookConfig;
	private config: ResolvedWebhookConfig;
	private queue: QueueItem[] = [];
	private processingQueue = false;
	private rateLimitState = new Map<string, RateLimitState>();

	constructor(config: WebhookConfig = {}) {
		this.sourceConfig = { ...config };
		this.config = resolveConfig(this.sourceConfig);
	}

	public updateConfig(config: WebhookConfig): void {
		this.sourceConfig = {
			...this.sourceConfig,
			...config,
			eventTriggers: {
				...(this.sourceConfig.eventTriggers ?? {}),
				...(config.eventTriggers ?? {}),
			},
			genericHeaders: {
				...(this.sourceConfig.genericHeaders ?? {}),
				...(config.genericHeaders ?? {}),
			},
		};
		this.config = resolveConfig(this.sourceConfig);
	}

	public isEnabled(): boolean {
		return this.config.enabled;
	}

	public dispatch(event: WebhookEvent): WebhookDispatchResult {
		if (!this.config.enabled || !this.isEventEnabled(event.type)) {
			return { queued: 0, skipped: true };
		}

		let queued = 0;
		for (const target of this.config.targets) {
			if (!this.targetAllowsEvent(target, event.type)) {
				continue;
			}
			this.enqueue({
				target,
				event,
			});
			queued += 1;
		}

		if (!this.processingQueue) {
			queueMicrotask(() => {
				void this.processQueue();
			});
		}

		return { queued, skipped: queued === 0 };
	}

	public async flush(signal?: AbortSignal): Promise<void> {
		await this.processQueue(signal);
	}

	public getQueueSize(): number {
		return this.queue.length;
	}

	private enqueue(item: QueueItem): void {
		if (this.queue.length >= this.config.maxQueueSize) {
			this.queue.shift();
		}
		this.queue.push(item);
	}

	private isEventEnabled(eventType: WebhookEventType): boolean {
		const normalized = eventType.toLowerCase();
		if (this.config.eventAllowList.length > 0 && !this.config.eventAllowList.includes(normalized)) {
			return false;
		}
		const explicit = this.config.eventTriggers[normalized];
		if (explicit === false) {
			return false;
		}
		return true;
	}

	private targetAllowsEvent(target: ResolvedWebhookTarget, eventType: WebhookEventType): boolean {
		if (target.events.length === 0) {
			return true;
		}
		const normalized = eventType.toLowerCase();
		return target.events.includes("*") || target.events.includes(normalized);
	}

	private targetKey(target: ResolvedWebhookTarget): string {
		return `${target.provider}:${target.url}`;
	}

	private async waitForRateLimit(target: ResolvedWebhookTarget, signal?: AbortSignal): Promise<void> {
		const key = this.targetKey(target);
		const state = this.rateLimitState.get(key) ?? { lastSentAt: 0, nextAllowedAt: 0 };
		const waitUntil = Math.max(state.nextAllowedAt, state.lastSentAt + this.config.minIntervalMs);
		const now = Date.now();
		if (waitUntil > now) {
			await delayWithAbort(waitUntil - now, signal);
		}
	}

	private markRequest(target: ResolvedWebhookTarget): void {
		const key = this.targetKey(target);
		const existing = this.rateLimitState.get(key) ?? { lastSentAt: 0, nextAllowedAt: 0 };
		existing.lastSentAt = Date.now();
		this.rateLimitState.set(key, existing);
	}

	private markRateLimited(target: ResolvedWebhookTarget, retryAfterMs: number): void {
		const key = this.targetKey(target);
		const existing = this.rateLimitState.get(key) ?? { lastSentAt: 0, nextAllowedAt: 0 };
		existing.nextAllowedAt = Date.now() + Math.max(0, retryAfterMs);
		this.rateLimitState.set(key, existing);
	}

	private log(message: string, details: Record<string, unknown> = {}): void {
		this.config.logger(message, details);
	}

	private async processQueue(signal?: AbortSignal): Promise<void> {
		if (this.processingQueue) {
			return;
		}
		this.processingQueue = true;
		try {
			while (this.queue.length > 0) {
				if (signal?.aborted) {
					// Clear queue on abort to avoid stale items
					this.queue.length = 0;
					return;
				}
				const item = this.queue.shift();
				if (!item) {
					continue;
				}
				await this.sendWithRetry(item, signal);
			}
		} finally {
			this.processingQueue = false;
		}
	}

	private async sendWithRetry(item: QueueItem, signal?: AbortSignal): Promise<void> {
		for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
			if (signal?.aborted) {
				return;
			}
			await this.waitForRateLimit(item.target, signal);
			const result = await this.sendOnce(item.target, item.event, signal);
			if (result.success) {
				return;
			}

			// Don't retry on abort
			if (signal?.aborted) {
				return;
			}

			const targetLabel = maskWebhookUrl(item.target.url);
			const shouldRetryCurrentAttempt = attempt < this.config.maxRetries && shouldRetry(result.statusCode);
			if (!shouldRetryCurrentAttempt) {
				this.log("webhook.send.failed", {
					target: targetLabel,
					provider: item.target.provider,
					eventType: item.event.type,
					statusCode: result.statusCode,
					error: result.error,
				});
				return;
			}

			const backoffDelay = this.config.baseRetryDelayMs * 2 ** attempt;
			const retryDelay = Math.max(backoffDelay, result.retryAfterMs ?? 0);
			this.log("webhook.send.retry", {
				target: targetLabel,
				provider: item.target.provider,
				eventType: item.event.type,
				attempt: attempt + 1,
				delayMs: retryDelay,
				statusCode: result.statusCode,
			});
			await delayWithAbort(retryDelay, signal);
		}
	}

	private async sendOnce(target: ResolvedWebhookTarget, event: WebhookEvent, externalSignal?: AbortSignal): Promise<SendAttemptResult> {
		const destination = await validateWebhookDestination(target.url, this.config.dnsLookup);
		if (!destination.allowed) {
			return { success: false, statusCode: 400, error: destination.reason ?? "Webhook URL was blocked." };
		}

		this.markRequest(target);
		const payload =
			target.provider === "discord"
				? buildDiscordPayload(target, event, this.config)
				: buildGenericPayload(event);

		// Check if already aborted before starting
		if (externalSignal?.aborted) {
			return { success: false, error: "Request aborted" };
		}

		// Create a combined abort controller that respects both timeout and external signal
		const controller = new AbortController();
		const timeout = setTimeout(() => {
			controller.abort();
		}, this.config.requestTimeoutMs);

		// Wire external signal to abort
		const onExternalAbort = () => controller.abort();
		externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

		const headers: HeadersInit = {
			"Content-Type": "application/json",
			...target.headers,
		};

		try {
			const requestOptions: RequestInit & { dispatcher?: Dispatcher } = {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal,
			};
			if (destination.dispatcher) {
				requestOptions.dispatcher = destination.dispatcher;
			}

			const response = await this.config.fetch(target.url, requestOptions);

			if (response.status === 429) {
				const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
				this.markRateLimited(target, retryAfterMs);
				return {
					success: false,
					statusCode: response.status,
					retryAfterMs,
					error: "Rate limited",
				};
			}

			if (response.ok) {
				return { success: true, statusCode: response.status };
			}

			return {
				success: false,
				statusCode: response.status,
				error: `HTTP ${response.status}`,
			};
		} catch (error) {
			// Check if this was an external abort
			if (externalSignal?.aborted) {
				return { success: false, error: "Request aborted" };
			}
			const message = getErrorMessage(error);
			return {
				success: false,
				error: message,
			};
		} finally {
			clearTimeout(timeout);
			externalSignal?.removeEventListener("abort", onExternalAbort);
			await destination.dispatcher?.close();
		}
	}
}

export function createWebhookService(config: WebhookConfig = {}): WebhookService {
	return new WebhookService(config);
}

export default {
	WebhookService,
	createWebhookService,
};
