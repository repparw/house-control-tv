# House Control TV on webOS

This branch ports the upstream Three.js TV interface to a standalone webOS application. It installs as `dev.housecontrol.webos` without root or launcher replacement.

## Status

- Tested on an LG C3 with webOS 11.2.0: 3D demo renders with WebGL 2, floor-plan import, D-pad, OK, Back, and Magic Remote pointer. Luma hides and suspends the separate app correctly.
- Implemented but **not yet tested on the TV**: direct Home Assistant WebSocket authentication, live light/switch/climate state, scene/device actions, and automatic reconnect after connection loss.
- Manual TV setup supports protected credential storage where Keymanager3 is available. Phone QR setup is deferred. Smart Life/Tuya, Hue, the phone companion, Mac auto-sync and the Luma Home widget are outside this release. Existing plans and upstream scene format remain supported.

## Build

From `web/` with Node 24:

```sh
pnpm install --frozen-lockfile
node --test webos/*.test.mjs
pnpm run build:webos
npx --yes --package=@webos-tools/cli@3.2.6 ares-package dist --outdir ../.local/webos
```

The CI workflow also uploads a downloadable `house-control-webos-ipk` artifact for every successful build. On unrooted TVs, use LG Developer Mode and the webOS CLI to install it. **On an already rooted TV, do not enable the LG Developer Mode app without checking the webOS Homebrew guidance**, because that can interfere with root. Install using the existing rooted management/SSH setup instead. The standalone application does not require root or alter LG Home or Luma.

## Connect Home Assistant

1. Import a House Control floor-plan JSON file through **Sync & connect**. A real device needs `link: { "service": "homeassistant", "id": "light.example" }`.
2. Choose **Connect Home Assistant**, enter a local server URL or HTTPS address, and paste a long-lived access token.
3. Live state and commands use Home Assistant's `/api/websocket` endpoint. Existing House Control scenes still apply desired device states using HA service calls.
4. To return to the isolated demo, choose Disconnect or Reset. No real-device command is sent by the demo adapter.

After authentication, the app saves credentials with Keymanager3. If protected storage is unavailable, setup reports a session-only connection. Use HTTPS for an encrypted connection to Home Assistant. Developer Mode installations on stock TVs can expire when the developer session ends.

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


## Floor-plan replacement (Q19)

Importing a new valid House Control floor-plan JSON **replaces the existing plan after explicit confirmation**. Preserve Home Assistant connection settings and securely stored credentials independently of the floor-plan file. Preserve local simulated-device state only when device IDs and compatible device types match the new plan. Reinitialize other local-only state from the imported plan. Device states linked to Home Assistant remain authoritative on HA; refresh them after import instead of treating cached states as current. **Import must never trigger real-device commands**, including scene execution or toggles. Validate the incoming JSON before changing the active plan, and leave the existing plan intact on validation/import failure.


## Optimistic device controls (Q20)

For linked devices with a live Home Assistant connection, update the displayed device state **optimistically** as soon as the user issues a control command. Mark it as pending until confirmed by Home Assistant's resulting state update. If HA returns an error, the command times out, or the reported authoritative state differs from the requested state, reconcile the UI to HA's actual state and show a concise failure or correction message. Do not leave a stale optimistic state presented as confirmed. New commands must not overwrite newer authoritative events due to out-of-order responses; handle rapid successive commands and disconnects safely. No optimistic real-device actions are allowed while offline (Q14). Simulated devices update immediately without HA confirmation (Q15).


## Home Assistant state synchronization (Q21)

While House Control is foregrounded and connected, subscribe to Home Assistant's WebSocket `state_changed` events for live device updates. On every initial connection and reconnection, obtain a full state snapshot and reconcile any events arriving during snapshot retrieval, so that older snapshot values cannot overwrite newer events. Do not poll continuously or run background reconciliation. On disconnect, retain last-known display state but mark it stale and reject real-device commands (Q14). Pending optimistic commands (Q20) must reconcile against authoritative events, command failures, and timeouts.


