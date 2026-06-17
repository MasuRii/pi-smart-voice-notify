import assert from "node:assert/strict";
import test from "node:test";

import { createWebhookService, isWebhookUrlAllowed, type WebhookConfig } from "../src/webhook.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 as const }];
const PRIVATE_DNS = async () => [{ address: "10.0.0.5", family: 4 as const }];

function createControllableFetch(): {
	fetch: typeof fetch;
	calls: Array<{ url: string; init: RequestInit }>;
	responses: Array<Response>;
	setNextResponse: (response: Response) => void;
} {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const responses: Response[] = [];
	let responseIndex = 0;

	const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		const response = responses[responseIndex] ?? new Response(null, { status: 200 });
		responseIndex += 1;
		return response;
	};

	return {
		fetch: fetchFn as typeof fetch,
		calls,
		responses,
		setNextResponse: (response: Response) => {
			responses.push(response);
		},
	};
}

function baseConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
	return {
		enabled: true,
		genericWebhookUrl: "https://example.com/webhook",
		minIntervalMs: 0,
		maxRetries: 0,
		baseRetryDelayMs: 100,
		requestTimeoutMs: 5_000,
		dnsLookup: PUBLIC_DNS,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Rate limiting (minIntervalMs)
// ---------------------------------------------------------------------------

test("rate limiting enforces minimum interval between sends to the same target", async () => {
	const { fetch: fetchFn, calls } = createControllableFetch();

	const minInterval = 10;
	const service = createWebhookService({
		...baseConfig(),
		minIntervalMs: minInterval,
		fetch: fetchFn,
	});

	// First send
	service.dispatch({ type: "idle", title: "A", message: "msg-a" });
	await service.flush();
	assert.equal(calls.length, 1);

	// Second send - measure real elapsed time to prove rate limiting waited
	const start = performance.now();
	service.dispatch({ type: "idle", title: "B", message: "msg-b" });
	await service.flush();
	const elapsed = performance.now() - start;

	assert.equal(calls.length, 2);
	// The second send should have waited at least minIntervalMs
	assert.ok(elapsed >= minInterval, `elapsed ${elapsed}ms should be >= ${minInterval}ms`);
});

test("rate limiting tracks targets independently", async () => {
	const targetCalls: Record<string, number> = {};

	const service = createWebhookService({
		...baseConfig(),
		minIntervalMs: 100,
		genericWebhookUrl: undefined,
		targets: [
			{ url: "https://example.com/target-a", events: ["idle"] },
			{ url: "https://example.com/target-b", events: ["error"] },
		],
		fetch: async (url) => {
			targetCalls[url] = (targetCalls[url] ?? 0) + 1;
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "A", message: "goes to target-a" });
	service.dispatch({ type: "error", title: "B", message: "goes to target-b" });
	await service.flush();

	// Each event routes to exactly one target (thanks to per-target event filters)
	assert.equal(targetCalls["https://example.com/target-a"], 1);
	assert.equal(targetCalls["https://example.com/target-b"], 1);
});

// ---------------------------------------------------------------------------
// Queue overflow (maxQueueSize)
// ---------------------------------------------------------------------------

test("queue overflow drops oldest items when maxQueueSize is exceeded", async () => {
	let fetchCount = 0;
	const service = createWebhookService({
		...baseConfig(),
		maxQueueSize: 2,
		minIntervalMs: 50_000, // Prevent actual processing
		fetch: async () => {
			fetchCount++;
			return new Response(null, { status: 200 });
		},
	});

	// Dispatch 3 events; only the last 2 should be in the queue
	service.dispatch({ type: "idle", title: "1", message: "first" });
	service.dispatch({ type: "error", title: "2", message: "second" });
	service.dispatch({ type: "question", title: "3", message: "third" });

	assert.equal(service.getQueueSize(), 2);
});

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

test("retry attempts on server error with exponential backoff", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];

	let attempt = 0;
	const customFetch = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		attempt++;
		if (attempt < 3) {
			return new Response(null, { status: 500 });
		}
		return new Response(null, { status: 200 });
	};

	const retryService = createWebhookService({
		...baseConfig(),
		maxRetries: 2,
		baseRetryDelayMs: 1,
		minIntervalMs: 0,
		fetch: customFetch,
	});

	retryService.dispatch({ type: "idle", title: "Retry", message: "test" });
	await retryService.flush();

	assert.equal(calls.length, 3);
});

