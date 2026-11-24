/**
 * Builds the pieces of a plugin definition (capabilities, storage, hooks, routes, admin config)
 * from a list of feature modules. The trusted and sandboxed entry points both use it.
 */
import { adminPages, adminWidgets, handleAdmin, handlePanel } from "./admin/shell.js";
import { activeModules } from "./core/features.js";
import { scoped } from "./core/scope.js";
import { secrets } from "./core/settings.js";
import { firstString, imageUrl, outlineContent } from "./core/text.js";
import type { Contribution, ContentEvent, CoreSite, Ctx, EntryView, Env, Fragment, HeadState, ListedItem, Module, PageInput } from "./kit.js";
import { isRecord, store, str } from "./kit.js";
import { PORT, type RecordStore } from "./port.js";

/**
 * EmDash hands a sandboxed plugin the site address it had at start-up, which is empty on a site
 * whose address was set afterwards. Public output then uses the address the page was requested
 * at, so no tag or id is relative. With neither, the context is left as it is and output that
 * needs an address is left out.
 */
function withSiteUrl(ctx: Ctx, page: PageInput): Ctx {
	let origin = "";
	try {
		origin = new URL(page.url).origin;
	} catch {
		// Not an absolute address: nothing to fall back to.
	}
	if (!/^http/.test(origin)) origin = "";
	// A loopback address stored while developing is not where a deployed site is served.
	const loop = (u: string) => /\/\/(localhost|127\.|\[::1\])/.test(u);
	const url = [ctx.site.url, page.siteUrl, origin].find((u) => u && !(loop(u) && origin && !loop(origin)));
	return !url || url === ctx.site.url ? ctx : (Object.create(ctx, { site: { value: { ...ctx.site, url } } }) as Ctx);
}

export interface ComposeOptions {
	trusted: boolean;
	/** Reads EmDash's own site settings; omit where the host does not expose them. */
	core?: (ctx: Ctx) => Promise<CoreSite | null>;
	/** Collections that get the entry panel. Default: every collection. */
	collections?: string[];
}

const EXCERPT_FIELDS = ["excerpt", "description", "summary", "intro"];
const IMAGE_FIELDS = ["featured_image", "featuredImage", "image", "cover", "hero_image"];
/** Bumped in port.ts when scheduled jobs change, so existing installs pick the new schedule up. */
const CRON_VERSION = PORT.cronVersion;
/** The plugin's storage, as the port's per-entry record functions use it. */
const open = (ctx: Ctx) => (name: string) => store<unknown>(ctx, name) as unknown as RecordStore;

/** Per invocation and collection: one entry's slug and address, from which its neighbours' addresses follow. */
const SAMPLES = new WeakMap<Ctx, Map<string, { slug: string; url: string } | null>>();

/**
 * The public address of an entry that came from a listing. EmDash is asked once per collection
 * and the answer reused for the other entries when the address pattern holds nothing but the slug,
 * so a scan does not spend one host call per entry.
 */
async function listedUrl(ctx: Ctx, info: { routable?: boolean; urlPattern?: string | null } | null | undefined, collection: string, item: ListedItem): Promise<string | null> {
	if (info?.routable === false || item.status !== "published" || !item.slug) return null;
	const ask = async () => {
		try {
			return (await ctx.content?.getPublicUrl?.(collection, item.id)) ?? null;
		} catch {
			return null;
		}
	};
	if (!info?.urlPattern || info.urlPattern.replace("{slug}", "").includes("{")) return ask();
	const samples = SAMPLES.get(ctx) ?? new Map<string, { slug: string; url: string } | null>();
	SAMPLES.set(ctx, samples);
	const key = `${collection}:${item.locale ?? ""}`;
	if (!samples.has(key)) {
		const url = await ask();
		samples.set(key, url && url.lastIndexOf(item.slug) >= 0 ? { slug: item.slug, url } : null);
		return url;
	}
	const sample = samples.get(key);
	if (!sample) return ask();
	const at = sample.url.lastIndexOf(sample.slug);
	return `${sample.url.slice(0, at)}${item.slug}${sample.url.slice(at + sample.slug.length)}`;
}

async function loadEntryView(ctx: Ctx, collection: string, id: string, listed?: ListedItem): Promise<EntryView | null> {
	const item = listed ?? (await ctx.content?.get(collection, id));
	if (!item) return null;
	const schema = await ctx.schema?.getCollection(collection);
	const titleField = (schema as { titleField?: string } | null | undefined)?.titleField || "title";
	let url: string | null = null;
	if (listed) url = await listedUrl(ctx, schema, collection, listed);
	else {
		try {
			url = (await ctx.content?.getPublicUrl?.(collection, id)) ?? null;
		} catch {
			url = null;
		}
	}
	const data = item.data ?? {};
	return {
		collection,
		collectionLabel: schema?.label ?? collection,
		id,
		slug: item.slug,
		status: item.status,
		locale: item.locale,
		title: firstString(data, [titleField, "title", "name"]),
		excerpt: firstString(data, EXCERPT_FIELDS),
		image: imageUrl(IMAGE_FIELDS.map((field) => data[field]).find(Boolean)),
		data,
		seo: item.seo ?? null,
		url,
		publishedAt: item.publishedAt,
		updatedAt: item.updatedAt,
		outline: outlineContent(data),
		record: await PORT.record(open(ctx), collection, id),
	};
}

