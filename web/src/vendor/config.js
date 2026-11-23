// Compatibility bridge for TV code that still imports the old config path.
// Parsing, validation, and device linking now come from PR #29's shared package.
export {
  ConfigError, LIGHT_KINDS, LINK_FIELDS, SERVICES, FLOOR_KINDS, SLAB,
  levelsOf, linkOf, isLinked, normalize,
} from '@house-control/visuals/config';

import { ConfigError, normalize } from '@house-control/visuals/config';

export async function loadRawConfig() {
  const boot = window.__HOUSE_BOOT__;
  if (boot?.config) return boot.config;
  const plan = (boot?.plan !== 'custom' && boot?.plan) || new URLSearchParams(location.search).get('plan') || 'home';
  const res = await fetch(`./plans/${plan}.json`);
  if (!res.ok) throw new ConfigError(`Plan "${plan}" not found (HTTP ${res.status})`);
  try { return await res.json(); }
  catch (error) { throw new ConfigError(`Plan "${plan}" is not valid JSON: ${error.message}`); }
}

export async function loadConfig() { return normalize(await loadRawConfig()); }
