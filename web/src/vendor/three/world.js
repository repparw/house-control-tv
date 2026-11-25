// TV adapter for the shared @house-control/visuals renderer.
//
// The shared package owns the scene, camera rig, picking and animation loop. This file
// only supplies the webOS budget and the small widget-facing camera helpers, so the TV
// build does not maintain a second copy of the renderer.
import { createWorld as createSharedWorld, STAGE_BG } from '@house-control/visuals';
import { batchStatic } from './batch.js';
import { TV_RENDERER_OPTIONS, tvView } from './tv.js';

export { STAGE_BG };

/** @param {Record<string, any>} [options] */
export function createWorld(canvas, config, store, options = {}) {
  const { presentationAspect = null, batchStatic: batch = batchStatic, ...rest } = options;
  const world = createSharedWorld(canvas, config, store, {
    ...TV_RENDERER_OPTIONS,
    ...rest,
    renderer: { ...TV_RENDERER_OPTIONS.renderer, ...rest.renderer },
    batchStatic: batch,
    presentationAspect,
  });

  const view = tvView(config);
  // The widget reads these three helpers from the world object. They are thin wrappers
  // over shared camera primitives, not another renderer implementation.
  world.tvPoint = () => (view ? world.project(view.target) : null);
  world.cinematicTV = (duration = 1350) => (view ? world.flyTo(view, duration) : false);
  world.resetPresentation = () => {
    if (presentationAspect) world.setPresentationAspect(presentationAspect);
  };

  return world;
}
