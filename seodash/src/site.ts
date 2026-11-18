/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Helpers for a site's Astro templates (`import { … } from "<package>/site"`).
 *
 * EmDash does not let a plugin set a page's `<title>`: the template does that. These helpers give
 * the template what SEOdash's title and description templates produce, so it can use them where an
 * entry has no SEO title or description of its own.
 */
import { getPluginSetting, getSiteSettings } from "emdash";
import { PLUGIN_ID } from "./version.js";
import type { CollectionTitles, TitlesSettings } from "./core/head.js";
import { firstString, imageUrl, outlineContent } from "./core/text.js";
import { renderTemplate, type VariableContext } from "./core/variables.js";

export interface TemplateEntry {
	id?: string;
	slug?: string | null;
	data: Record<string, unknown>;
	seo?: { title?: string | null; description?: string | null } | null;
	publishedAt?: string | Date | null;
	updatedAt?: string | Date | null;
}

export interface TemplateOptions {
	/** The entry's collection slug. */
	collection: string;
	/** The page's address, for `%%post_url%%`. */
	url?: string;
	author?: string;
}

export interface TemplateResult {
	/** The complete title from the collection's template; null when the entry has its own SEO title or there is no template. */
	title: string | null;
	/** The description from the collection's template; null in the same cases. */
	description: string | null;
}

const iso = (value: string | Date | null | undefined) => (value instanceof Date ? value.toISOString() : (value ?? null));

async function context(): Promise<{ titles: Partial<TitlesSettings>; vars: VariableContext }> {
	const [stored, features, site] = await Promise.all([
		getPluginSetting<Partial<TitlesSettings>>(PLUGIN_ID, "config:titles").catch(() => undefined),
		getPluginSetting<Record<string, boolean>>(PLUGIN_ID, "config:features").catch(() => undefined),
		getSiteSettings().catch(() => ({}) as Awaited<ReturnType<typeof getSiteSettings>>),
	]);
	// Templates are not applied while the titles feature is switched off.
	const titles = features?.meta === false ? undefined : stored;
	return {
		titles: titles ?? {},
		vars: {
			siteTitle: site.title ?? "",
			tagline: site.tagline ?? "",
			siteUrl: site.url ?? "",
			separator: site.seo?.titleSeparator?.trim() || "-",
			now: new Date(),
			locale: "en",
		},
	};
}

/**
 * What the collection's title and description templates give for an entry.
 *
 *   const fromTemplate = await seoTemplates(entry, { collection: "posts" });
 *   const seo = getSeoMeta(entry, { siteTitle, defaultDescription: fromTemplate.description ?? undefined });
 *   <title>{fromTemplate.title ?? seo.title}</title>
 */
export async function seoTemplates(entry: TemplateEntry, options: TemplateOptions): Promise<TemplateResult> {
	const { titles, vars } = await context();
	const template: Partial<CollectionTitles> = titles.collections?.[options.collection] ?? {};
	const seo = entry.seo ?? (entry.data.seo as TemplateEntry["seo"]) ?? null;
	const wantsTitle = Boolean(template.title) && !seo?.title;
	const wantsDescription = Boolean(template.description) && !seo?.description;
	if (!wantsTitle && !wantsDescription) return { title: null, description: null };
	vars.entry = {
		title: firstString(entry.data, ["title", "name"]),
		excerpt: firstString(entry.data, ["excerpt", "description", "summary", "intro"]),
		content: outlineContent(entry.data).text,
		url: options.url ?? "",
		image: imageUrl(["featured_image", "featuredImage", "image", "cover", "hero_image"].map((field) => entry.data[field]).find(Boolean)),
		author: options.author ?? "",
		publishedAt: iso(entry.publishedAt),
		updatedAt: iso(entry.updatedAt),
		categories: [],
		tags: [],
		fields: entry.data,
	};
	return {
		title: wantsTitle ? renderTemplate(template.title!, vars) || null : null,
		description: wantsDescription ? renderTemplate(template.description!, vars) || null : null,
	};
}

/** The home page title and description set under Titles & meta → Home; null where none is set. */
export async function homeSeo(): Promise<TemplateResult> {
	const { titles, vars } = await context();
	return {
		title: titles.homeTitle ? renderTemplate(titles.homeTitle, vars) || null : null,
		description: titles.homeDescription ? renderTemplate(titles.homeDescription, vars) || null : null,
	};
}

/** The anchor id for a heading, as used by the `TableOfContents` component. */
export function headingId(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+|-+$/g, "") || "section"
	);
}

export interface TocItem {
	id: string;
	text: string;
	level: number;
}

/** The headings of a rich-text field, with unique anchor ids. */
export function tableOfContents(content: unknown, options: { minLevel?: number; maxLevel?: number } = {}): TocItem[] {
	const { minLevel = 2, maxLevel = 3 } = options;
	const used = new Map<string, number>();
	return outlineContent({ content })
		.headings.filter((heading) => heading.level >= minLevel && heading.level <= maxLevel)
		.map((heading) => {
			const base = headingId(heading.text);
			const seen = used.get(base) ?? 0;
			used.set(base, seen + 1);
			return { id: seen ? `${base}-${seen + 1}` : base, text: heading.text, level: heading.level };
		});
}
