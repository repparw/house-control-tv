# House Control TV on webOS

This branch ports the upstream Three.js TV interface to a standalone webOS application. It installs as `dev.housecontrol.webos` without root or launcher replacement, and stays independent of LG Home and Luma.

## Status

Verified on an LG C3 (webOS 11.2.0):

- 3D rendering with WebGL 2 through the shared `@house-control/visuals` renderer, floor-plan import, D-pad, OK, Back and Magic Remote pointer. Luma hides and suspends the app correctly.
- Direct Home Assistant WebSocket authentication and live entity readings.
- Manual TV setup with Keymanager3-encrypted credentials that persist across app relaunch.

Scope limits:

- Phone QR setup is deferred: stock webOS does not allow an inbound LAN listener (see [Credential storage and onboarding](#credential-storage-and-onboarding)).
- Smart Life/Tuya, Hue, the phone companion, Mac auto-sync and the Luma Home widget are out of scope. Existing plans and the upstream scene format remain supported.

## Build and verification

From `web/` with Node 24, run `pnpm run check` (static guardrails and unit tests) and `pnpm run test:acceptance` (headless Chromium + SwiftShader WebGL acceptance). `pnpm run build:webos` produces the app in `dist/`; package it with `npx --yes --package=@webos-tools/cli@3.2.6 ares-package dist --outdir ../.local/webos`.

Deploying to the LG C3 is opt-in, reserved for explicit hardware checks. On unrooted TVs, install with LG Developer Mode and the webOS CLI; Developer Mode installations expire when the developer session ends. **On the already rooted C3, install through the existing rooted SSH setup and leave the LG Developer Mode app disabled**, since enabling it can interfere with root (see the webOS Homebrew guidance).

## Connect Home Assistant

1. Import a House Control floor-plan JSON file through **Sync & connect**. A real device needs `link: { "service": "homeassistant", "id": "light.example" }`.
2. Choose **Connect Home Assistant**, enter a local server URL or HTTPS address, and paste a long-lived access token. Use HTTPS for an encrypted connection.
3. Live state and commands use Home Assistant's `/api/websocket` endpoint. House Control scenes apply desired device states through HA service calls.
4. Disconnect or Reset returns to the isolated demo, which never sends real-device commands.

## Architectural invariants

- **Port boundary.** The Android `HomeEngine`, device clients and Luma Binder service cannot run on webOS. The webOS app reuses the frontend, plan normalizer, renderer, scenes and controller UI, and adds a Home Assistant adapter alongside (not replacing) Smart Life or Hue.
- **Foreground-only connection.** The HA WebSocket lives only while House Control is visible. Backgrounding releases the socket and reconnect timers; resume reconnects with stored credentials, subscribes to `state_changed`, and reconciles a full snapshot so older snapshot values never overwrite newer events. No polling or background service.
- **Offline is stale, not live.** While HA is unreachable the plan and 3D navigation stay usable, devices show last-known state marked stale, real commands are rejected (never queued), and reconnect uses bounded backoff while visible.
- **Simulated isolation.** Unlinked devices are simulated and affect only the local scene. Linked devices that are unavailable or use an unsupported provider report failure explicitly instead of simulating success.
- **Optimistic reconciliation.** Live linked controls update optimistically as pending, then reconcile to HA's authoritative state on confirmation, error, timeout or mismatch; out-of-order responses never overwrite newer events. Multi-device scenes attempt every independent change, report per-device failures, refresh from HA, and count as applied only when all changes succeed.
- **Confirmed plan replacement.** Importing a plan validates it first and replaces the active plan only after confirmation. Credentials and connection settings persist independently; import never sends real-device commands. Device mappings come only from plan JSON links.
- **Shared renderer.** The app consumes the floor-plan parser and Three.js world from [`@house-control/visuals`](https://github.com/0xProbabillity/house-control/pull/29). webOS input, lifecycle and provider code stay outside the shared renderer.
- **Distribution.** Reproducible IPKs ship through GitHub Releases (CI also uploads a `house-control-webos-ipk` artifact). LG Content Store submission is a later milestone.

## Credential storage and onboarding

Target webOS TV 24 and newer, where LG documents Keymanager3. The app owns an AES-256-GCM key; Keymanager3 generates the nonce and performs authenticated encryption and decryption. The app stores a versioned nonce and ciphertext, containing both URL and token, in its browser storage. When protected storage is unavailable, setup reports a session-only connection; tokens stay out of plain browser storage and files. Disconnect removes the app-owned key and encrypted record. The package declares `securitykey.operation` and bundles LG's webOSTV.js 1.2.13 under Apache 2.0. References: [Keymanager3](https://webostv.developer.lge.com/develop/references/keymanager3), [ACG guide](https://webostv.developer.lge.com/develop/guides/acg-guide), [webOSTV.js](https://webostv.developer.lge.com/develop/references/webostvjs-introduction).

Phone QR provisioning needs an inbound LAN listener, which stock webOS does not support: LG Developer Support directs JS services to act as clients only. Enable phone provisioning only after demonstrating an authenticated, encrypted, local-only LAN path on unrooted hardware with session expiry, cancellation and listener shutdown. References: [LG Developer Support on opening a TCP port](https://forum.webostv.developer.lge.com/t/open-http-server/9585), [JS service guide](https://webostv.developer.lge.com/develop/guides/js-service-basics).

## Later candidates

- Native Home Assistant `scene` and `script` entities alongside House Control JSON scenes, without automatic execution on discovery.
- Optional Luma Home-screen integration, discussed upstream with `ecklf/lg-luma`, with its own lifecycle.
