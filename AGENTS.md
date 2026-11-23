# Agent guide

## Where to look

- **webOS** architecture, Keymanager3 and inbound-listener platform constraints, opt-in hardware testing: [`docs/webos.md`](docs/webos.md).
- **Review** standards: [`CODING_STANDARDS.md`](CODING_STANDARDS.md).
- **WebGL UI verification** (headless): [`web/webos/acceptance.mjs`](web/webos/acceptance.mjs), run with `pnpm run test:acceptance` from `web/`.

## Renderers

Android TV (`main`, `web/src/vendor/three`) and webOS (`webos/*`, `@house-control/visuals`) use separate renderers until Android migrates to the shared package. Edit the renderer that belongs to the target platform.

## Environment rules

- **TV access is opt-in.** Verify locally with unit tests and `pnpm run test:acceptance`. SSH to, install on, or relaunch the LG C3 only when the user explicitly requests hardware verification.
- **Browser choice for WebGL and SSO.** The T3 embedded preview cannot create WebGL2 contexts or complete Authelia passkey sign-in. Use `pnpm run test:acceptance` (headless Chromium + SwiftShader) for automated WebGL checks, and Browse MCP for interactive WebGL comparisons or SSO pages.
