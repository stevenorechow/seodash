/**
 * Test doubles: an in-memory plugin context (`fakeCtx`) that behaves like EmDash's for the parts
 * SEOdash uses, and builders for template variables.
 */
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { compose } from "../src/compose.js";
import type { VariableContext } from "../src/core/variables.js";
import type { CoreSite, Ctx, Module } from "../src/kit.js";

export interface FakeItem {
	id: string;
	slug?: string | null;
	status?: string;
	locale?: string | null;
	data: Record<string, unknown>;
	seo?: { title: string | null; description: string | null; image: string | null; canonical: string | null; noIndex: boolean };
	url?: string | null;
	publishedAt?: string | null;
	updatedAt?: string;
}

export interface FakeOptions {
	collections?: Array<{ slug: string; label: string; hasSeo?: boolean; hidden?: boolean; routable?: boolean }>;
	content?: Record<string, FakeItem[]>;
	site?: { name?: string; url?: string; locale?: string };
	/** Responses for `ctx.http.fetch`, matched by URL substring; unmatched URLs get a 404. */
	http?: Array<{ match: string; status?: number; body?: unknown; headers?: Record<string, string> }>;
	/** Storage collections to create (those of the modules under test are added by `harness`). */
	storage?: string[];
}

function memoryKv() {
	const data = new Map<string, unknown>();
	return {
		data,
		get: async <T>(key: string) => (data.has(key) ? (structuredClone(data.get(key)) as T) : null),
		set: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
		delete: async (key: string) => data.delete(key),
		list: async (prefix = "") => [...data.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
	};
}

function memoryCollection() {
	const data = new Map<string, unknown>();
	const matches = (record: unknown, where?: Record<string, unknown>) => !where || Object.entries(where).every(([field, expected]) => (record as Record<string, unknown>)[field] === expected);
	return {
		data,
		get: async (id: string) => (data.has(id) ? structuredClone(data.get(id)) : null),
		put: async (id: string, value: unknown) => void data.set(id, structuredClone(value)),
		delete: async (id: string) => data.delete(id),
		exists: async (id: string) => data.has(id),
		deleteMany: async (ids: string[]) => ids.filter((id) => data.delete(id)).length,
		getMany: async (ids: string[]) => new Map(ids.filter((id) => data.has(id)).map((id) => [id, structuredClone(data.get(id))])),
		putMany: async (items: Array<{ id: string; data: unknown }>) => void items.forEach((item) => data.set(item.id, structuredClone(item.data))),
		count: async (where?: Record<string, unknown>) => [...data.values()].filter((record) => matches(record, where)).length,
		query: async (options: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number; cursor?: string } = {}) => {
			let items = [...data.entries()].filter(([, record]) => matches(record, options.where)).map(([id, record]) => ({ id, data: structuredClone(record) }));
			const order = Object.entries(options.orderBy ?? {})[0];
			if (order) {
				const [field, direction] = order;
				items.sort((a, b) => {
					const left = (a.data as Record<string, unknown>)[field] as string | number;
					const right = (b.data as Record<string, unknown>)[field] as string | number;
					return (left < right ? -1 : left > right ? 1 : 0) * (direction === "desc" ? -1 : 1);
				});
			}
			const start = options.cursor ? Number(options.cursor) : 0;
			const limit = options.limit ?? 50;
			const page = items.slice(start, start + limit);
			const hasMore = start + limit < items.length;
			return { items: page, hasMore, ...(hasMore ? { cursor: String(start + limit) } : {}) };
		},
	};
}

export type FakeCtx = Ctx & {
	/** Requests made through `ctx.http.fetch`. */
	requests: Array<{ url: string; init?: RequestInit }>;
	emails: Array<Record<string, unknown>>;
	scheduled: Map<string, string>;
	items: Record<string, FakeItem[]>;
	collection(name: string): ReturnType<typeof memoryCollection>;
};

