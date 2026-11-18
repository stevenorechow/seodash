/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Walks every published entry of the site in small, resumable batches. A scheduled run may be cut
 * off after a few seconds, so the position is kept in KV after each page and the next run carries
 * on from there.
 */
import { hostCalls } from "../core/scope.js";
import type { Ctx, ListedItem } from "../kit.js";

export interface ScanCursor {
	collectionIndex: number;
	/** Slug at `collectionIndex`, so the position survives collections being added or removed. */
	collection: string;
	cursor?: string;
	/** When this pass began (ISO). */
	startedAt: string;
	/** Entries visited so far in this pass. */
	done: number;
}

export interface ScanLimits {
	/** Stop after about this many entries. */
	items: number;
	/** Stop after about this many milliseconds. */
	ms: number;
	/**
	 * The host calls one invocation may make. A new page of entries is started only while it is
	 * expected to fit. EmDash's sandbox allows about 30 calls per invocation.
	 */
	calls?: number;
}

/** What a scan may do before and after each page of entries, to read and write in bulk. */
export interface ScanPage {
	before?(collection: string, items: ListedItem[]): Promise<void>;
	after?(collection: string): Promise<void>;
}

export interface ScanResult {
	/** True when every collection has been walked. The cursor is left in KV for the caller to delete once its own end-of-pass work is done. */
	finished: boolean;
	/** Entries visited by this call. */
	processed: number;
	/** Entries visited in the whole pass. */
	done: number;
	startedAt: string;
}

export const SCAN_LIMITS: ScanLimits = { items: 40, ms: 8000 };
/** In the sandbox: a page of entries costs about six host calls, and finishing a pass a few more. */
export const SANDBOX_SCAN_LIMITS: ScanLimits = { items: 40, ms: 8000, calls: 25 };
/** Host calls a page of entries is assumed to cost until one has been measured. */
const PAGE_CALLS = 8;
const PAGE = 10;

/** Slugs of the collections a scan covers: those whose entries are pages of the site, in a stable order. */
export async function scanCollections(ctx: Ctx): Promise<string[]> {
	const list = (await ctx.schema?.listCollections()) ?? [];
	return list
		.filter((collection) => (collection as { hidden?: boolean }).hidden !== true && (collection as { routable?: boolean }).routable !== false)
		.map((collection) => collection.slug)
		.sort();
}

/**
 * Visits published entries from where the cursor under `key` left off, until the limits are
 * reached or every collection is done. A failing `visit` is logged and skipped.
 */
export async function scanEntries(
	ctx: Ctx,
	key: string,
	limits: ScanLimits,
	visit: (collection: string, id: string, startedAt: string, item: ListedItem) => Promise<void>,
	started = Date.now(),
	page: ScanPage = {},
): Promise<ScanResult> {
	const collections = await scanCollections(ctx);
	let state: ScanCursor = (await ctx.kv.get<ScanCursor>(key)) ?? { collectionIndex: 0, collection: collections[0] ?? "", startedAt: new Date().toISOString(), done: 0 };
	if (state.collectionIndex < collections.length && collections[state.collectionIndex] !== state.collection) {
		const at = collections.indexOf(state.collection);
		if (at >= 0) state = { ...state, collectionIndex: at };
		else {
			state = { ...state, collection: collections[state.collectionIndex] ?? "" };
			delete state.cursor;
		}
	}
	let processed = 0;
	let pageCost = PAGE_CALLS;
	while (state.collectionIndex < collections.length) {
		if (processed >= limits.items || Date.now() - started >= limits.ms) break;
		if (limits.calls !== undefined && hostCalls(ctx) + pageCost > limits.calls) break;
		const callsBefore = hostCalls(ctx);
		const slug = collections[state.collectionIndex]!;
		let items: ListedItem[] = [];
		let next: string | undefined;
		try {
			const page = await ctx.content?.list(slug, { limit: PAGE, where: { status: "published" }, ...(state.cursor ? { cursor: state.cursor } : {}) });
			items = page?.items ?? [];
			next = page?.hasMore ? page.cursor : undefined;
		} catch (error) {
			ctx.log.warn("SEOdash scan could not list a collection", { collection: slug, error: String(error) });
		}
		if (items.length && page.before) await page.before(slug, items).catch((error) => ctx.log.warn("SEOdash scan could not prepare a page", { collection: slug, error: String(error) }));
		for (const item of items) {
			try {
				await visit(slug, item.id, state.startedAt, item);
			} catch (error) {
				ctx.log.warn("SEOdash scan skipped an entry", { collection: slug, id: item.id, error: String(error) });
			}
			processed++;
		}
		if (items.length && page.after) await page.after(slug);
		state.done += items.length;
		if (next) state.cursor = next;
		else {
			state.collectionIndex++;
			state.collection = collections[state.collectionIndex] ?? "";
			delete state.cursor;
		}
		await ctx.kv.set(key, state);
		pageCost = Math.max(PAGE_CALLS, hostCalls(ctx) - callsBefore);
	}
	const finished = state.collectionIndex >= collections.length;
	return { finished, processed, done: state.done, startedAt: state.startedAt };
}