test("retry respects Retry-After header on 429", async () => {
	let attempt = 0;
	const calls: Array<{ status: number }> = [];

	const service = createWebhookService({
		...baseConfig(),
		maxRetries: 1,
		baseRetryDelayMs: 1,
		minIntervalMs: 0,
		fetch: async () => {
			attempt++;
			if (attempt === 1) {
				calls.push({ status: 429 });
				return new Response(null, {
					status: 429,
					headers: { "Retry-After": "0.001" },
				});
			}
			calls.push({ status: 200 });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "Rate limited", message: "test" });
	await service.flush();

	assert.equal(calls.length, 2);
	assert.equal(calls[0]?.status, 429);
	assert.equal(calls[1]?.status, 200);
});

test("no retry on 4xx (non-429) client errors", async () => {
	let attempt = 0;
	const service = createWebhookService({
		...baseConfig(),
		maxRetries: 3,
		baseRetryDelayMs: 1,
		minIntervalMs: 0,
		fetch: async () => {
			attempt++;
			return new Response(null, { status: 404 });
		},
	});

	service.dispatch({ type: "idle", title: "Not found", message: "test" });
	await service.flush();

	assert.equal(attempt, 1);
});

test("no retry when maxRetries is 0", async () => {
	let attempt = 0;
	const service = createWebhookService({
		...baseConfig(),
		maxRetries: 0,
		fetch: async () => {
			attempt++;
			return new Response(null, { status: 500 });
		},
	});

	service.dispatch({ type: "idle", title: "No retry", message: "test" });
	await service.flush();

	assert.equal(attempt, 1);
});

// ---------------------------------------------------------------------------
// Retry-After header parsing
// ---------------------------------------------------------------------------

test("parseRetryAfter handles numeric seconds value", async () => {
	let callCount = 0;
	const service = createWebhookService({
		...baseConfig(),
		maxRetries: 1,
		baseRetryDelayMs: 1,
		minIntervalMs: 0,
		fetch: async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(null, {
					status: 429,
					headers: { "Retry-After": "0.001" },
				});
			}
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "Parse RA", message: "test" });
	await service.flush();

	// First call gets 429, second call gets 200
	assert.equal(callCount, 2);
});

// ---------------------------------------------------------------------------
// Event filtering: eventAllowList
// ---------------------------------------------------------------------------

test("eventAllowList filters events not in the list", () => {
	let fetchCalled = false;
	const service = createWebhookService({
		...baseConfig(),
		eventAllowList: ["error"],
		fetch: async () => {
			fetchCalled = true;
			return new Response(null, { status: 200 });
		},
	});

	// idle should be filtered out
	const result = service.dispatch({ type: "idle", title: "Idle", message: "should skip" });
	assert.equal(result.skipped, true);
	assert.equal(result.queued, 0);
});

test("eventAllowList allows events in the list", () => {
	const service = createWebhookService({
		...baseConfig(),
		eventAllowList: ["error"],
	});

	const result = service.dispatch({ type: "error", title: "Error", message: "should pass" });
	assert.equal(result.skipped, false);
	assert.equal(result.queued, 1);
});

// ---------------------------------------------------------------------------
// Event filtering: eventTriggers
// ---------------------------------------------------------------------------

test("eventTriggers with explicit false disables an event", () => {
	const service = createWebhookService({
		...baseConfig(),
		eventTriggers: { idle: false },
	});

	const result = service.dispatch({ type: "idle", title: "Idle", message: "should skip" });
	assert.equal(result.skipped, true);
	assert.equal(result.queued, 0);
});

test("eventTriggers with explicit true allows an event", () => {
	const service = createWebhookService({
		...baseConfig(),
		eventTriggers: { idle: true },
	});

	const result = service.dispatch({ type: "idle", title: "Idle", message: "should pass" });
	assert.equal(result.skipped, false);
});

