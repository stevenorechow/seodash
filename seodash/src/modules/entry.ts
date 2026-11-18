/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * The entry panel: one place to edit how an entry appears in search and when shared.
 *
 * The search title, description, sharing image, canonical URL and "hide from search engines" are EmDash's own SEO
 * fields. The panel edits them in place (there is no second copy), so they keep working without
 * SEOdash. Social overrides, extra robots directives and target keywords are SEOdash's additions.
 */
import { formBlock, type FormSpec, readForm, textField, toggleField } from "../admin/forms.js";
import { type Analysis, DESCRIPTION_LIMIT, NOT_SCORED, SEVERITY_LABEL, TITLE_LIMIT, analyze, bySeverity, parseKeywords } from "../core/analysis.js";
import { type EntryStore, saveEntry } from "../core/entry.js";
import { type Block, type Ctx, type EntryView, type Env, type Module, entryFacts, fail, ok, store, str, note } from "../kit.js";
import { type SearchAppearance, searchAppearance } from "./meta.js";

const SOCIAL: FormSpec = {
	id: "entry:social",
	fields: [
		textField("ogTitle", "Sharing title"),
		textField("ogDescription", "Sharing description", { multiline: true }),
		{ kind: "image", key: "ogImage", label: "Sharing image" },
		textField("twitterTitle", "X title"),
		textField("twitterDescription", "X description", { multiline: true }),
		{ kind: "image", key: "twitterImage", label: "X image" },
	],
};

const ROBOTS: FormSpec = {
	id: "entry:robots",
	fields: [
		toggleField("nofollow", "Don't follow links on this page (nofollow)"),
		toggleField("noimageindex", "Don't index images on this page (noimageindex)"),
		toggleField("nosnippet", "Don't show a text snippet (nosnippet)"),
	],
};

const KEYWORDS: FormSpec = {
	id: "entry:keywords",
	submitLabel: "Analyze",
	fields: [textField("targetKeywords", "Target keywords", { placeholder: "Separate keywords with commas" })],
};

const searchForm = (appearance: SearchAppearance, entry: EntryView): FormSpec => ({
	id: "entry:search",
	fields: [
		textField("title", "Search title", { placeholder: appearance.templateTitle || entry.title }),
		textField("description", "Description", { multiline: true, placeholder: appearance.templateDescription || entry.excerpt }),
		{ kind: "image", key: "image", label: "Sharing image" },
		textField("canonical", "Canonical URL", { placeholder: entry.url ?? "" }),
		toggleField("noIndex", "Hide from search engines"),
	],
});

const SOURCE: Record<string, string> = { seo: "", template: " (from the collection template)", entry: " (the entry title)", excerpt: " (the entry excerpt)", none: "" };
const count = (text: string, limit: number) => (text ? ` · ${text.length} / ${limit}` : "");

/** The analysis of an entry as it is saved now. */
export async function analyzeEntry(ctx: Ctx, env: Env, entry: EntryView, appearance?: SearchAppearance): Promise<Analysis> {
	const search = appearance ?? (await searchAppearance(ctx, env, entry));
	const facts = await entryFacts(ctx, env, entry);
	return analyze({
		title: search.title,
		titleIsCustom: search.titleSource !== "entry",
		description: search.description,
		descriptionIsCustom: search.descriptionSource === "seo" || search.descriptionSource === "template",
		slug: entry.slug ?? "",
		url: entry.url,
		siteUrl: ctx.site.url,
		canonical: entry.seo?.canonical ?? null,
		noIndex: entry.seo?.noIndex === true,
		nofollow: entry.record.nofollow,
		hasImage: Boolean(entry.seo?.image || entry.record.ogImage || entry.image),
		// With structured data switched off there is nothing to ask for.
		hasSchema: facts.hasSchema || !env.modules.some((module) => module.facts),
		updatedAt: entry.updatedAt,
		keywords: parseKeywords(entry.record.targetKeywords),
		heading: entry.title,
		outline: entry.outline,
	});
}

const entries = (ctx: Ctx) => store<unknown>(ctx, "entries") as unknown as EntryStore;

/** Social overrides and robots extras are printed by the titles and social tags feature. */
const tagsOn = (env: Env) => env.modules.some((module) => module.id === "meta") || !env.installed.some((module) => module.id === "meta");

/** A label line and its value below it, at full width. */
const shown = (label: string, value: string): Block[] => [
	note(label),
	{ type: "section", text: value || "Not set" },
];

