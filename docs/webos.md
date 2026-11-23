# House Control TV on webOS

This branch ports the upstream Three.js TV interface to a standalone webOS application. It installs as `dev.housecontrol.webos` without root or launcher replacement.

## Status

- Tested on an LG C3 with webOS 11.2.0: 3D demo renders with WebGL 2, floor-plan import, D-pad, OK, Back, and Magic Remote pointer. Luma hides and suspends the separate app correctly.
- Implemented but **not yet tested on the TV**: direct Home Assistant WebSocket authentication, live light/switch/climate state, scene/device actions, and automatic reconnect after connection loss.
- Not ported: persistent secure credentials, Smart Life/Tuya, Hue, the phone companion, Mac auto-sync, and Luma's live Home-screen widget. Existing plans and upstream scene format remain supported.

## Build

From `web/` with Node 24:

```sh
npm ci
node --test webos/*.test.mjs
npm run build:webos
npx --yes --package=@webos-tools/cli@3.2.6 ares-package dist --outdir ../.local/webos
```

The CI workflow also uploads a downloadable `house-control-webos-ipk` artifact for every successful build. On unrooted TVs, use LG Developer Mode and the webOS CLI to install it. **On an already rooted TV, do not enable the LG Developer Mode app without checking the webOS Homebrew guidance**, because that can interfere with root. Install using the existing rooted management/SSH setup instead. The standalone application does not require root or alter LG Home or Luma.

## Connect Home Assistant

1. Import a House Control floor-plan JSON file through **Sync & connect**. A real device needs `link: { "service": "homeassistant", "id": "light.example" }`.
2. Choose **Connect Home Assistant**, enter a local server URL or HTTPS address, and paste a long-lived access token.
3. Live state and commands use Home Assistant's `/api/websocket` endpoint. Existing House Control scenes still apply desired device states using HA service calls.
4. To return to the isolated demo, choose Disconnect or Reset. No real-device command is sent by the demo adapter.

**Security and current limitations:** The token is kept only in TV-app memory, not in the floor plan or browser storage. Restarting the app requires signing in again. This is intentionally not a finished credential-management solution. The next stage must evaluate LG's keymanager3 API (available on webOS TV 24+) or an app-private webOS JS service for secure persistence, without requiring root. Plain HTTP is limited to private IPv4 and `.local` addresses; use HTTPS elsewhere. Some HA deployments may reject a WebSocket opened from a packaged webOS app; test on a physical TV before relying on this feature. Do not use this experimental build for security-sensitive automations.

Only Home Assistant-linked devices currently send real commands. Unsupported providers fail explicitly instead of silently changing the UI. Unlinked devices retain upstream's local simulated behavior.

## Port approach

The original Android implementation uses a Java `HomeEngine` and separate device clients, and Android Luma uses a Binder service. webOS cannot execute that Android service unchanged. The common frontend, plan normalizer, Three.js renderer, scenes, and controller UI are reused. The direct WebSocket connection is an incremental Home Assistant adapter, not a replacement for Smart Life or Hue.

Keep standalone app functionality independent of Luma. After it works and is tested, optional Home-screen integration can be discussed upstream with `ecklf/lg-luma`.

## Earlier C3 measurements

The demo previously rendered 78 draw calls, 21,422 triangles and five textures with antialiasing at a 736 × 502 drawing buffer. These are demo-only measurements, not FPS or whole-process memory benchmarks. Opening Luma suspended its WebGL draw loop and returning resumed it. No device actions were tested during those measurements.

## Compatibility decision (Q11)

Target **webOS TV 24 and newer** for initial secure credential-storage integration. Support older webOS versions where practical, but only if a suitable protected credential store has been verified for them. A missing secure store is not permission to persist Home Assistant tokens in ordinary browser storage or plain files. Root access must never be required for the standalone application. QR onboarding and storage mechanisms remain subject to real-TV validation.

## Pairing network decision (Q12)

QR onboarding is **local-network-only**: phone and TV must be on the same LAN. No remote pairing, cloud relay, permanent companion service, or root-only dependency is needed. Keep TV-side manual configuration as a fallback. An ephemeral LAN setup listener is conditional on demonstrating secure transport and functional unrooted webOS compatibility; it must close after setup, cancellation, or expiry.


## Foreground lifecycle decision (Q13)

The standalone app maintains its Home Assistant connection **only while House Control is visible**. When webOS backgrounds or suspends the app, release the WebSocket and stop reconnect timers. On resume, reconnect with persisted credentials and fetch a fresh state snapshot before treating device states as current. Home Assistant automations continue independently; there is no always-on House Control service. Any future Luma Home integration must manage its own lifecycle separately.


## Offline state decision (Q14)

When Home Assistant is unreachable, **keep the floor plan and 3D navigation usable**. Display each device's last-known state with a visible **stale/offline indicator**, not as a live reading. Disable real-device commands while disconnected, and automatically retry the connection with bounded backoff **only while House Control is visible** (Q13). When reconnected, fetch a fresh snapshot before clearing stale indicators and allowing live control. Cached presentation state must not be mistaken for authoritative device state or used to queue offline actions. The app should retain last-known display state across an app restart when practical, separately from credentials, without claiming that stored readings are current.


## Unlinked device behavior (Q15)

Devices with **no provider link** remain interactive as **simulated devices**, consistent with the original House Control model. Label those controls clearly as simulated; changing them affects only the local 3D representation and never sends a command to Home Assistant or any other real device. Do not treat an unavailable or unsupported **linked** device as an unlinked simulated one. An unsupported linked provider should display its status and reject real commands rather than silently simulating success.


## Home Assistant device mapping (Q16)

For the initial release, use the existing House Control floor-plan JSON device links, such as `"link": { "service": "homeassistant", "id": "light.living_room" }`. Imported plans define the mappings; the TV and QR setup flow do not offer an entity browser, automatic matching, or a second device-link editor. Preserve compatibility with the upstream floor-plan format and its editor. A later phone-based mapping UI can be considered independently.


## Scene behavior (Q17)

The initial webOS release supports **House Control scenes defined in the imported floor-plan JSON**. Apply their device-state targets through the linked Home Assistant entities, preserving upstream scene semantics, including toggle behavior where supported. Do not discover or expose native Home Assistant scenes, scripts, or automations in this milestone. A separate provider feature can add those later without changing existing floor plans.

## Scene failure policy (Q18)

For multi-device House Control scenes, **attempt every independent supported, available device change** even if another device is offline or rejects its command. Collect and report per-device failures, then refresh from Home Assistant's actual states; do not mark a partially applied scene as successful or selected. Never queue scene actions while offline, and do not attempt automatic rollback of changes that already succeeded. Unsupported linked providers are explicit per-device failures, not simulated successes. Unlinked devices remain simulated as decided in Q15. A full scene is only considered applied when all intended changes succeeded.

## Deferred feature: native Home Assistant scenes and scripts

After the first webOS release, consider discovering and invoking Home Assistant's native `scene` and `script` entities alongside existing House Control JSON scenes. Scope to a separate issue when repository Issues are enabled; this is **not** part of the first release (Q17). Resolve how to distinguish native scenes from House Control scenes, whether scripts with required fields can be supported, error reporting, and whether remote-control and Luma integrations should expose them. Preserve existing JSON scene behavior and avoid automatic execution on discovery.
