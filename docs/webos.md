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
