/**
 * The contract every feature module follows, and the helpers they share.
 *
 * A module is plain data plus functions that take the plugin context. It can add tabs to the admin
 * pages, sections to the entry panel, head tags, event handlers, scheduled jobs, routes and agent
 * tools. `plugin.ts` (trusted build) and `sandbox.ts` (marketplace build) each pick a list of
 * modules and hand it to `compose()`, so a feature is written once and runs in both.
 */
import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash";
import type { ContentOutline } from "./core/text.js";
import type { EntryRecord, PagePath } from "./port.js";

export type { PagePath };

export type Ctx = PluginContext;

export type Contribution =
	| { kind: "meta"; name: string; content: string; key?: string }
	| { kind: "property"; property: string; content: string; key?: string }
	| { kind: "link"; rel: "canonical" | "alternate"; href: string; hreflang?: string; key?: string }
	| { kind: "jsonld"; id?: string; graph: Record<string, unknown> | Array<Record<string, unknown>> };

/** The parts of EmDash's public page context a plugin reads. */
export interface PageInput {
	url: string;
	path: string;
	locale: string | null;
	pageType: string;
	title: string | null;
	pageTitle?: string | null;
	description: string | null;
	canonical: string | null;
	image: string | null;
	content?: { collection: string; id: string; slug: string | null };
	seo?: { ogTitle?: string | null; ogDescription?: string | null; ogImage?: string | null; robots?: string | null };
	articleMeta?: { publishedTime?: string | null; modifiedTime?: string | null; author?: string | null };
	siteName?: string;
	siteUrl?: string;
	breadcrumbs?: Array<{ name: string; url: string }>;
}

/** An entry's values in EmDash's own SEO fields. Null when the collection has SEO switched off. */
export interface CoreSeo {
	title: string | null;
	description: string | null;
	image: string | null;
	canonical: string | null;
	noIndex: boolean;
}

/**
 * What a plugin reads from EmDash's own site settings, so it never keeps a second copy of them.
 * Empty strings mean "not set".
 */
export interface CoreSite {
	tagline: string;
	separator: string;
	defaultImage: string;
	logo: string;
	staging: boolean;
	googleVerification: string;
	bingVerification: string;
	profiles: { twitter: string; facebook: string; instagram: string; linkedin: string; youtube: string; github: string };
}

/** A saved entry, loaded once per request and shared by every module. */
export interface EntryView {
	collection: string;
	collectionLabel: string;
	id: string;
	slug: string | null;
	status: string;
	locale: string | null;
	title: string;
	excerpt: string;
	image: string;
	data: Record<string, unknown>;
	/** EmDash's SEO fields; null when the collection has them switched off. */
	seo: CoreSeo | null;
	/** Public URL, or null while the entry is unpublished or not routable. */
	url: string | null;
	publishedAt: string | null;
	updatedAt: string | null;
	outline: ContentOutline;
	/** The plugin's own per-entry values, where the port keeps any (see port.ts). */
	record: EntryRecord;
}

export type Placement = "head" | "body:start" | "body:end";

export type Fragment =
	| { kind: "external-script"; placement: Placement; src: string; async?: boolean; defer?: boolean; attributes?: Record<string, string>; key?: string }
	| { kind: "inline-script"; placement: Placement; code: string; attributes?: Record<string, string>; key?: string }
	| { kind: "html"; placement: Placement; html: string; key?: string };

export interface Env {
	/** True in the trusted build; false inside the marketplace sandbox. */
	trusted: boolean;
	/** The modules whose feature is switched on for this request. */
	modules: Module[];
	/** Every module in the build, on or off. */
	installed: Module[];
	/** EmDash's site settings, or null where the host does not expose them (sandbox). */
	core(ctx: Ctx): Promise<CoreSite | null>;
	/** Loads a saved entry with everything modules need; null when it cannot be read. */
	/** `listed` is the entry as a content listing returned it, which saves reading it again. */
	entry(ctx: Ctx, collection: string, id: string, listed?: ListedItem): Promise<EntryView | null>;
}

export interface Action {
	/** The action id without its `<module>:` prefix. */
	id: string;
	/** Submitted form values (form submit). */
	values?: Record<string, unknown>;
	/** Button or menu value (block action). */
	value?: unknown;
}

export interface Toast {
	type: "success" | "error" | "info";
	message: string;
}

export interface ActResult {
	toast?: Toast;
	/** Admin page to show next; defaults to the page the action came from. */
	page?: string;
	/** Module id whose tab to show on that page. */
	tab?: string;
	/** Entry panel only: reload the entry in the editor (after changing EmDash's own fields). */
	refresh?: boolean;
}