## Release distribution (Q22)

Publish reproducible webOS `.ipk` artifacts through **GitHub Releases first**. The initial test and installation paths are LG Developer Mode on unrooted TVs and the user's existing root-enabled C3 without changing its root/developer-mode configuration. Clearly document that Developer Mode installations can expire or be removed when the developer session ends. **LG Content Store / Seller Lounge submission is a later milestone**, not a condition of the initial release. Keep the build and packaging process suitable for eventual official submission.


## Renderer reuse (Q23)

Use the upstream shared Three.js renderer and floor-plan parser extracted in [house-control PR #29](https://github.com/0xProbabillity/house-control/pull/29). **Do not develop a separate webOS rendering fork.** Continue device-integration and packaging work while PR #29 is pending, then replace the currently vendored renderer when the shared package can be consumed reliably by this independent repository. Keep webOS-specific input/lifecycle and provider connection code separate from the shared renderer.

## Implementation sequence after grilling

1. **Device smoke test:** install the CI-generated IPK on the existing C3 without altering root or Developer Mode; verify WebGL render, remote navigation, actual HA WebSocket connection, linked device control, and import. Record failures before rewriting platform integration.
2. **Core behavior:** implement Q13–Q21 across frontend/API, prioritizing foreground-only connection, offline/stale states, optimistic control reconciliation, safe import, scene partial failures/toggle behavior, and clear simulated-device labels. Add focused regression tests for races, disconnects, and partial failures.
3. **Secure onboarding:** verify stock unrooted webOS service listener and protected credential storage APIs. Then build local-only short-lived QR form for HA credentials and optional JSON import. Never fall back silently to plaintext credential persistence or unencrypted token transfer.
4. **Renderer dependency:** consume upstream `@house-control/visuals` once it is accessible and suitable for the standalone repository. No need to wait for the upstream merge to test HA.
5. **Release:** test on real webOS hardware, document rootless Developer Mode limitations, publish versioned GitHub Release IPKs, and defer LG Store and full phone companion.

## Shared visuals integration

The app uses the floor-plan parser and Three.js world from the pinned [shared visuals extraction](https://github.com/0xProbabillity/house-control/pull/29). A pnpm dependency patch adds TV camera controls, transparent rendering, daylight and lower-cost drawing. Selecting a room focuses its floor.

## Secure onboarding platform decision

LG documents Keymanager3 for stock webOS TV 24 and later. The credential-store
module uses an app-owned AES-256-GCM key. Keymanager3 generates the nonce and
performs authenticated encryption and decryption. The app stores a versioned
nonce and ciphertext in the app's browser storage. The URL and token are both
inside the ciphertext. The packaged app declares `securitykey.operation` and
includes LG's webOSTV.js 1.2.13 with its Apache 2.0 license. [Keymanager3 reference](https://webostv.developer.lge.com/develop/references/keymanager3),
[ACG guide](https://webostv.developer.lge.com/develop/guides/acg-guide),
[webOSTV.js download](https://webostv.developer.lge.com/develop/references/webostvjs-introduction).

Phone QR provisioning is blocked on the supported stock platform. LG Developer
Support answered a question about opening a TCP port from a JS service by
directing developers to use the TV as a client only. The JS service guide
describes low-level networking, which does not establish support for an inbound
LAN listener. Keep manual TV entry available. Enable phone provisioning only
after demonstrating an authenticated, encrypted LAN path on unrooted hardware
with session expiry, cancellation, and listener shutdown. [LG Developer Support on opening a TCP port](https://forum.webostv.developer.lge.com/t/open-http-server/9585),
[JS service guide](https://webostv.developer.lge.com/develop/guides/js-service-basics).

This release uses manual entry on the TV. Disconnect removes the app-owned key and encrypted record.
