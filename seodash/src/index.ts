/**
 * SEOdash for EmDash. Add it to the `plugins` list of the EmDash integration in astro.config:
 *
 *   import { seodash, seodashRoutes } from "seodash";
 *   integrations: [emdash({ plugins: [seodash()] }), seodashRoutes()]
 *
 * `seodashRoutes()` is optional: it serves the IndexNow key file once IndexNow is switched on.
 */
import type { PluginDescriptor } from "emdash";
import type { SeodashOptions } from "./plugin.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./version.js";

export { seodashRoutes } from "./astro.js";
export type { SeodashOptions };

export function seodash(options: SeodashOptions = {}): PluginDescriptor<SeodashOptions> {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: "native",
		entrypoint: "seodash/plugin",
		options,
	};
}

export default seodash;