export function fakeCtx(options: FakeOptions = {}): FakeCtx {
	const items = options.content ?? {};
	const collections: NonNullable<FakeOptions["collections"]> = options.collections ?? Object.keys(items).map((slug) => ({ slug, label: slug }));
	const storage = new Map<string, ReturnType<typeof memoryCollection>>();
	const collection = (name: string) => {
		if (!storage.has(name)) storage.set(name, memoryCollection());
		return storage.get(name)!;
	};
	for (const name of ["entries", ...(options.storage ?? [])]) collection(name);
	const requests: FakeCtx["requests"] = [];
	const emails: FakeCtx["emails"] = [];
	const scheduled = new Map<string, string>();
	const view = (slug: string, item: FakeItem) => {
		const info = collections.find((c) => c.slug === slug);
		return {
			id: item.id,
			type: slug,
			slug: item.slug ?? null,
			status: item.status ?? "published",
			locale: item.locale ?? null,
			data: item.data,
			...(info?.hasSeo === false ? {} : { seo: item.seo ?? { title: null, description: null, image: null, canonical: null, noIndex: false } }),
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: item.updatedAt ?? "2026-10-01T00:00:00Z",
			publishedAt: item.publishedAt === undefined ? "2026-01-02T00:00:00Z" : item.publishedAt,
		};
	};
	const ctx = {
		plugin: { id: "seodash", version: "test" },
		items,
		requests,
		emails,
		scheduled,
		collection,
		storage: new Proxy({}, { get: (_target, name: string) => storage.get(name) }),
		kv: memoryKv(),
		settings: memoryKv(),
		site: { name: options.site?.name ?? "Acme", url: options.site?.url ?? "https://acme.test", locale: options.site?.locale ?? "en" },
		url: (path: string) => new URL(path, options.site?.url ?? "https://acme.test").toString(),
		log: { debug() {}, info() {}, warn() {}, error() {} },
		schema: {
			listCollections: async () => collections.map((c) => ({ slug: c.slug, label: c.label, hasSeo: c.hasSeo !== false, routable: c.routable !== false, hidden: c.hidden === true })),
			getCollection: async (slug: string) => {
				const found = collections.find((c) => c.slug === slug);
				if (!found) return null;
				// As in EmDash, the address of an entry follows from its collection's pattern (unless a test gives an entry its own).
				const plain = (items[slug] ?? []).every((item) => item.url === undefined);
				return { slug, label: found.label, hasSeo: found.hasSeo !== false, titleField: "title", fields: [], routable: found.routable !== false, urlPattern: found.routable === false || !plain ? null : `/${slug}/{slug}` };
			},
		},
		content: {
			get: async (slug: string, id: string) => {
				const item = (items[slug] ?? []).find((candidate) => candidate.id === id);
				return item ? view(slug, item) : null;
			},
			list: async (slug: string, opts: { limit?: number; cursor?: string; where?: { status?: string } } = {}) => {
				const every = (items[slug] ?? []).filter((item) => !opts.where?.status || (item.status ?? "published") === opts.where.status);
				const start = opts.cursor ? Number(opts.cursor) : 0;
				const limit = opts.limit ?? 50;
				const hasMore = start + limit < every.length;
				return { items: every.slice(start, start + limit).map((item) => view(slug, item)), hasMore, ...(hasMore ? { cursor: String(start + limit) } : {}) };
			},
			getPublicUrl: async (slug: string, id: string) => {
				const item = (items[slug] ?? []).find((candidate) => candidate.id === id);
				if (!item || (item.status ?? "published") !== "published") return null;
				if (collections.find((c) => c.slug === slug)?.routable === false) return null;
				return item.url === undefined ? `https://acme.test/${slug}/${item.slug ?? item.id}` : item.url;
			},
			update: async (slug: string, id: string, data: Record<string, unknown>) => {
				const item = (items[slug] ?? []).find((candidate) => candidate.id === id);
				if (!item) throw new Error("Content not found");
				const { seo, ...fields } = data as { seo?: Record<string, unknown> };
				Object.assign(item.data, fields);
				if (seo) item.seo = { title: null, description: null, image: null, canonical: null, noIndex: false, ...item.seo, ...seo } as FakeItem["seo"];
				return view(slug, item);
			},
		},
		taxonomies: { getEntryTerms: async () => [], getAll: async () => [], getTerms: async () => [] },
		media: {
			get: async () => null,
			list: async () => ({ items: [], hasMore: false }),
			updateMetadata: async () => undefined,
		},
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				requests.push({ url, ...(init ? { init } : {}) });
				const hit = (options.http ?? []).find((candidate) => url.includes(candidate.match));
				if (!hit) return new Response("not found", { status: 404 });
				const body = typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body ?? {});
				return new Response(hit.status === 204 ? null : body, { status: hit.status ?? 200, headers: { "content-type": typeof hit.body === "string" ? "text/plain" : "application/json", ...hit.headers } });
			},
		},
		cron: {
			schedule: async (name: string, opts: { schedule: string }) => void scheduled.set(name, opts.schedule),
			cancel: async (name: string) => void scheduled.delete(name),
			list: async () => [...scheduled.entries()].map(([name, schedule]) => ({ name, schedule, nextRunAt: "", lastRunAt: null })),
		},
		email: { send: async (message: Record<string, unknown>) => void emails.push(message) },
	};
	return ctx as unknown as FakeCtx;
}

export const CORE: CoreSite = {
	tagline: "Tools that work",
	separator: "|",
	defaultImage: "",
	logo: "",
	staging: false,
	googleVerification: "",
	bingVerification: "",
	profiles: { twitter: "", facebook: "", instagram: "", linkedin: "", youtube: "", github: "" },
};

/**
 * Modules composed the way the plugin does it, over a fake context. `core: null` behaves like the
 * marketplace sandbox (EmDash's site settings cannot be read).
 */
/**
 * The shell shows an action's outcome as a "notice" banner at the top of the response, never as a toast
 * (EmDash pins toasts over the header controls). Tests read it back as `toast`, with the type its
 * block id carries (`notice-success`, `notice-info`, `notice-error`).
 */