/** One tab of an admin page. Pages with a single tab show it without a tab bar. */
export interface PageTab {
	page: PagePath;
	label: string;
	order: number;
	/** Shown while the module's feature is off, so what it needs can be entered first. */
	setup?: boolean;
	/** For a module with several tabs on one page: whether this tab sent the action, so the page stays on it. */
	owns?(action: Action): boolean;
	render(ctx: Ctx, env: Env, state: PageState): Promise<Block[]>;
}

/** Carried between interactions of one page view through action values (the host keeps no state). */
export interface PageState {
	/** The action that led to this render, if any, so a tab can show its result. */
	action?: Action & { module: string };
	/** Module id whose tab to open. */
	focus?: string;
}

/** One section of the entry panel. Order 0 is shown open at the top; the rest are accordions. */
export interface PanelSection {
	id: string;
	label: string;
	order: number;
	/** Whether the accordion starts open. */
	open?(entry: EntryView): boolean;
	render(ctx: Ctx, env: Env, entry: EntryView): Promise<Block[]>;
}

export interface HeadState {
	page: PageInput;
	core: CoreSite | null;
	/** The plugin's per-entry values; null on pages that are not an entry. */
	record: EntryRecord | null;
	/** The page's entry, loaded on first use. */
	entry(): Promise<EntryView | null>;
}

export interface CronJob {
	name: string;
	/** Cron expression, e.g. `0 3 * * *`. */
	schedule: string;
	run(ctx: Ctx, env: Env): Promise<void>;
}

export interface RouteDef {
	permission?: string;
	public?: boolean;
	/** Methods the host accepts; others are refused before the handler runs. */
	methods?: string[];
	/** How the host reads the request body. `text` hands the handler the body as a string. */
	request?: { body: "none" | "json" | "text"; maxBytes?: number };
	/** `raw`: the handler returns a `RawReply`, sent as is instead of inside EmDash's envelope. */
	response?: "raw";
	handler(input: unknown, ctx: Ctx, env: Env): Promise<unknown>;
}

/** What a `response: "raw"` route returns. */
export interface RawReply {
	status: number;
	/** Sent as JSON. */
	body: unknown;
}

export interface ContentEvent {
	collection: string;
	id: string;
	content: Record<string, unknown>;
}

export interface MediaEvent {
	id: string;
	filename: string;
	mimeType: string;
	url: string;
}

export interface WidgetDef {
	id: string;
	title: string;
	size: "full" | "half" | "third";
	render(ctx: Ctx, env: Env): Promise<Block[]>;
}

/** Makes a module a feature the site owner can switch on and off (Settings → Features). */
export interface Feature {
	label: string;
	/** One line: what switching it on gives. */
	description: string;
	/** Starts switched off. Default: on. */
	off?: boolean;
	/** Other features (module ids) that must be on. */
	requires?: string[];
	/** Where the missing thing is entered, when that is another module's tab: its page and module id. */
	setup?: { page: PagePath; tab: string };
	/** What is still missing before it can be switched on ("An API key"), or null when ready. */
	needs?(ctx: Ctx, env: Env): Promise<string | null>;
}

