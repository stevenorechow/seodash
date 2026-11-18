/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Template variables: `%%name%%` placeholders in titles, descriptions and structured data.
 *
 * A known variable with no value, and an unknown variable, are both removed. `%%_cf_<field>%%`
 * reads a field of the entry.
 */

export interface VariableContext {
	siteTitle: string;
	tagline: string;
	siteUrl: string;
	separator: string;
	/** Reference time for the `current*` variables. */
	now: Date;
	locale: string;
	/** The entry being rendered, when the page is an entry. */
	entry?: {
		title: string;
		excerpt: string;
		/** Plain text of the body. */
		content: string;
		url: string;
		image: string;
		author: string;
		publishedAt: string | null;
		updatedAt: string | null;
		categories: string[];
		tags: string[];
		/** Raw field values, for `%%_cf_<field>%%`. */
		fields: Record<string, unknown>;
	};
	/** Plural label of the entry's collection. */
	collectionLabel?: string;
	targetKeywords?: string;
	/** Page number of a paginated list (1 for the first page). */
	page?: number;
	totalPages?: number;
	searchQuery?: string;
	/** Name and description of the term or archive being listed. */
	termTitle?: string;
	termDescription?: string;
}

const VARIABLE = /%%(.*?)%%/g;
/** Words kept when a variable is filled from body text. */
const EXCERPT_WORDS = 50;

export function trimWords(text: string, count = EXCERPT_WORDS): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length <= count) return words.join(" ");
	return `${words.slice(0, count).join(" ")}…`;
}

function formatDate(iso: string | null | undefined, locale: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleDateString(locale || "en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function part(date: Date, locale: string, options: Intl.DateTimeFormatOptions): string {
	return date.toLocaleDateString(locale || "en", { ...options, timeZone: "UTC" });
}

function scalar(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

type Resolver = (ctx: VariableContext) => string;

const RESOLVERS: Record<string, Resolver> = {
	sep: (c) => c.separator,
	sitetitle: (c) => c.siteTitle,
	sitename: (c) => c.siteTitle,
	tagline: (c) => c.tagline,
	sitedesc: (c) => c.tagline,
	siteurl: (c) => c.siteUrl,
	post_title: (c) => c.entry?.title ?? "",
	title: (c) => c.entry?.title ?? "",
	post_excerpt: (c) => c.entry?.excerpt || trimWords(c.entry?.content ?? ""),
	excerpt: (c) => c.entry?.excerpt || trimWords(c.entry?.content ?? ""),
	post_content: (c) => trimWords(c.entry?.content ?? ""),
	post_url: (c) => c.entry?.url ?? "",
	post_thumbnail_url: (c) => c.entry?.image ?? "",
	post_author: (c) => c.entry?.author ?? "",
	author: (c) => c.entry?.author ?? "",
	post_date: (c) => formatDate(c.entry?.publishedAt, c.locale),
	date: (c) => formatDate(c.entry?.publishedAt, c.locale),
	post_modified_date: (c) => formatDate(c.entry?.updatedAt, c.locale),
	schema_post_date: (c) => c.entry?.publishedAt ?? "",
	schema_post_modified_date: (c) => c.entry?.updatedAt ?? "",
	post_category: (c) => c.entry?.categories[0] ?? "",
	post_tag: (c) => c.entry?.tags.join(", ") ?? "",
	cpt_plural: (c) => c.collectionLabel ?? "",
	target_keyword: (c) => c.targetKeywords ?? "",
	search_keywords: (c) => c.searchQuery ?? "",
	term_title: (c) => c.termTitle ?? "",
	_category_title: (c) => c.termTitle ?? "",
	tag_title: (c) => c.termTitle ?? "",
	archive_title: (c) => c.termTitle ?? "",
	term_description: (c) => c.termDescription ?? "",
	_category_description: (c) => c.termDescription ?? "",
	tag_description: (c) => c.termDescription ?? "",
	page: (c) => (c.page && c.page > 1 ? String(c.page) : ""),
	current_pagination: (c) => (c.page && c.page > 1 ? String(c.page) : ""),
	currentday: (c) => part(c.now, c.locale, { day: "numeric" }),
	currentmonth: (c) => part(c.now, c.locale, { month: "long" }),
	currentmonth_short: (c) => part(c.now, c.locale, { month: "short" }),
	currentmonth_num: (c) => String(c.now.getUTCMonth() + 1).padStart(2, "0"),
	currentyear: (c) => String(c.now.getUTCFullYear()),
	currentdate: (c) => formatDate(c.now.toISOString(), c.locale),
	currenttime: (c) => c.now.toISOString().slice(11, 16),
};

/** Variable names offered in the admin, with what each one prints. */
export const VARIABLE_HELP: Array<{ name: string; label: string }> = [
	{ name: "post_title", label: "Entry title" },
	{ name: "sitetitle", label: "Site title" },
	{ name: "tagline", label: "Site tagline" },
	{ name: "sep", label: "Separator" },
	{ name: "post_excerpt", label: "Entry excerpt" },
	{ name: "post_author", label: "Author name" },
	{ name: "post_date", label: "Publish date" },
	{ name: "post_modified_date", label: "Last modified date" },
	{ name: "post_category", label: "First category" },
	{ name: "post_tag", label: "Tags" },
	{ name: "cpt_plural", label: "Collection name" },
	{ name: "target_keyword", label: "Target keywords" },
	{ name: "currentyear", label: "Current year" },
	{ name: "currentmonth", label: "Current month" },
	{ name: "page", label: "Page number" },
	{ name: "_cf_field", label: "Any entry field; replace “field” with its slug" },
];

function resolve(name: string, ctx: VariableContext): string {
	const resolver = RESOLVERS[name];
	if (resolver) return resolver(ctx);
	if (name.startsWith("_cf_")) return scalar(ctx.entry?.fields[name.slice(4)]);
	return "";
}

/** Replaces every `%%variable%%` and tidies the spacing left by empty ones. */
export function renderTemplate(template: string, ctx: VariableContext): string {
	if (!template) return "";
	const separator = ctx.separator.trim();
	let out = template.replace(VARIABLE, (_match, name: string) => resolve(name.trim(), ctx));
	out = out.replace(/\s+/g, " ").trim();
	if (separator) {
		// A variable that printed nothing can leave a separator at either end, or two in a row.
		const sep = separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out
			.replace(new RegExp(`(?:\\s*${sep}\\s*){2,}`, "g"), ` ${separator} `)
			.replace(new RegExp(`^\\s*${sep}\\s*|\\s*${sep}\\s*$`, "g"), "")
			.trim();
	}
	return out;
}

export function hasVariables(template: string): boolean {
	return /%%.*?%%/.test(template);
}