export async function withNotice<T>(pending: Promise<T> | T): Promise<T & { toast?: { type: string; message: string } }> {
	const response = (await pending) as T & { blocks?: Array<Record<string, unknown>>; toast?: unknown };
	if (response && typeof response === "object" && "toast" in response) throw new Error("the shell returned a toast");
	const banner = response?.blocks?.find((block) => block.type === "banner" && String(block.block_id).startsWith("notice-"));
	type Out = T & { toast?: { type: string; message: string } };
	return (banner ? { ...response, toast: { type: String(banner.block_id).slice(7), message: String(banner.description) } } : response) as Out;
}

export function harness(modules: Module[], options: FakeOptions & { core?: Partial<CoreSite> | null; /** "default" leaves features as a new install has them; otherwise every feature is switched on. */ features?: "default" } = {}) {
	const ctx = fakeCtx(options);
	if (options.features !== "default") (ctx.settings as unknown as { data: Map<string, unknown> }).data.set("config:features", Object.fromEntries(modules.filter((module) => module.feature).map((module) => [module.id, true])));
	const core = options.core === null ? undefined : { ...CORE, ...options.core, profiles: { ...CORE.profiles, ...options.core?.profiles } };
	const built = compose(modules, { trusted: core !== undefined, ...(core ? { core: async () => core } : {}) });
	for (const name of Object.keys(built.storage)) ctx.collection(name);
	return {
		ctx,
		env: built.env,
		built,
		/** Loads an admin page. */
		page: (path: string) => withNotice(built.routes.admin({ type: "page_load", page: path }, ctx)),
		/** Submits a form on an admin page. */
		submit: (page: string, actionId: string, values: Record<string, unknown>) => withNotice(built.routes.admin({ type: "form_submit", page, action_id: actionId, values }, ctx)),
		/** Presses a button on an admin page. */
		press: (page: string, actionId: string, value?: unknown) => withNotice(built.routes.admin({ type: "block_action", page, action_id: actionId, value }, ctx)),
		/** Loads or interacts with the entry panel. */
		panel: (collection: string, id: string, input: unknown = { type: "panel_load" }) => withNotice(built.routes.entry(input, { collection, id }, ctx)),
		/** The head tags for a public page. */
		head: (page: Record<string, unknown>) =>
			built.hooks.metadata({ page: { url: "https://acme.test/", path: "/", locale: "en", pageType: "website", title: null, description: null, canonical: null, image: null, ...page } as never }, ctx),
	};
}

/** Asserts that a response passes EmDash's own Block Kit validator. */
export function valid(response: unknown): void {
	const result = validateBlockResponse(response as never, { pluginPagePaths: ["/overview", "/content", "/titles", "/social", "/schema", "/links", "/reports", "/settings"] }) as { valid: boolean; errors: unknown[] };
	if (!result.valid) throw new Error(`Invalid Block Kit: ${JSON.stringify(result.errors).slice(0, 600)}`);
}

/** All text of a Block Kit response, for simple "is it shown" assertions. */
export function textOf(response: unknown): string {
	return JSON.stringify(response);
}

export const vars = (patch: Partial<VariableContext> = {}): VariableContext => ({
	siteTitle: "Acme",
	tagline: "Tools that work",
	siteUrl: "https://acme.test",
	separator: "-",
	now: new Date("2026-03-09T10:30:00Z"),
	locale: "en",
	...patch,
});

export const entryVars = (patch: Partial<NonNullable<VariableContext["entry"]>> = {}): VariableContext["entry"] => ({
	title: "Hello world",
	excerpt: "A short summary.",
	content: "Body text of the entry.",
	url: "https://acme.test/blog/hello-world",
	image: "",
	author: "Sam Lee",
	publishedAt: "2026-01-15T08:00:00Z",
	updatedAt: "2026-02-01T08:00:00Z",
	categories: ["News"],
	tags: ["launch", "product"],
	fields: { subtitle: "The subtitle", count: 3 },
	...patch,
});

/**
 * Counts the host calls made through a context: every one is a subrequest in EmDash's sandbox,
 * which allows about 30 per invocation. Returns a function that reads and resets the count.
 */
export function countCalls(ctx: FakeCtx, names: string[] = []): () => number {
	let calls = 0;
	const wrap = (target: Record<string, unknown>, label: string) => {
		for (const [name, value] of Object.entries(target)) {
			if (typeof value !== "function") continue;
			target[name] = (...args: unknown[]) => {
				calls++;
				names.push(`${label}.${name}(${typeof args[0] === "string" ? args[0] : ""})`);
				return (value as (...args: unknown[]) => unknown)(...args);
			};
		}
	};
	const loose = ctx as unknown as Record<string, Record<string, unknown> | undefined>;
	for (const part of ["kv", "settings", "schema", "content", "http", "cron", "email", "media", "taxonomies"]) if (loose[part]) wrap(loose[part]!, part);
	const seen = new Set<unknown>();
	const storage = ctx.storage as unknown as Record<string, Record<string, unknown>>;
	(ctx as unknown as { storage: unknown }).storage = new Proxy(
		{},
		{
			get: (_target, name: string) => {
				const collection = storage[name];
				if (collection && !seen.has(collection)) {
					seen.add(collection);
					wrap(collection, name);
				}
				return collection;
			},
		},
	);
	return () => {
		const count = calls;
		calls = 0;
		return count;
	};
}