// ---------------------------------------------------------------------------
// Per-target event filtering
// ---------------------------------------------------------------------------

test("per-target event list filters dispatch to matching targets only", () => {
	let genericCalls = 0;
	let discordCalls = 0;

	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		targets: [
			{
				url: "https://example.com/error-only",
				events: ["error"],
			},
			{
				url: "https://example.com/idle-only",
				events: ["idle"],
			},
		],
		fetch: async (url) => {
			if (url.includes("error-only")) genericCalls++;
			if (url.includes("idle-only")) discordCalls++;
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "Idle", message: "test" });
	service.dispatch({ type: "error", title: "Error", message: "test" });

	// Don't flush - just verify queue assignment
	assert.equal(service.getQueueSize(), 2);
});

test("target with wildcard event list receives all events", () => {
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		targets: [
			{
				url: "https://example.com/all",
				events: ["*"],
			},
		],
	});

	const result1 = service.dispatch({ type: "idle", title: "A", message: "test" });
	const result2 = service.dispatch({ type: "error", title: "B", message: "test" });

	assert.equal(result1.queued, 1);
	assert.equal(result2.queued, 1);
});

test("target with empty event list receives all events", () => {
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		targets: [
			{
				url: "https://example.com/all",
				events: [],
			},
		],
	});

	const result = service.dispatch({ type: "idle", title: "A", message: "test" });
	assert.equal(result.queued, 1);
});

// ---------------------------------------------------------------------------
// Disabled service
// ---------------------------------------------------------------------------

test("disabled service skips all events", () => {
	const service = createWebhookService({
		...baseConfig(),
		enabled: false,
	});

	const result = service.dispatch({ type: "idle", title: "Idle", message: "test" });
	assert.equal(result.skipped, true);
	assert.equal(result.queued, 0);
});

test("service without targets is disabled", () => {
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		discordWebhookUrl: undefined,
	});

	assert.equal(service.isEnabled(), false);
});

// ---------------------------------------------------------------------------
// updateConfig behavior
// ---------------------------------------------------------------------------

test("updateConfig enables new targets dynamically", () => {
	const service = createWebhookService({
		...baseConfig(),
		enabled: false,
	});

	assert.equal(service.isEnabled(), false);

	service.updateConfig({ enabled: true });
	assert.equal(service.isEnabled(), true);
});

test("updateConfig merges event triggers", () => {
	const service = createWebhookService({
		...baseConfig(),
		eventTriggers: { idle: true, error: true },
	});

	// Both should pass initially
	assert.equal(service.dispatch({ type: "idle", title: "A", message: "test" }).queued, 1);

	service.updateConfig({ eventTriggers: { idle: false } });

	// idle should now be blocked, error still allowed
	assert.equal(service.dispatch({ type: "idle", title: "B", message: "test" }).skipped, true);
	assert.equal(service.dispatch({ type: "error", title: "C", message: "test" }).queued, 1);
});

// ---------------------------------------------------------------------------
// Discord-specific payload behavior
// ---------------------------------------------------------------------------

