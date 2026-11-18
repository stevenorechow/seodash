/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Per-entry SEOdash values, kept in the plugin's own `entries` storage collection under
 * `<collection>:<id>`. They sit on top of EmDash's own SEO fields (title, description, image,
 * canonical, hide from search engines), which stay in EmDash and are never copied here.
 */

export interface EntryRecord {
	collection: string;
	entryId: string;
	/** Social overrides. Empty: use the entry's SEO fields, then the page's own. */
	ogTitle: string;
	ogDescription: string;
	ogImage: string;
	twitterTitle: string;
	twitterDescription: string;
	twitterImage: string;
	/** Robots directives beyond EmDash's "hide from search engines". */
	nofollow: boolean;
	noimageindex: boolean;
	nosnippet: boolean;
	/** Comma-separated target keywords for content analysis. */
	targetKeywords: string;
	updatedAt: string;
}

export const EMPTY_ENTRY: Omit<EntryRecord, "collection" | "entryId" | "updatedAt"> = {
	ogTitle: "",
	ogDescription: "",
	ogImage: "",
	twitterTitle: "",
	twitterDescription: "",
	twitterImage: "",
	nofollow: false,
	noimageindex: false,
	nosnippet: false,
	targetKeywords: "",
};

export interface EntryStore {
	get(id: string): Promise<unknown>;
	put(id: string, data: unknown): Promise<void>;
	delete(id: string): Promise<boolean>;
}

export const entryKey = (collection: string, entryId: string) => `${collection}:${entryId}`;

export async function loadEntry(store: EntryStore, collection: string, entryId: string): Promise<EntryRecord> {
	const stored = await store.get(entryKey(collection, entryId));
	const base: EntryRecord = { ...EMPTY_ENTRY, collection, entryId, updatedAt: "" };
	if (typeof stored !== "object" || stored === null) return base;
	const record = stored as Record<string, unknown>;
	const out: Record<string, unknown> = { ...base };
	for (const [name, fallback] of Object.entries(EMPTY_ENTRY)) {
		if (typeof record[name] === typeof fallback) out[name] = record[name];
	}
	if (typeof record.updatedAt === "string") out.updatedAt = record.updatedAt;
	return out as unknown as EntryRecord;
}

/** True when nothing has been entered, so the record need not be stored. */
export function isEmptyEntry(record: EntryRecord): boolean {
	return Object.entries(EMPTY_ENTRY).every(([name, fallback]) => record[name as keyof EntryRecord] === fallback);
}

export async function saveEntry(store: EntryStore, record: EntryRecord): Promise<void> {
	const id = entryKey(record.collection, record.entryId);
	if (isEmptyEntry(record)) {
		await store.delete(id);
		return;
	}
	await store.put(id, { ...record, updatedAt: new Date().toISOString() });
}
