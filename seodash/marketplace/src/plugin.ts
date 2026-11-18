/**
 * SEOdash: the marketplace (sandboxed) build.
 *
 * The same feature modules as the trusted plugin, limited to the core set that fits the
 * marketplace's 128 KB code limit (see MODULES in src/modules/index.ts). EmDash's site settings are not readable from the
 * sandbox, so the few values SEOdash would read from them are asked for under Settings → Verification.
 */
import type { PluginContext, SandboxedPlugin, SandboxedRouteContext } from "emdash/plugin";
import { compose } from "../../src/compose.js";
import { MODULES } from "../../src/modules/index.js";

const built = compose(MODULES, { trusted: false });
const { hooks, uses } = built;
const quiet = (handler: (event: never, ctx: PluginContext) => Promise<unknown>) => ({ errorPolicy: "continue" as const, handler });
// EmDash cuts a hook off after 5 seconds. These wait for outside services or work through many entries.
const slow = (handler: (event: never, ctx: PluginContext) => Promise<unknown>) => ({ ...quiet(handler), timeout: 30000 });

type Route = { permission?: string; public?: boolean; handler: (routeCtx: SandboxedRouteContext, ctx: PluginContext) => Promise<unknown> };

const routes: Record<string, Route> = {
	admin: { permission: "plugins:manage", handler: (routeCtx, ctx) => built.routes.admin(routeCtx.input, ctx) },
	entry: {
		permission: "content:edit_own",
		handler: (routeCtx, ctx) => built.routes.entry(routeCtx.input, (routeCtx.ui as { entry?: { collection: string; id: string } } | undefined)?.entry, ctx),
	},
};
for (const [name, route] of Object.entries(built.extraRoutes)) {
	routes[name] = {
		...(route.public ? { public: true } : { permission: route.permission ?? "plugins:manage" }),
		handler: (routeCtx, ctx) => route.handler(routeCtx.input, ctx, built.env),
	};
}

const plugin: SandboxedPlugin = {
	hooks: {
		"page:metadata": quiet(hooks.metadata as never),
		"plugin:activate": quiet(hooks.activate as never),
		"plugin:uninstall": quiet(hooks.uninstall as never),
		"content:afterDelete": quiet(hooks.remove as never),
		...(uses.save ? { "content:afterSave": quiet(hooks.save as never) } : {}),
		...(uses.publish ? { "content:afterPublish": slow(hooks.publish as never) } : {}),
		...(uses.unpublish ? { "content:afterUnpublish": slow(hooks.unpublish as never) } : {}),
		...(uses.upload ? { "media:afterUpload": quiet(hooks.upload as never) } : {}),
		...(uses.cron ? { cron: slow(hooks.cron as never) } : {}),
		...(uses.beforePublish ? { "content:beforePublish": { handler: hooks.beforePublish } } : {}),
	} as never,
	routes: routes as never,
	...(Object.keys(built.tools).length ? { mcp: { tools: built.tools as never } } : {}),
};

export default plugin;

/** What the manifest must declare; `scripts/manifest.mjs` writes it into `emdash-plugin.jsonc`. */
export const declared = {
	capabilities: [...built.capabilities, ...(uses.beforePublish ? ["hooks.content-policy:register"] : [])].sort(),
	allowedHosts: [...built.allowedHosts].sort(),
	storage: built.storage,
	admin: built.admin,
};
