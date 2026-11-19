/**
 * SEOdash: the trusted ("native") plugin, registered in the site's `astro.config`.
 *
 * Features live in `src/modules`; this file picks the list and adapts it to EmDash's native
 * plugin format. The trusted build can read EmDash's own site settings, so it never asks for a
 * value EmDash already has.
 */
import { definePlugin, getSiteSettings, type PluginContext, pluginResponse } from "emdash";
import { compose } from "./compose.js";
import type { CoreSite, Module, RawReply } from "./kit.js";
import { MODULES } from "./modules/index.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./version.js";

export { PLUGIN_ID, PLUGIN_VERSION };

export interface SeodashOptions {
	/** Collections that get the entry panel. Default: every collection. */
	collections?: string[];
	/** Feature modules to leave out, by id (e.g. `["reports", "tracking"]`). */
	disable?: string[];
}

async function coreSite(): Promise<CoreSite> {
	const site = await getSiteSettings();
	const social = site.social ?? {};
	return {
		tagline: site.tagline ?? "",
		separator: site.seo?.titleSeparator ?? "",
		defaultImage: site.seo?.defaultOgImage?.url ?? "",
		logo: site.logo?.url ?? "",
		staging: site.staging === true,
		googleVerification: site.seo?.googleVerification ?? "",
		bingVerification: site.seo?.bingVerification ?? "",
		profiles: {
			twitter: social.twitter ?? "",
			facebook: social.facebook ?? "",
			instagram: social.instagram ?? "",
			linkedin: social.linkedin ?? "",
			youtube: social.youtube ?? "",
			github: social.github ?? "",
		},
	};
}

type RouteContext = PluginContext & { input: unknown; ui?: { entry?: { collection: string; id: string } } };

export function createPlugin(options: SeodashOptions = {}) {
	const modules: Module[] = MODULES.filter((module) => !options.disable?.includes(module.id));
	const built = compose(modules, { trusted: true, core: coreSite, ...(options.collections ? { collections: options.collections } : {}) });
	const { hooks, uses } = built;
	// A broken setting must never take the page's own head tags, or a save, down with it.
	const quiet = <E>(handler: (event: E, ctx: PluginContext) => Promise<unknown>) => ({ errorPolicy: "continue" as const, handler });
	// EmDash cuts a hook off after 5 seconds. These wait for outside services or work through many entries.
	const slow = <E>(handler: (event: E, ctx: PluginContext) => Promise<unknown>) => ({ ...quiet(handler), timeout: 30000 });

	const routes: Record<string, { permission?: string; public?: boolean; handler: (ctx: RouteContext) => Promise<unknown> } & Record<string, unknown>> = {
		admin: { permission: "plugins:manage", handler: (ctx) => built.routes.admin(ctx.input, ctx) },
		entry: { permission: "content:edit_own", handler: (ctx) => built.routes.entry(ctx.input, ctx.ui?.entry, ctx) },
	};
	for (const [name, route] of Object.entries(built.extraRoutes)) {
		const { handler: _, permission, public: open, ...rest } = route;
		routes[name] = {
			// Methods, body and response modes are passed to EmDash as declared.
			...rest,
			...(open ? { public: true } : { permission: permission ?? "plugins:manage" }),
			handler: async (ctx: RouteContext) => {
				const result = await route.handler(ctx.input, ctx, built.env);
				if (route.response !== "raw") return result;
				const reply = (result && typeof result === "object" && "status" in result ? result : { status: 404, body: result }) as RawReply;
				const text = reply.headers && typeof reply.body === "string";
				return pluginResponse({ status: reply.status, headers: text ? reply.headers : { "Content-Type": "application/json" }, body: { kind: "text", value: text ? (reply.body as string) : JSON.stringify(reply.body) } });
			},
		};
	}

	return definePlugin({
		id: PLUGIN_ID,
		displayName: "SEOdash",
		description: "Search titles and descriptions, social cards, structured data, content analysis, indexing and site audits.",
		version: PLUGIN_VERSION,
		capabilities: [...built.capabilities, ...(uses.fragments ? ["hooks.page-fragments:register"] : []), ...(uses.beforePublish ? ["hooks.content-policy:register"] : [])] as never,
		...(built.allowedHosts.length ? { allowedHosts: built.allowedHosts } : {}),
		storage: built.storage as never,
		hooks: {
			"page:metadata": quiet(hooks.metadata as never),
			"plugin:activate": quiet(hooks.activate),
			"plugin:uninstall": quiet(hooks.uninstall),
			"content:afterDelete": quiet(hooks.remove as never),
			...(uses.save ? { "content:afterSave": quiet(hooks.save as never) } : {}),
			...(uses.publish ? { "content:afterPublish": slow(hooks.publish as never) } : {}),
			...(uses.unpublish ? { "content:afterUnpublish": slow(hooks.unpublish as never) } : {}),
			...(uses.upload ? { "media:afterUpload": quiet(hooks.upload as never) } : {}),
			...(uses.cron ? { cron: slow(hooks.cron as never) } : {}),
			...(uses.beforePublish ? { "content:beforePublish": { handler: hooks.beforePublish } } : {}),
			...(uses.fragments ? { "page:fragments": quiet(hooks.fragments as never) } : {}),
		} as never,
		routes: routes as never,
		...(Object.keys(built.tools).length ? { mcp: { tools: built.tools as never } } : {}),
		admin: built.admin,
	});
}

export default createPlugin;
