# 🔔 pi-smart-voice-notify

[![npm version](https://img.shields.io/npm/v/pi-smart-voice-notify?style=flat-square)](https://www.npmjs.com/package/pi-smart-voice-notify) [![License](https://img.shields.io/github/license/MasuRii/pi-smart-voice-notify?style=flat-square)](LICENSE)

Windows-optimized smart notification extension for the Pi coding agent.

**pi-smart-voice-notify** monitors Pi session and tool events to alert you via **multi-engine TTS**, **sound playback**, **desktop toast notifications**, and optional **webhook/AI-assisted messaging** when the agent requires your attention.

<img width="1360" height="752" alt="image" src="https://github.com/user-attachments/assets/c215a7fe-31b4-4bc4-a89e-992a4847819d" />


## Features

- **Multi-channel notifications**
  - **Sound** – local sound playback with fallback beeps and reusable reminder playback control
  - **Voice** – auto-selectable TTS engines: Edge, espeak-ng, ElevenLabs, OpenAI-compatible, and Windows SAPI
  - **Desktop toasts** – cross-platform notifications via `node-notifier` (Windows/macOS/Linux)
  - **Webhook delivery** – optional Discord or generic HTTP webhook notifications
    - Validates webhook targets as public HTTP(S) destinations and blocks localhost/private/reserved networks before dispatch

- **Intelligent event detection**
  - Task completion (idle)
  - Authoritative permission-system wait events plus current-session forwarded subagent permission requests
  - Questions requiring input (when custom `question` tool is loaded)
  - Errors

- **Reminder system**
  - Configurable per-event reminder delays with follow-up scheduling
  - Exponential backoff multiplier for follow-ups
  - Auto-cancel reminders on user activity or resolution

- **Focus and wake handling**
  - Wakes display from sleep before notifications
  - Optional focused-terminal suppression on Linux
  - Cross-platform wake strategies for Windows, macOS, and Linux sessions

- **Sound customization**
  - Direct per-event sound files
  - Theme-based sound selection and optional per-project sound discovery
  - Theme randomization and default volume controls

- **AI message generation**
  - Optional AI-generated notification text with caching and template fallback

- **Interactive settings UI**
  - `/voice-notify` command opens a modal for live configuration
  - Settings persist to disk automatically

- **Debug logging**
  - Optional JSONL debug output for troubleshooting

## Installation

### Local Extension Folder

Place this folder in either location (Pi auto-discovers both):

- **Global default:** `~/.pi/agent/extensions/pi-smart-voice-notify` (respects `PI_CODING_AGENT_DIR`)
- **Project:** `.pi/extensions/pi-smart-voice-notify`

### As an npm Package

```bash
pi install npm:pi-smart-voice-notify
```

### From Git

```bash
pi install git:github.com/MasuRii/pi-smart-voice-notify
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/voice-notify` | Opens the settings modal (interactive mode) or prints config summary |
| `/voice-notify status` | Displays current configuration and question tool availability |
| `/voice-notify reload` | Reloads config from disk and resets reminder state |
| `/voice-notify on` | Enables the extension |
| `/voice-notify off` | Disables the extension |
| `/voice-notify test [type]` | Triggers a test notification (bypasses throttling) |

**Test types:** `idle`, `permission`, `question`, `error`

### Example

```text
/voice-notify test idle
/voice-notify test permission
```

## Configuration

Configuration is stored at:

```text
Default global path: ~/.pi/agent/extensions/pi-smart-voice-notify/config.json
Actual global path: $PI_CODING_AGENT_DIR/extensions/pi-smart-voice-notify/config.json when PI_CODING_AGENT_DIR is set
Local config path: <repo>/.pi/extensions/pi-smart-voice-notify/config.json
```

A starter template is provided in `config/config.example.json`. On startup, the extension creates `config.json` with defaults if missing.

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Master on/off switch |
| `windowsOptimized` | boolean | `true` | Show a compatibility notice on platforms other than Windows/Linux |
| `notificationMode` | string | `"sound-first"` | Mode: `sound-first`, `tts-first`, `both`, `sound-only` |
| `enableSound` | boolean | `true` | Enable sound playback |
| `enableTts` | boolean | `true` | Enable text-to-speech delivery |
| `ttsEngine` | string | `"auto"` | Engine: `auto`, `edge`, `espeak-ng`, `elevenlabs`, `openai`, `sapi` |
| `enableDesktopNotification` | boolean | `true` | Enable desktop toast notifications |
| `desktopNotificationTimeout` | number | `8` | Toast display duration in seconds (1–60) |
| `wakeMonitor` | boolean | `true` | Wake display from sleep before notifying |
| `idleThresholdSeconds` | number | `30` | System idle threshold before waking monitor (5–600) |
| `skipWhenFocused` | boolean | `false` | Suppress notifications while the active Linux terminal/editor is focused |

`windowsOptimized` keeps compatibility messaging for platforms that do not have Linux/Windows-native behavior. Linux users no longer see this notice.

### Event Toggles

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enableIdleNotification` | boolean | `true` | Notify when agent finishes a task |
| `enablePermissionNotification` | boolean | `true` | Notify when the permission system reports requests waiting for approval |
| `enableForwardedPermissionWatcher` | boolean | `true` | Watch current-session forwarded permission request/response files and notify when new requests arrive |
| `includeForwardedPermissionAgentName` | boolean | `true` | Include sanitized requester agent name in forwarded permission notification text |
| `watchLegacyForwardedPermissionPath` | boolean | `true` | Retained for config compatibility; unscoped legacy forwarded-permission paths are ignored because they cannot prove the current target session |
| `enableQuestionNotification` | boolean | `true` | Notify when agent asks a question* |
| `enableErrorNotification` | boolean | `true` | Notify on errors |
| `suppressIdleAfterError` | boolean | `true` | Skip idle notification if turn had errors |


Error notifications are delayed briefly before delivery so Pi can settle related turn state and suppress a redundant idle alert. Override the default 10000 ms delay with `PI_SMART_NOTIFY_AGENT_ERROR_GRACE_MS` when you need faster or slower error alerts.

*Question notifications only work when a custom `question` tool is loaded.

Forwarded permission watcher notifications use privacy-safe text, require the request `targetSessionId` to match the active Pi session, and never include raw forwarded `message` content.

### Reminder Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `reminderEnabled` | boolean | `true` | Enable reminder notifications |
| `reminderDelaySeconds` | number | `30` | Initial delay before first reminder (5–300) |
| `followUpEnabled` | boolean | `true` | Enable follow-up reminders |
| `maxFollowUps` | number | `3` | Maximum follow-up count (1–10) |
| `followUpBackoffMultiplier` | number | `1.5` | Delay multiplier for each follow-up |

### TTS Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `voice` | string | `"Microsoft Zira Desktop"` | Generic preferred voice label |
| `rate` | number | `-1` | Generic speaking rate |
| `volume` | number | `85` | Preferred playback volume percentage |
| `fallbackChain` | array | `["edge", "espeak-ng", "sapi"]` | TTS engines tried when `ttsEngine` is `auto` |
| `ttsVoice` | string | `"Microsoft Zira Desktop"` | Legacy SAPI-compatible alias |
| `ttsRate` | number | `-1` | Legacy SAPI-compatible alias |
| `edgeVoice` | string | `"en-US-JennyNeural"` | Microsoft Edge voice |
| `espeakVoice` | string | `"en"` | `espeak-ng` voice for Linux fallback |
| `elevenLabsVoiceId` | string | `"cgSgspJ2msm6clMCkdW9"` | ElevenLabs voice id |
| `openaiTtsVoice` | string | `"alloy"` | OpenAI-compatible voice |

### Sound File Paths

| Option | Type | Default |
|--------|------|---------|
| `idleSoundFile` | string | `"assets/soft-notification.mp3"` |
| `permissionSoundFile` | string | `"assets/attention-alert.mp3"` |
| `questionSoundFile` | string | `"assets/attention-alert.mp3"` |
| `errorSoundFile` | string | `"assets/attention-alert.mp3"` |

Paths can be absolute or relative to the extension directory.

### Sound, Webhook, and AI Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `themeName` | string | `"default"` | Preferred sound theme name |
| `enablePerProjectSounds` | boolean | `false` | Search the current project for matching notification sounds |
| `randomizeThemeSounds` | boolean | `true` | Randomize among matching themed sounds |
| `webhook.enabled` | boolean | `false` | Enable Discord/generic webhook delivery |
| `webhook.events` | array | `["idle", "permission", "question", "error"]` | Notification types sent through webhooks |
| `aiMessages.enabled` | boolean | `false` | Enable AI-generated notification copy |
| `aiMessages.model` | string | `"llama3"` | Model id used for AI notification generation |
| `aiMessages.caching.enabled` | boolean | `true` | Cache generated messages to reduce repeat calls |
| `minNotificationIntervalMs` | number | `1500` | Throttle interval between same-type notifications |
| `debugLog` | boolean | `false` | Enable debug logging to file |


Webhook dispatch only attempts public `http`/`https` URLs. The extension rejects localhost-style names, `.local`/`.internal`/`.lan`/`.home.arpa` hosts, private or reserved IP literals, and hostnames whose DNS results include private or reserved addresses; validated DNS results are pinned for the outbound request. Use `PI_SMART_NOTIFY_WEBHOOK_TIMEOUT_MS` to override the default 8000 ms webhook request timeout.

## Notification Modes

| Mode | Behavior |
|------|----------|
| `sound-first` | Play sound first; fall back to TTS on failure |
| `tts-first` | Speak TTS first; fall back to sound on failure |
| `both` | Play sound and speak TTS simultaneously |
| `sound-only` | Play sound only, no TTS or reminders |

## Troubleshooting

### Settings modal doesn't appear

The modal requires **interactive UI mode** (`ctx.hasUI`). In non-interactive contexts, `/voice-notify` prints a config summary instead.

### Desktop notifications not showing

1. Ensure `enableDesktopNotification` is `true`
2. Check that `node-notifier` is installed
3. Enable `debugLog` and check `debug/pi-smart-voice-notify.log` for `desktop.notify.failed` events

### No sound or voice on Windows

1. Sound and TTS are Windows-only (`process.platform === "win32"`)
2. The extension uses PowerShell for audio playback and SAPI—ensure PowerShell is available
3. Enable `debugLog` and search for `powershell.exec` entries

### Question notifications never trigger

Question notifications require a custom `question` tool to be loaded. Run `/voice-notify status` to verify `questionToolAvailable=true`.

### Wake monitor not working

- **Windows:** Uses SendKeys (F15) via PowerShell
- **macOS:** Uses `caffeinate -u -t 1`
- **Linux:** Uses `xset dpms force on` or GNOME D-Bus

Ensure system idle time exceeds `idleThresholdSeconds` for wake to trigger.

## Technical Details

### Architecture

```
index.ts                    → Extension entrypoint (re-exports src/index.ts)
src/
├── index.ts                → Main extension logic, event handlers, command registration
├── config-store.ts         → Config paths, normalization, env overrides, load/save utilities
├── types.ts                → Shared configuration and runtime types
├── notify-audio.ts         → Audio dispatch and Windows/SAPI playback integration
├── tts.ts                  → Multi-engine TTS selection and speech dispatch
├── desktop-notify.ts       → Desktop toast notifications via node-notifier
├── permission-forwarding-watcher.ts → Watches forwarded permission request directories
├── reminder-playback.ts    → Deduplicates/cancels overlapping reminder playback
├── sound-theme.ts          → Theme and sound file resolution
├── per-project-sound.ts    → Project-local sound discovery helpers
├── webhook.ts              → Discord and generic HTTP webhook delivery
├── ai-messages.ts          → AI-generated notification message generation and caching
├── linux.ts                → Linux wake/audio/focus helpers
├── focus-detect.ts         → Terminal focus detection cache
├── logging.ts              → Debug logger with JSONL output
└── zellij-modal.ts         → Settings modal UI components
```

### Event Hooks

| Event | Behavior |
|-------|----------|
| `session_start` | Load config, reset state, update status bar. Handles all session lifecycle transitions via `reason` (`startup`, `reload`, `new`, `resume`, `fork`). |
| `session_shutdown` | Cancel reminders, clear status |
| `input` | Track user activity, cancel pending reminders |
| `agent_start` | Reset error tracking |
| `tool_call` | Detect permission blocks |
| `tool_result` | Classify results (question/permission/error) |
| `agent_end` | Trigger idle notification (if enabled) |

### Debug Logging

When `debugLog: true`, JSONL events are written to:

```
Default global debug log path: ~/.pi/agent/extensions/pi-smart-voice-notify/debug/pi-smart-voice-notify.log (respects PI_CODING_AGENT_DIR)
```

Events include: config changes, notifications triggered, audio dispatch, reminders, and errors.

## Development

```bash
npm install
npm run build      # TypeScript compilation
npm run lint       # Alias for build
npm run test       # Node test runner with built-in TypeScript stripping
npm run check      # build + test
```

**Requirements:** Node.js ≥ 24

## Related Pi Extensions

- [pi-tool-display](https://github.com/MasuRii/pi-tool-display) — Compact tool rendering and diff visualization
- [pi-permission-system](https://github.com/MasuRii/pi-permission-system) — Permission enforcement for tool and command access
- [pi-MUST-have-extension](https://github.com/MasuRii/pi-MUST-have-extension) — RFC 2119 keyword normalization for prompts
- [pi-startup-redraw-fix](https://github.com/MasuRii/pi-startup-redraw-fix) — Fix terminal redraw glitches on startup

## License

MIT
