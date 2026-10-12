# Changelog

## [Unreleased]

### Added
- Added a `showStatusBar` config option (also exposed as **Show Status Bar Indicator** in the `/voice-notify` settings modal) to hide the `voice:...` status bar indicator. Defaults to `true`, preserving existing behavior.

## [0.6.0] - 2026-07-03

### Added
- Added an `enabled` master toggle to the config so the extension can be disabled without uninstalling. ([76cd96f](https://github.com/MasuRii/pi-smart-voice-notify/commit/76cd96fbbd6bd0658f00e8d7c043c44260f856bd))

### Changed
- Widened Pi coding-agent and Pi TUI peer dependency ranges to include `^0.80.0` and bumped development dependencies (`@types/node` to `26.1.0`, `@earendil-works/pi-coding-agent` to `^0.80.3`). ([146ff6e](https://github.com/MasuRii/pi-smart-voice-notify/commit/146ff6edf87de680958e61f0e1db34e6d337c729))
- Extracted shared utilities and consolidated duplicated logic across config, notification, and platform modules. ([76cd96f](https://github.com/MasuRii/pi-smart-voice-notify/commit/76cd96fbbd6bd0658f00e8d7c043c44260f856bd))
- Extracted shared test helpers and consolidated fixtures across the test suite. ([6cf3ed0](https://github.com/MasuRii/pi-smart-voice-notify/commit/6cf3ed0168c1460ffca3c447f4a7a55565f5cade))

## [0.5.4] - 2026-06-22

### Fixed
- Added a command allowlist to `runAbortableCommand` so non-allowlisted executables are rejected before spawning, preventing arbitrary command injection ([2074e30](https://github.com/MasuRii/pi-smart-voice-notify/commit/2074e30)).
- Replaced dynamic string-based command spawning in Linux helpers with a typed `LinuxCommandName` union and dedicated `spawnLinuxCommand` switch ([2074e30](https://github.com/MasuRii/pi-smart-voice-notify/commit/2074e30)).

### Changed
- Added `postinstall` hook that runs `patch-vulnerable-deps.mjs` when installed under `.pi/agent/extensions/` ([924e585](https://github.com/MasuRii/pi-smart-voice-notify/commit/924e585)).
- Pinned `protobufjs` 7.6.3, `ws` 8.21.0, and `uuid` 11.1.1 via npm `overrides` to resolve known vulnerabilities ([924e585](https://github.com/MasuRii/pi-smart-voice-notify/commit/924e585)).
- Added `@earendil-works/pi-coding-agent` as a devDependency for type-checking ([924e585](https://github.com/MasuRii/pi-smart-voice-notify/commit/924e585)).
- Updated README badge styling to for-the-badge, added platform badge and ko-fi support button ([f66fff6](https://github.com/MasuRii/pi-smart-voice-notify/commit/f66fff6)).
- Added `config-store-env-override` test to the test script ([924e585](https://github.com/MasuRii/pi-smart-voice-notify/commit/924e585)).

## [0.5.3] - 2026-06-16

### Fixed
- Filtered blank template entries so whitespace-only overrides no longer produce empty notification messages.
- Added a final fallback (`"Notification: Please check the terminal."`) when all template expansions and defaults yield empty output.

## [0.5.2] - 2026-06-01

### Changed
- Deferred notification service initialization until first use to reduce startup work.
- Replaced shared agent-directory lookup with a local `PI_CODING_AGENT_DIR`-aware resolver for config and permission-forwarding paths.
- Widened peer dependency ranges to `^0.74.0 || ^0.75.0 || ^0.77.0 || ^0.78.0`.

### Fixed
- Avoid rewriting the config file when normalized content is unchanged.

## [0.5.1] - 2026-05-26

### Changed
- Suppressed error notifications when the agent has pending continuation messages.
- Widened peer dependency ranges to `^0.74.0 || ^0.75.0`.
- Aligned `@types/node` dev dependency to `25.9.1`.

## [0.5.0] - 2026-05-22

### Added
- Added `PI_SMART_NOTIFY_AGENT_ERROR_GRACE_MS` to delay agent-error notifications briefly so related idle/error state can settle before notifying.
- Added webhook destination hardening with public HTTP(S)-only validation, private/reserved host rejection, DNS validation, and DNS-pinned dispatch.

### Changed
- Added request timeouts and a 10 MiB audio response cap for remote ElevenLabs/OpenAI-compatible TTS fetches.
- Improved Linux focus detection and moved debug log writes onto asynchronous file logging with flush support.
- Reorganized checked-in tests into the dedicated `test/` directory with webhook, TTS, Linux, sound-theme, and notification coverage.

## [0.4.0] - 2026-04-30

### Added
- Detect agent turn failures reported at `agent_end` and send error notifications instead of completion alerts.

### Changed
- Renamed bundled notification sound assets to stable lowercase filenames and migrate legacy bundled sound paths automatically.
- Updated `@mariozechner/pi-*` peer dependency ranges to `^0.70.6` and synchronized package lock metadata.

## [0.3.5] - 2026-04-27

### Fixed
- Permission notifications now require an authoritative `pi-permission-system:permission-request` waiting event before alerts or reminders are queued, preventing permission-looking `tool_call` and `tool_result` payloads from producing false permission alerts.
- Forwarded permission notifications now watch only the active session's scoped request/response directories, require matching `targetSessionId`, and ignore unscoped legacy paths, stale requests, resolved requests, malformed files, and mismatched request filenames.

## [0.3.4] - 2026-04-25

### Added
- Added shutdown-aware notification lifecycle handling so pending reminders and queued playback stop cleanly during session shutdown
- Added `session_start.reason` handling for startup, reload, new, resume, and fork session transitions

### Changed
- Updated global extension path documentation to account for `PI_CODING_AGENT_DIR`-aware configuration and debug paths
- Synchronized package metadata and lockfile for the 0.3.4 patch release while preserving `@mariozechner/pi-*` peer dependency range `^0.70.2`
- Release note context: `v0.3.2` is not on `main`; no tag or history repair is included in this release prep

## [0.3.2] - 2026-04-01

### Changed
- Added Related Pi Extensions cross-linking section to README
- Aligned npm keywords for improved discoverability
- Updated README with new image and expanded features documentation

## [0.3.1] - 2026-04-01

### Changed
- Updated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer dependencies to ^0.64.0

## [0.3.0] - 2026-03-23

### Added
- Comprehensive test coverage for TTS and webhook configuration building
- `buildTTSServiceConfig` and `buildWebhookServiceConfig` helper functions for modular config construction
- Improved dependency injection for terminal focus detection

### Changed
- Updated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer dependencies to ^0.62.0
- Refactored TTS configuration building to be more modular and testable
- Improved notify-audio.ts with cleaner sound theme handling
- Updated focus detection logic for better cross-platform support

### Fixed
- Replaced System.Windows.Media.MediaPlayer with P/Invoke to winmm.dll MCI API for reliable audio playback on Windows
- MediaPlayer can fail when Windows Media Foundation is not properly installed or configured
- Use mciSendString for notification audio playback with unique aliases per playback instance for concurrent safety
- Use mciSendString for TTS playback with duration detection

### Tests
- Added comprehensive test cases for config building functions
- Added tests for abortable commands and reminder playback

## [0.2.3] - 2026-03-13

### Added
- Integration with `pi-permission-system:permission-request` event channel for permission request notifications
- Automatic cancellation of permission reminders when approval/denial is received from the permission system
- Deduplication to prevent duplicate notifications when permission system events precede tool_call events
- New test coverage for permission system event integration

### Changed
- Refactored to use shared `toRecord` utility from `pi-permission-system`, removing duplicate implementation

## [0.2.2] - 2026-03-12

### Changed
- Refactored to use shared `toRecord` utility, removing duplicate implementation
- Consolidated exports and simplified `index.ts`

## [0.2.0] - 2026-03-07

### Added
- Added multi-engine TTS support with auto selection plus Edge, espeak-ng, ElevenLabs, OpenAI-compatible, and SAPI backends.
- Added forwarded permission request watching, reminder playback control, Linux wake/focus helpers, per-project sound discovery, webhook delivery, and AI-generated notification message support.
- Added targeted tests for abortable commands, reminder playback, and forwarded-permission notification flows.

### Changed
- Expanded configuration normalization and example config to cover nested reminder, webhook, AI-message, focus-detection, and sound-theme settings while keeping legacy keys compatible.
- Improved notification orchestration so reminder scheduling, focused-terminal suppression, and desktop/audio delivery can share richer runtime context.
- Switched the test runner to Node's built-in TypeScript stripping support and raised the documented runtime baseline to Node.js 24.

### Fixed
- Restored the package test workflow so the published repo can run its checked-in TypeScript tests without a missing loader file.
- Updated README documentation to cover the new engines, watchers, webhook/AI integrations, and sound-theme behavior.

## [0.1.2] - 2026-03-04

### Fixed
- Use absolute GitHub raw URL for README image to fix npm display

## [0.1.1] - 2026-03-04

### Changed
- Rewrote README.md with professional documentation standards
- Added comprehensive feature documentation, configuration reference, and usage examples

## 0.1.0

- Standardized repository structure to `index.ts` shim + `src/` implementation.
- Added config template and package metadata/scripts aligned with Pi extension conventions.
- Vendored `zellij-modal` into this repository to remove cross-extension imports.
- Modularized implementation into config store, logging, and audio notification modules while preserving runtime behavior.
