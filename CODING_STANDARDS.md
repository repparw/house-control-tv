# Coding standards

Judgment calls for reviewers. Mechanical rules (banned browser dialogs, credential storage isolation, Keymanager3 parameter shapes, module size caps) are enforced by `pnpm run check`; extend that check instead of adding prose here.

## UI minimalism

- Show device status badges only for abnormal or actionable states: `Unavailable`, `Stale`, `Offline`. Routine states (`Live`, `Simulated`) carry no label.
- The setup trigger reads `Sync & connect` until Home Assistant is connected, then `Settings`.

## Atomic contract changes

When an adapter endpoint payload changes (for example `/api/import`), update every caller and the acceptance fixtures in the same PR. Verify state transitions across `demo`/`standalone` × `visible`/`hidden` × `connected`/`offline`.

## Renderer boundary

Put TV-specific renderer hooks in `web/src/vendor/three/tv.js` or in upstream PRs to `repparw/house-control`. Keep local dependency patches (`web/patches/`) shrinking.
