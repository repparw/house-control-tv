# House Control webOS standalone demo

The first webOS port reuses the existing frontend and Three.js renderer. It is
an isolated demo, with no Home Assistant token, device transport, HTTP listener,
background service, or privileged Luna calls. It installs beside existing apps
as `dev.housecontrol.webos`, titled **House Control Demo**.

## Build and install

Use Node 24 and the committed npm lock file. On NixOS, enter a Node environment
with `nix shell nixpkgs#nodejs_24` if Node is not already available.

```sh
cd web
npm ci
node --test webos/demo.test.mjs
npm run build:webos
npx --package @webos-tools/cli ares-package dist --outdir ../.local/webos
```

Configure your TV in the webOS CLI, then install the generated IPK with
`ares-install --device <device> ../.local/webos/dev.housecontrol.webos_0.1.0_all.ipk`.
Open **House Control Demo** from the launcher. No root access is required by the app.

The normal `npm run build` still builds the Android/bridge frontend. The webOS
adapter is selected only by `--mode webos`.

## Import a floor plan

Open **Sync & connect**, then choose **Import floor plan JSON**. Import a raw
House Control floor-plan JSON document, or an envelope containing `plan`.
The existing normalizer validates the plan before replacing the current home.
The 512 KiB limit applies to the file picker. The imported plan stays in the
app's local storage and is never committed or uploaded. Device bindings remain
inactive. **Reset bundled demo** removes the imported plan.

The same frontend can run on a development machine with
`npm exec vite -- --host 127.0.0.1 --mode webos`. No macOS editor is needed.
TV file-picker usability depends on the available input source; importing from
a development-machine browser is also useful for preparing and validating JSON.

## C3 validation

Tested 2026-10-24 on an LG C3 with webOS 11.2.0, firmware 43.21.71,
Chromium 132.0.6834.207. The app requests an empty `requiredACG` list.

- The bundled loft renders using WebGL 2.0 on the ARM Mali-G52 GPU.
- Renderer diagnostics report a 736 by 502 drawing buffer, antialiasing enabled,
  78 draw calls, 21,422 triangles, 78 geometries, and five textures for the demo.
  These are one-scene diagnostics, not FPS or whole-process memory measurements.
- All eight simulated lights and the five example scene controls appear.
- Selecting Away changes the summary to **All lights off · Climate off · Away**.
- An injected ArrowRight event moves focus from Whole home to Studio.
- The user confirmed physical arrows, OK, Back, Magic Remote pointer, and
  responsive 3D rendering on the actual TV.
- Opening Luma sets this app's visibility to hidden. Instrumented WebGL draw
  counts remained at 2,106 across two checks while hidden, then resumed after
  returning. The existing visibility handler calls `world.setRunning(false)`.
- The automated adapter test imports a linked plan, activates simulated controls,
  rejects the real-action route, rejects an invalid import without losing the
  prior plan, and resets the demo. No device request is made.
- Both normal and webOS production builds pass. Vite reports the existing
  Three.js chunk exceeds its 500 kB advisory threshold.

No TV reboot, real automation action, or launcher replacement was performed.
Measured FPS, total resident memory, repeated-transition memory growth, and
Home Assistant outage recovery remain future validation work.

## Remove the demo

Remove **House Control Demo** through the TV application editor, or run
`ares-install --device <device> --remove dev.housecontrol.webos`.
Luma, LG Home, boot hooks, and Home Assistant are independent of this app.

## Android integration and webOS boundaries

Analysis uses House Control TV commit `a86caa19627f45d927feedb7f2a1176934c049be`
and Android Luma commit `8ce68387cb690786445ffde8d1d1776d07fb6997`.

Android Luma binds `dev.housecontrol.tv.HomeService`. This is the primary launcher
protocol, rather than an HTTP preview API. The service checks the caller UID,
package `dev.luma.tv`, and signing-certificate SHA-256 against its trust list.
Binder transaction 1 returns the home JSON, 2 applies a scene ID, 3 sets widget
activity, and 4 applies an isolated demo scene. Replies contain JSON or an error.

The home response carries `plan`, `state`, `revision`, `controlReady`, connection
status, and a mode. Scene IDs, names, and icons come from `plan.scenes`; Android
Luma displays up to five. State includes lights, climate, and the selected scene.
Luma polls every two seconds while visible. HomeEngine reads linked services,
with Home Assistant WebSocket `subscribe_entities` updates and a five-second
polling fallback. A burst of changes is coalesced for 300 ms before a read.
Credentials remain in the native backend; `home()` strips device link details
from the returned plan.

The preview loads `http://127.0.0.1:8788/widget.html` in a hidden Android WebView.
Its `HouseWidget` JavaScript bridge supplies home data, presentation aspect,
resolution, daylight, and readiness. `widgetSnapshot()` renders and returns JSON
containing a WebP data URL and TV position. Android displays a native bitmap
with a crossfade. There is no dedicated HTTP PNG preview endpoint. Requests from
the widget are restricted to that loopback server. The settled widget has no
continuous render loop.

The separate phone companion server binds port 8788, serves bundled assets,
and requires `Authorization: Bearer <random token>` for `/api/*`. It restricts
methods and request sizes. Important routes include GET `/api/home` and POST
`/api/action`, `/api/import`, `/api/demo`, and `/api/demo/action`. The tokenized
phone link uses a URL fragment. This HTTP transport does not provide Android's
certificate-bound caller identity and should not be copied as an open LAN API.

Scene-to-app actions belong to Android Luma. Its `scene_app_packages` preference
maps a scene ID to a package. A successful scene operation optionally runs a
model-to-TV animation, then launches that app through Android. House Control
does not launch the app itself.

Leaving Home stops Luma's refresh callback, notifies HomeService of inactive
widget state, pauses the WebView, and stops unnecessary rendering. Unbinding
also clears widget activity. The full app separately controls its activity state.
The service is not sticky and closes its server and engine on destruction.

The renderer, plan normalizer, and most frontend controls are reusable.
Binder, certificate checks, Android WebView embedding, native device clients,
and app-launch intents need platform-specific replacements. No webOS port was
found in the two current House Control TV forks or its issue list during review.

## Launcher options

| Approach | Benefit | Cost and limitation | Decision |
| --- | --- | --- | --- |
| A: native scene/status controls and separate app | Keeps Luma's renderer and app lifecycle | Requires a narrow authenticated state/action API; no live 3D by itself | Preferred first integration |
| B: native controls and refreshed preview images | Reuses Three.js and draws one texture in Luma | Needs a supported renderer-to-image producer and explicit suspension; a stale cached image is not live state | Follow A after measuring |
| C: interactive browser surface | Closest visual parity | Native SDL/GLES and webOS browser surfaces lack a demonstrated embedding/input/texture-sharing path here | Defer |

No Chromium runtime, offscreen renderer daemon, global key hook, or Luma fork is
installed by the standalone demo. The TV's debugging endpoint is a development
tool and is not a proposed production preview transport.

Home Assistant integration must keep tokens out of browser-supplied content and
unrestricted APIs, expose only configured entities/actions, reconnect after an
outage, and remain optional. The five demo names do not create real HA scenes.
Real actions require separate approval before testing.