test("discord webhook is detected from discord.com URL", async () => {
	const calls: Array<{ url: string; body: string }> = [];
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
		fetch: async (url, init) => {
			calls.push({ url, body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "error", title: "Test Error", message: "Something broke" });
	await service.flush();

	assert.equal(calls.length, 1);
	const body = JSON.parse(calls[0]!.body);
	assert.equal(body.embeds[0].title, "Test Error");
	assert.equal(body.embeds[0].color, 0xe74c3c); // error color
	assert.equal(body.embeds[0].footer.text, "pi-smart-voice-notify");
	assert.equal(body.username, "Pi Smart Notify");
});

test("discord payload includes project and session fields when provided", async () => {
	const calls: Array<{ body: string }> = [];
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
		fetch: async (_url, init) => {
			calls.push({ body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({
		type: "idle",
		title: "Done",
		message: "Completed",
		projectName: "my-project",
		sessionId: "abcdef1234567890",
		count: 5,
	});
	await service.flush();

	const body = JSON.parse(calls[0]!.body);
	assert.equal(body.embeds[0].fields[0].name, "Project");
	assert.equal(body.embeds[0].fields[0].value, "my-project");
	assert.equal(body.embeds[0].fields[1].name, "Session");
	assert.equal(body.embeds[0].fields[1].value, "abcdef12...");
	assert.equal(body.embeds[0].fields[2].name, "Count");
	assert.equal(body.embeds[0].fields[2].value, "5");
});

test("discord mention true sends @everyone", async () => {
	const calls: Array<{ body: string }> = [];
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
		discordMention: true,
		fetch: async (_url, init) => {
			calls.push({ body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "error", title: "Urgent", message: "Need attention" });
	await service.flush();

	const body = JSON.parse(calls[0]!.body);
	assert.equal(body.content, "@everyone");
});

test("discord mention as string sends the role mention", async () => {
	const calls: Array<{ body: string }> = [];
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
		discordMention: "<@&123456789>",
		fetch: async (_url, init) => {
			calls.push({ body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "error", title: "Role ping", message: "Need attention" });
	await service.flush();

	const body = JSON.parse(calls[0]!.body);
	assert.equal(body.content, "<@&123456789>");
});

test("discord event colors map correctly", async () => {
	const calls: Array<{ body: string }> = [];
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
		fetch: async (_url, init) => {
			calls.push({ body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "Idle", message: "done" });
	await service.flush();
	let body = JSON.parse(calls[calls.length - 1]!.body);
	assert.equal(body.embeds[0].color, 0x2ecc71); // green for idle

	service.dispatch({ type: "permission", title: "Perm", message: "need approval" });
	await service.flush();
	body = JSON.parse(calls[calls.length - 1]!.body);
	assert.equal(body.embeds[0].color, 0xf39c12); // orange for permission

	service.dispatch({ type: "question", title: "Q", message: "need input" });
	await service.flush();
	body = JSON.parse(calls[calls.length - 1]!.body);
	assert.equal(body.embeds[0].color, 0x3498db); // blue for question

	service.dispatch({ type: "error", title: "Err", message: "broke" });
	await service.flush();
	body = JSON.parse(calls[calls.length - 1]!.body);
	assert.equal(body.embeds[0].color, 0xe74c3c); // red for error
});

test("unknown event type uses default discord color", async () => {
	const calls: Array<{ body: string }> = [];
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
		fetch: async (_url, init) => {
			calls.push({ body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "custom_event", title: "Custom", message: "custom" });
	await service.flush();

	const body = JSON.parse(calls[0]!.body);
	assert.equal(body.embeds[0].color, 0x5865f2); // default blurple
});

// ---------------------------------------------------------------------------
// Generic webhook payload
// ---------------------------------------------------------------------------

test("generic webhook sends structured JSON payload", async () => {
	const calls: Array<{ body: string }> = [];
	const service = createWebhookService({
		...baseConfig(),
		fetch: async (_url, init) => {
			calls.push({ body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({
		type: "idle",
		title: "Task Complete",
		message: "Build succeeded",
		projectName: "web-app",
	});
	await service.flush();

	const body = JSON.parse(calls[0]!.body);
	assert.equal(body.event, "idle");
	assert.equal(body.title, "Task Complete");
	assert.equal(body.message, "Build succeeded");
	assert.equal(body.projectName, "web-app");
	assert.equal(typeof body.timestamp, "string");
});

test("generic webhook uses event.payload when provided", async () => {
	const calls: Array<{ body: string }> = [];
	const service = createWebhookService({
		...baseConfig(),
		fetch: async (_url, init) => {
			calls.push({ body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	const customPayload = { custom: "data", nested: { value: 42 } };
	service.dispatch({
		type: "idle",
		title: "T",
		message: "M",
		payload: customPayload,
	});
	await service.flush();

	const body = JSON.parse(calls[0]!.body);
	assert.deepEqual(body, customPayload);
});

// ---------------------------------------------------------------------------
// URL validation edge cases
// ---------------------------------------------------------------------------

test("isWebhookUrlAllowed rejects non-http protocols", () => {
	assert.equal(isWebhookUrlAllowed("ftp://example.com/webhook"), false);
	assert.equal(isWebhookUrlAllowed("file:///etc/passwd"), false);
	assert.equal(isWebhookUrlAllowed("javascript:alert(1)"), false);
	assert.equal(isWebhookUrlAllowed("data:text/html,<script>"), false);
});

test("isWebhookUrlAllowed rejects malformed URLs", () => {
	assert.equal(isWebhookUrlAllowed("not-a-url"), false);
	assert.equal(isWebhookUrlAllowed(""), false);
	assert.equal(isWebhookUrlAllowed("://missing-protocol"), false);
});

test("isWebhookUrlAllowed rejects .lan TLD", () => {
	assert.equal(isWebhookUrlAllowed("https://my-service.lan/webhook"), false);
});

test("isWebhookUrlAllowed rejects .local mDNS", () => {
	assert.equal(isWebhookUrlAllowed("https://raspberry.local/webhook"), false);
});

test("isWebhookUrlAllowed rejects IPv4-mapped IPv6 loopback", () => {
	// Node.js URL parser normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1 (hex form)
	assert.equal(isWebhookUrlAllowed("https://[::ffff:127.0.0.1]/webhook"), false);
	assert.equal(isWebhookUrlAllowed("https://[::ffff:7f00:1]/webhook"), false);
});

test("isWebhookUrlAllowed rejects IPv6 ULA (fc/fd)", () => {
	assert.equal(isWebhookUrlAllowed("https://[fc00::1]/webhook"), false);
	assert.equal(isWebhookUrlAllowed("https://[fd12:3456::1]/webhook"), false);
});

test("isWebhookUrlAllowed rejects IPv6 link-local", () => {
	assert.equal(isWebhookUrlAllowed("https://[fe80::1]/webhook"), false);
});

test("isWebhookUrlAllowed rejects IPv6 multicast", () => {
	assert.equal(isWebhookUrlAllowed("https://[ff02::1]/webhook"), false);
});

test("isWebhookUrlAllowed rejects CGNAT range (100.64.0.0/10)", () => {
	assert.equal(isWebhookUrlAllowed("https://100.64.0.1/webhook"), false);
	assert.equal(isWebhookUrlAllowed("https://100.127.255.254/webhook"), false);
});

test("isWebhookUrlAllowed rejects benchmarking range (198.18.0.0/15)", () => {
	assert.equal(isWebhookUrlAllowed("https://198.18.0.1/webhook"), false);
	assert.equal(isWebhookUrlAllowed("https://198.19.255.254/webhook"), false);
});

test("isWebhookUrlAllowed rejects class E reserved (224+)", () => {
	assert.equal(isWebhookUrlAllowed("https://224.0.0.1/webhook"), false);
	assert.equal(isWebhookUrlAllowed("https://255.255.255.255/webhook"), false);
});

test("isWebhookUrlAllowed allows public IPv4 addresses", () => {
	assert.equal(isWebhookUrlAllowed("https://93.184.216.34/webhook"), true);
	assert.equal(isWebhookUrlAllowed("https://8.8.8.8/webhook"), true);
});

// ---------------------------------------------------------------------------
// Deduplication of identical targets
// ---------------------------------------------------------------------------

test("duplicate targets are deduplicated", () => {
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: "https://example.com/webhook",
		targets: [
			{ url: "https://example.com/webhook" },
		],
	});

	// Should only queue once per event despite duplicate target
	const result = service.dispatch({ type: "idle", title: "A", message: "test" });
	assert.equal(result.queued, 1);
});

// ---------------------------------------------------------------------------
// Custom username and avatar for Discord
// ---------------------------------------------------------------------------

test("discord custom username from target overrides default", async () => {
	const calls: Array<{ body: string }> = [];
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
		discordUsername: "Custom Bot Name",
		fetch: async (_url, init) => {
			calls.push({ body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "T", message: "M" });
	await service.flush();

	const body = JSON.parse(calls[0]!.body);
	assert.equal(body.username, "Custom Bot Name");
});

test("discord custom avatar URL is passed through", async () => {
	const calls: Array<{ body: string }> = [];
	const avatarUrl = "https://example.com/avatar.png";
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
		discordAvatarUrl: avatarUrl,
		fetch: async (_url, init) => {
			calls.push({ body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "T", message: "M" });
	await service.flush();

	const body = JSON.parse(calls[0]!.body);
	assert.equal(body.avatar_url, avatarUrl);
});

// ---------------------------------------------------------------------------
// Content-Type header
// ---------------------------------------------------------------------------

test("generic webhook includes Content-Type application/json header", async () => {
	const calls: Array<{ init: RequestInit }> = [];
	const service = createWebhookService({
		...baseConfig(),
		fetch: async (_url, init) => {
			calls.push({ init });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "T", message: "M" });
	await service.flush();

	const headers = new Headers(calls[0]!.init.headers);
	assert.equal(headers.get("content-type"), "application/json");
});

test("custom headers are merged with defaults", async () => {
	const calls: Array<{ init: RequestInit }> = [];
	const service = createWebhookService({
		...baseConfig(),
		genericHeaders: { "X-Custom-Header": "custom-value" },
		fetch: async (_url, init) => {
			calls.push({ init });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "T", message: "M" });
	await service.flush();

	const headers = new Headers(calls[0]!.init.headers);
	assert.equal(headers.get("content-type"), "application/json");
	assert.equal(headers.get("x-custom-header"), "custom-value");
});

// ---------------------------------------------------------------------------
// Flush behavior
// ---------------------------------------------------------------------------

test("flush processes all queued items", async () => {
	let count = 0;
	const service = createWebhookService({
		...baseConfig(),
		fetch: async () => {
			count++;
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "1", message: "a" });
	service.dispatch({ type: "error", title: "2", message: "b" });
	service.dispatch({ type: "question", title: "3", message: "c" });

	await service.flush();
	assert.equal(count, 3);
	assert.equal(service.getQueueSize(), 0);
});

// ---------------------------------------------------------------------------
// Invalid discord URL is rejected
// ---------------------------------------------------------------------------

test("discord provider with non-discord URL is rejected during target resolution", () => {
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		targets: [
			{
				url: "https://example.com/not-discord",
				provider: "discord" as const,
			},
		],
	});

	assert.equal(service.isEnabled(), false);
});

// ---------------------------------------------------------------------------
// Disabled target is skipped during resolution
// ---------------------------------------------------------------------------

test("target with enabled: false is skipped", () => {
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		targets: [
			{
				url: "https://example.com/disabled",
				enabled: false,
			},
		],
	});

	assert.equal(service.isEnabled(), false);
});

// ---------------------------------------------------------------------------
// Count field only appears when > 1
// ---------------------------------------------------------------------------

test("discord count field omitted when count is 1 or less", async () => {
	const calls: Array<{ body: string }> = [];
	const service = createWebhookService({
		...baseConfig(),
		genericWebhookUrl: undefined,
		discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
		fetch: async (_url, init) => {
			calls.push({ body: init.body as string });
			return new Response(null, { status: 200 });
		},
	});

	service.dispatch({ type: "idle", title: "T", message: "M", count: 1 });
	await service.flush();

	const body = JSON.parse(calls[0]!.body);
	const countField = body.embeds[0].fields?.find((f: { name: string }) => f.name === "Count");
	assert.equal(countField, undefined);
});

// ---------------------------------------------------------------------------
// Retry does not retry on abort signal
// ---------------------------------------------------------------------------

test("retry loop exits immediately when signal is already aborted", async () => {
	let attempts = 0;
	const service = createWebhookService({
		...baseConfig(),
		maxRetries: 3,
		baseRetryDelayMs: 1,
		minIntervalMs: 0,
		fetch: async () => {
			attempts++;
			return new Response(null, { status: 500 });
		},
	});

	service.dispatch({ type: "idle", title: "T", message: "M" });
	const controller = new AbortController();
	controller.abort();
	await service.flush(controller.signal);

	// The aborted flush should not process all retries
	assert.ok(attempts <= 1, `attempts should be <= 1, got ${attempts}`);
});
