// TV-specific framing and renderer budget for the shared @house-control/visuals world.
// The scene, camera, picking and animation loop stay in the shared package; this module
// only describes how the webOS build uses them.

const rad = (degrees) => (degrees * Math.PI) / 180;

export const TV_RENDERER_OPTIONS = Object.freeze({
  background: '#0a0e1a',
  // The TV chip cannot afford the Mac renderer's bloom and MSAA passes.
  effects: false,
  lampShadows: false,
  shadowMapSize: 1024,
  frameInterval: 30,
  // A D-pad keeps the plan's own view instead of a full 360° orbit.
  orbitLimit: 40,
  elevationRange: [26, 70],
  zoomRange: [0.55, 1.2],
  allowPan: false,
  staticWalls: true,
  staticShadows: true,
  renderer: { antialias: true },
});

export function tvOf(config) {
  return config.furniture?.find((item) => item.type === 'tv') || null;
}

// The modelled TV's screen centre, matching the shared furniture builder.
export function tvTarget(tv) {
  if (!tv?.pos) return null;
  const angle = rad(tv.rot || 0);
  return {
    x: tv.pos[0] - Math.sin(angle) * 0.129,
    y: (tv.y || 0) + 0.745,
    z: tv.pos[1] - Math.cos(angle) * 0.129,
  };
}

// A camera view for the widget's push-in toward the modelled TV.
export function tvView(config) {
  const tv = tvOf(config);
  const target = tvTarget(tv);
  if (!target) return null;
  return { az: tv.rot || 0, el: 8, dist: 1.6, target };
}
