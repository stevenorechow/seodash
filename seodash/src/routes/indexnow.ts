/** `/indexnow-key.txt`, injected by `seodashRoutes()`. Proves to IndexNow that the site owns its key. */
import { getPluginSetting } from "emdash";
import { PLUGIN_ID } from "../version.js";

export const prerender = false;

export const GET = async (): Promise<Response> => {
	const [settings, features] = await Promise.all([
		getPluginSetting<{ indexnow?: boolean; key?: string }>(PLUGIN_ID, "config:indexing").catch(() => undefined),
		getPluginSetting<Record<string, boolean>>(PLUGIN_ID, "config:features").catch(() => undefined),
	]);
	if (!settings?.indexnow || !settings.key || features?.indexing === false) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
	return new Response(settings.key, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
};