export const entry: Module = {
	id: "entry",
	panelActions: ["search", "social", "robots", "keywords", "checks"],
	capabilities: ["content:read", "content:write", "schema:read"],
	panel: [
		{
			id: "search",
			label: "Search appearance",
			order: 0,
			async render(ctx, env, view) {
				const appearance = await searchAppearance(ctx, env, view);
				const analysis = await analyzeEntry(ctx, env, view, appearance);
				const blocks: Block[] = [
					analysis.score === null ? { type: "banner", description: `${NOT_SCORED}.` } : { type: "meter", label: "SEO score", value: analysis.score, custom_value: `${analysis.score} / 100` },
					// Full width: EmDash's fields block cuts a value off after a few words.
					...shown(`Search title${SOURCE[appearance.titleSource]}${count(appearance.title, TITLE_LIMIT)}`, appearance.title),
					...shown(`Description${SOURCE[appearance.descriptionSource]}${count(appearance.description, DESCRIPTION_LIMIT)}`, appearance.description),
				];
				if (view.url) blocks.push(note(view.url));
				if (!view.seo) {
					blocks.push({ type: "banner", description: "SEO fields are switched off for this collection. Turn them on in its settings to set a search title and description." });
				} else if (!env.trusted) {
					// EmDash 1.5 lets a sandboxed plugin read these fields but not write them.
					blocks.push(
						...shown("Sharing image", view.seo.image ?? ""),
						...shown("Canonical URL", view.seo.canonical ?? ""),
						note("EmDash's own SEO fields, shown for reference. Edit them in the SEO section of the editor."),
					);
				} else {
					blocks.push(formBlock(searchForm(appearance, view), { title: view.seo.title ?? "", description: view.seo.description ?? "", image: view.seo.image ?? "", canonical: view.seo.canonical ?? "", noIndex: view.seo.noIndex }), {
						type: "context",
						text: "EmDash's own SEO fields, edited here. Leave the title or description empty to use what is shown in grey.",
					});
				}
				return blocks;
			},
		},
		{
			id: "analysis",
			label: "Content analysis",
			order: 10,
			open: (view) => Boolean(view.record.targetKeywords),
			async render(ctx, env, view) {
				const analysis = await analyzeEntry(ctx, env, view);
				const checks = [...analysis.checks].sort(bySeverity);
				return [
					formBlock(KEYWORDS, view.record),
					{
						type: "table",
						page_action_id: "entry:checks",
						// Two columns: the panel is too narrow for the check and its result side by side.
						columns: [
							{ key: "status", label: "", format: "badge" },
							{ key: "check", label: "Check" },
						],
						rows: checks.map((check) => ({ status: SEVERITY_LABEL[check.severity], check: `${check.label}: ${check.detail}` })),
					},
					note(`${analysis.words} words. The analysis reads the entry as it was last saved.`),
				];
			},
		},
		{
			id: "social",
			label: "Social sharing",
			order: 20,
			open: (view) => Boolean(view.record.ogTitle || view.record.ogDescription || view.record.ogImage),
			async render(ctx, env, view) {
				if (!tagsOn(env)) return [];
				const appearance = await searchAppearance(ctx, env, view);
				const record = view.record;
				return [
					{
						type: "fields",
						fields: [
							{ label: "Shared title", value: record.ogTitle || appearance.title || "Not set" },
							{ label: "Shared description", value: record.ogDescription || appearance.description || "Not set" },
							{ label: "Shared image", value: record.ogImage || (view.seo?.image || view.image ? "The entry's image" : "The site default, if one is set") },
						],
					},
					note("Leave a field empty to share the search title, description and image."),
					formBlock(SOCIAL, record),
				];
			},
		},
		{
			id: "robots",
			label: "Robots",
			order: 90,
			open: (view) => view.record.nofollow || view.record.noimageindex || view.record.nosnippet,
			async render(_ctx, env, view) {
				return tagsOn(env) ? [formBlock(ROBOTS, view.record)] : [];
			},
		},
	],

	async act(ctx, env, action, view) {
		if (!view || !action.values) return null;
		const values = action.values;
		if (action.id === "search") {
			if (!view.seo) return fail("SEO fields are switched off for this collection.");
			if (!env.trusted) return fail("Edit these in the SEO section of the editor.");
			const update = (ctx.content as { update?: (collection: string, id: string, data: Record<string, unknown>) => Promise<unknown> } | undefined)?.update;
			if (!update) return fail("SEOdash is not allowed to edit content on this site.");
			const text = (key: string) => (typeof values[key] === "string" ? str(values[key]).trim().slice(0, 2000) : "");
			// Only what changed is written, so a field edited elsewhere in the meantime is not undone.
			const seo: Record<string, unknown> = {};
			for (const key of ["title", "description", "image", "canonical"] as const) {
				if (!(key in values)) continue;
				const next = text(key);
				if (next !== (view.seo[key] ?? "")) seo[key] = next || null;
			}
			if (typeof values.noIndex === "boolean" && values.noIndex !== view.seo.noIndex) seo.noIndex = values.noIndex;
			if (!Object.keys(seo).length) return { toast: { type: "info", message: "Nothing changed" } };
			await update.call(ctx.content, view.collection, view.id, { seo });
			return { toast: { type: "success", message: "Saved" }, refresh: true };
		}
		const spec = action.id === "social" ? SOCIAL : action.id === "robots" ? ROBOTS : action.id === "keywords" ? KEYWORDS : null;
		if (!spec) return null;
		await saveEntry(entries(ctx), readForm(spec, values, view.record));
		return ok(action.id === "keywords" ? "Analyzed" : "Saved");
	},
};
