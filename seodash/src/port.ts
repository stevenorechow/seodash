/**
 * Everything in the framework files that is particular to this plugin. The framework files
 * (kit, compose, admin/, core/settings, core/features, core/scope, core/text, modules/features)
 * hold nothing plugin-specific, so a value that is particular to this plugin goes here instead.
 */
import { type EntryRecord, entryKey, loadEntry } from "./core/entry.js";
import { PLUGIN_NAME } from "./version.js";

export type { EntryRecord };

/** A storage collection of the plugin, as far as per-entry records need it. */
export interface RecordStore {
	get(id: string): Promise<unknown>;
	put(id: string, data: unknown): Promise<void>;
	delete(id: string): Promise<boolean>;
}

/** The admin pages, in sidebar order. A page shows only when a module adds a tab to it. */
export const PAGES = [
	{ path: "/", label: "Overview", icon: "dashboard" },
	{ path: "/content", label: "Content", icon: "list" },
	{ path: "/titles", label: "Titles & meta", icon: "tag" },
	{ path: "/social", label: "Social", icon: "users" },
	{ path: "/schema", label: "Structured data", icon: "code" },
	{ path: "/links", label: "Links", icon: "link" },
	{ path: "/reports", label: "Reports", icon: "chart-line" },
	{ path: "/settings", label: "Settings", icon: "settings" },
] as const;

export type PagePath = (typeof PAGES)[number]["path"];

export const PORT = {
	/** Used in log lines only. */
	name: "SEOdash",
	/** Sidebar group and the Overview page's heading. */
	group: "SEO",
	/** The panel beside an entry, named after the plugin so it is not confused with EmDash's own SEO section. */
	panel: { id: "seo", title: PLUGIN_NAME },
	/** Panel text for an entry that has not been saved yet. */
	unsaved: "Save this entry to see its SEO details",
	/** Panel text for collections without pages of their own; empty to show the panel there too. */
	unroutable: "Entries in this collection are shown inside other pages, so there is nothing to set for search engines.",
	/** Bump when scheduled jobs change, so existing installs pick the new schedule up. */
	cronVersion: 3,
	/** Storage every build declares, beside what the modules declare. */
	storage: { entries: { indexes: ["collection", "updatedAt"] } } as Record<string, { indexes: Array<string | string[]> }>,
	/** The plugin's own values for an entry (social overrides, robots extras, keywords). */
	record: (open: (name: string) => RecordStore, collection: string, id: string): Promise<EntryRecord> => loadEntry(open("entries"), collection, id),
	/** Drops them when the entry is deleted. */
	forget: async (open: (name: string) => RecordStore, collection: string, id: string): Promise<void> => {
		await open("entries").delete(entryKey(collection, id));
	},
};