export interface Module {
	/** Short lowercase id; prefixes the module's action ids (`<id>:<action>`). */
	id: string;
	/**
	 * The actions the panel beside an entry may send to `act` (an id, or the part before a `/`).
	 * The panel is open to anyone who may edit the entry, so every other action is refused there
	 * and only reaches `act` from an admin page, which needs the right to manage plugins.
	 */
	panelActions?: string[];
	/** Omit for a module that is always on. */
	feature?: Feature;
	capabilities?: string[];
	allowedHosts?: string[];
	storage?: Record<string, { indexes: Array<string | string[]> }>;
	/** API keys and tokens the module stores with the `secrets` helper: name → label. EmDash encrypts them. */
	secrets?: Record<string, string>;
	tabs?: PageTab[];
	panel?: PanelSection[];
	widgets?: WidgetDef[];
	/** Handles a form submit or button press whose id starts with `<id>:`. */
	act?(ctx: Ctx, env: Env, action: Action, entry: EntryView | null): Promise<ActResult | null>;
	head?(ctx: Ctx, env: Env, state: HeadState): Promise<Contribution[]>;
	on?: {
		activate?(ctx: Ctx, env: Env): Promise<void>;
		/** The module's feature was switched on or off. */
		toggle?(ctx: Ctx, env: Env, on: boolean): Promise<void>;
		save?(ctx: Ctx, env: Env, event: ContentEvent): Promise<void>;
		publish?(ctx: Ctx, env: Env, event: ContentEvent): Promise<void>;
		unpublish?(ctx: Ctx, env: Env, event: ContentEvent): Promise<void>;
		delete?(ctx: Ctx, env: Env, event: { collection: string; id: string }): Promise<void>;
		upload?(ctx: Ctx, env: Env, media: MediaEvent): Promise<void>;
	};
	cron?: CronJob[];
	routes?: Record<string, RouteDef>;
	/** Agent-callable tools (MCP), each backed by one of the module's private routes. `input` is a Zod schema. */
	tools?: Record<string, { description: string; route: string; input: unknown; destructive?: boolean }>;
	/** Return a reason to stop an entry from being published, or null to allow it. */
	beforePublish?(ctx: Ctx, env: Env, event: ContentEvent): Promise<string | null>;
	/** Trusted build only: raw scripts and markup added to public pages. */
	fragments?(ctx: Ctx, env: Env, page: PageInput): Promise<Fragment[]>;
	/** Facts about an entry that other modules' checks use (e.g. "has structured data"). */
	facts?(ctx: Ctx, env: Env, entry: EntryView): Promise<Partial<EntryFacts>>;
	/** Called before `facts` is asked for many entries of one collection, to read what it needs in one go. */
	prepare?(ctx: Ctx, env: Env, collection: string, ids: string[]): Promise<void>;
}

export interface EntryFacts {
	hasSchema: boolean;
}

export async function entryFacts(ctx: Ctx, env: Env, entry: EntryView): Promise<EntryFacts> {
	const facts: EntryFacts = { hasSchema: false };
	for (const module of env.modules) {
		if (!module.facts) continue;
		try {
			Object.assign(facts, await module.facts(ctx, env, entry));
		} catch {
			// A fact that cannot be read counts as absent.
		}
	}
	return facts;
}

// ── Helpers ─────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An entry as `ctx.content.list` returns it. */
export type ListedItem = NonNullable<Awaited<ReturnType<NonNullable<Ctx["content"]>["get"]>>>;

export const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A typed handle on one of the plugin's storage collections. */
export interface Store<T> {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	delete(id: string): Promise<boolean>;
	deleteMany(ids: string[]): Promise<number>;
	putMany(items: Array<{ id: string; data: T }>): Promise<void>;
	query(options?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{ items: Array<{ id: string; data: T }>; cursor?: string; hasMore: boolean }>;
	count(where?: Record<string, unknown>): Promise<number>;
}

export function store<T>(ctx: Ctx, name: string): Store<T> {
	const found = (ctx.storage as unknown as Record<string, Store<T> | undefined>)[name];
	if (!found) throw new Error(`Storage collection "${name}" is not declared`);
	return found;
}

/** Every record of a storage collection matching `where` (bounded). */
export async function all<T>(collection: Store<T>, where?: Record<string, unknown>, max = 5000): Promise<Array<{ id: string; data: T }>> {
	const out: Array<{ id: string; data: T }> = [];
	let cursor: string | undefined;
	do {
		const page = await collection.query({ ...(where ? { where } : {}), limit: 100, ...(cursor ? { cursor } : {}) });
		out.push(...page.items);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor && out.length < max);
	return out;
}

/** `fetch` through the host, or null when the plugin has no network access. */
export async function request(ctx: Ctx, url: string, init?: RequestInit): Promise<Response | null> {
	if (!ctx.http) return null;
	return ctx.http.fetch(url, init);
}

export const ok = (message: string): ActResult => ({ toast: { type: "success", message } });
export const fail = (message: string): ActResult => ({ toast: { type: "error", message } });
/** A line of explanatory text. */
export const note = (text: string): Block => ({ type: "context", text });

/** Short "3 days ago" style text for a past ISO date. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
	if (!iso) return "Never";
	const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
	if (seconds < 90) return "Just now";
	const units: Array<[number, string]> = [
		[86400 * 365, "year"],
		[86400 * 30, "month"],
		[86400, "day"],
		[3600, "hour"],
		[60, "minute"],
	];
	for (const [size, name] of units) {
		if (seconds >= size) {
			const n = Math.floor(seconds / size);
			return `${n} ${name}${n === 1 ? "" : "s"} ago`;
		}
	}
	return "Just now";
}

export type { Block, BlockResponse };