export function compose(modules: Module[], options: ComposeOptions) {
	const env: Env = {
		trusted: options.trusted,
		modules,
		installed: modules,
		core: async (ctx) => {
			if (!options.core) return null;
			try {
				return await options.core(ctx);
			} catch {
				return null;
			}
		},
		entry: loadEntryView,
	};

	/** The environment for one request: only the modules whose feature is on. */
	const live = async (ctx: Ctx, among: Module[] = modules): Promise<Env> => ({ ...env, modules: await activeModules(ctx, env, among) });

	// Unrestricted network access (link checks, self-hosted analytics) covers every listed host,
	// and EmDash does not accept a host list beside it.
	const wanted = [...new Set(modules.flatMap((module) => [...(module.capabilities ?? []), ...(options.trusted ? [] : (module.sandboxCapabilities ?? []))]))];
	const unrestricted = wanted.includes("network:request:unrestricted");
	const capabilities = unrestricted ? wanted.filter((capability) => capability !== "network:request") : wanted;
	const allowedHosts = unrestricted ? [] : [...new Set(modules.flatMap((module) => module.allowedHosts ?? []))];
	const storage: Record<string, { indexes: Array<string | string[]> }> = { ...PORT.storage };
	for (const module of modules) Object.assign(storage, module.storage ?? {});
	const jobs = modules.flatMap((module) => (module.cron ?? []).map((job) => ({ ...job, module: module.id })));

	async function schedule(ctx: Ctx): Promise<void> {
		if (!ctx.cron || !jobs.length) return;
		for (const job of jobs) await ctx.cron.schedule(job.name, { schedule: job.schedule });
		await ctx.kv.set("cron:version", CRON_VERSION);
	}

	/** Runs `run` for every module that has the handler; one failing module never stops the rest. */
	async function each(ctx: Ctx, what: string, run: (module: Module, env: Env) => Promise<void> | undefined, among?: Module[]): Promise<void> {
		const now = await live(ctx, among);
		for (const module of now.modules) {
			try {
				await run(module, now);
			} catch (error) {
				ctx.log.error(`${PORT.name} ${what} failed`, { module: module.id, error: String(error) });
			}
		}
	}

	const contentEvent = (event: { content: Record<string, unknown>; collection: string }): ContentEvent => ({ collection: event.collection, id: str(event.content.id), content: event.content });

	const hooks = {
		async metadata(event: { page: PageInput }, host: Ctx): Promise<Contribution[] | null> {
			const page = event.page;
			const ctx = withSiteUrl(host, page);
			const ref = page.content;
			let loaded: Promise<EntryView | null> | undefined;
			const state: HeadState = {
				page,
				core: await env.core(ctx),
				record: ref ? await PORT.record(open(ctx), ref.collection, ref.id) : null,
				entry: () => (loaded ??= ref ? loadEntryView(ctx, ref.collection, ref.id) : Promise.resolve(null)),
			};
			const out: Contribution[] = [];
			await each(
				ctx,
				"head output",
				async (module, now) => {
					if (module.head) out.push(...(await module.head(ctx, now, state)));
				},
				modules.filter((module) => module.head),
			);
			return out.length ? out : null;
		},
		async fragments(event: { page: PageInput }, host: Ctx): Promise<Fragment[] | null> {
			const ctx = withSiteUrl(host, event.page);
			const out: Fragment[] = [];
			await each(
				ctx,
				"page fragments",
				async (module, now) => {
					if (module.fragments) out.push(...(await module.fragments(ctx, now, event.page)));
				},
				modules.filter((module) => module.fragments),
			);
			return out.length ? out : null;
		},
		/** First reason any module gives against publishing; a failing check never blocks. */
		async beforePublish(event: { content: Record<string, unknown>; collection: string }, ctx: Ctx): Promise<{ cancel: true; reason: string } | undefined> {
			const now = await live(ctx).catch(() => null);
			for (const module of now?.modules ?? []) {
				if (!module.beforePublish) continue;
				try {
					const reason = await module.beforePublish(ctx, now!, contentEvent(event));
					if (reason) return { cancel: true, reason: reason.slice(0, 500) };
				} catch (error) {
					ctx.log.error(`${PORT.name} publish check failed`, { module: module.id, error: String(error) });
				}
			}
			return undefined;
		},
		activate: async (_event: unknown, ctx: Ctx) => {
			await schedule(ctx);
			await each(ctx, "activation", (module, now) => module.on?.activate?.(ctx, now));
		},
		/** EmDash removes the plugin's data when asked to, but not its scheduled jobs. */
		uninstall: async (_event: unknown, ctx: Ctx) => {
			for (const job of jobs) await ctx.cron?.cancel(job.name).catch(() => undefined);
			for (const module of modules) await module.on?.uninstall?.(ctx).catch(() => undefined);
		},
		save: (event: { content: Record<string, unknown>; collection: string }, ctx: Ctx) => each(ctx, "save handler", (module, now) => module.on?.save?.(ctx, now, contentEvent(event))),
		publish: (event: { content: Record<string, unknown>; collection: string }, ctx: Ctx) => each(ctx, "publish handler", (module, now) => module.on?.publish?.(ctx, now, contentEvent(event))),
		unpublish: (event: { content: Record<string, unknown>; collection: string }, ctx: Ctx) => each(ctx, "unpublish handler", (module, now) => module.on?.unpublish?.(ctx, now, contentEvent(event))),
		async remove(event: { id: string; collection: string }, ctx: Ctx) {
			await PORT.forget(open(ctx), event.collection, event.id);
			await each(ctx, "delete handler", (module, now) => module.on?.delete?.(ctx, now, { collection: event.collection, id: event.id }));
		},
		upload: (event: { media: { id: string; filename: string; mimeType: string; url: string } }, ctx: Ctx) => each(ctx, "upload handler", (module, now) => module.on?.upload?.(ctx, now, event.media)),
		async cron(event: { name: string }, ctx: Ctx) {
			const job = jobs.find((candidate) => candidate.name === event.name);
			if (!job) return;
			try {
				const now = await live(ctx);
				// A switched-off feature does no scheduled work.
				if (now.modules.some((module) => module.id === job.module)) await job.run(ctx, now);
			} catch (error) {
				ctx.log.error(`${PORT.name} scheduled job failed`, { job: job.name, error: String(error) });
			}
		},
	};

	const uses = {
		save: modules.some((module) => module.on?.save),
		publish: modules.some((module) => module.on?.publish),
		unpublish: modules.some((module) => module.on?.unpublish),
		upload: modules.some((module) => module.on?.upload),
		cron: jobs.length > 0,
		fragments: modules.some((module) => module.fragments),
		beforePublish: modules.some((module) => module.beforePublish),
	};

	const routes = {
		async admin(input: unknown, ctx: Ctx) {
			// Installs that predate a scheduled job get it on the next admin visit.
			if (uses.cron && (await ctx.kv.get<number>("cron:version")) !== CRON_VERSION) await schedule(ctx).catch(() => undefined);
			return handleAdmin(input, ctx, () => live(ctx));
		},
		entry: (input: unknown, target: { collection: string; id: string } | undefined, ctx: Ctx) => handlePanel(input, target, ctx, () => live(ctx)),
	};

	// A route answers only while its feature is on. The handler's own `env` argument is replaced by the live one.
	const extraRoutes: NonNullable<Module["routes"]> = {};
	for (const module of modules) {
		for (const [name, route] of Object.entries(module.routes ?? {})) {
			extraRoutes[name] = {
				...route,
				async handler(input, given) {
					const ctx = scoped(given);
					const now = await live(ctx);
					if (!now.modules.includes(module)) return { error: "This feature is switched off." };
					return route.handler(input, ctx, now);
				},
			};
		}
	}

	// Each invocation works on its own remembering view of the context (see core/scope).
	const inScope = <F extends (...args: never[]) => unknown>(fn: F): F => ((...args: unknown[]) => (fn as unknown as (...args: unknown[]) => unknown)(...args.slice(0, -1), scoped(args[args.length - 1] as Ctx))) as unknown as F;
	for (const group of [hooks, routes] as Array<Record<string, (...args: never[]) => unknown>>) for (const name of Object.keys(group)) group[name] = inScope(group[name]!);

	const tools = Object.assign({}, ...modules.map((module) => module.tools ?? {})) as NonNullable<Module["tools"]>;

	// Declaring a key as a secret makes EmDash encrypt it at rest and keep it out of logs.
	const settingsSchema: Record<string, { type: "secret"; label: string }> = {};
	for (const module of modules) {
		for (const [name, label] of Object.entries(module.secrets ?? {})) settingsSchema[secrets.key(name)] = { type: "secret", label };
	}

	const admin = {
		...(Object.keys(settingsSchema).length ? { settingsSchema } : {}),
		pages: adminPages(modules),
		widgets: adminWidgets(modules),
		editorPanels: [{ ...PORT.panel, route: "entry", ...(options.collections ? { collections: options.collections } : {}) }],
	};

	return { env, live, capabilities, allowedHosts, storage, hooks, uses, routes, extraRoutes, tools, admin };
}

export { isRecord };
