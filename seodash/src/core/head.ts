/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Builds the head tags SEOdash adds to a public page.
 *
 * EmDash prints its own description, canonical, Open Graph, X and verification tags from the page,
 * the entry's SEO fields and the site settings. Plugin tags come first and the first of each kind wins, so every tag
 * returned here replaces the site's. That is why a tag is only returned when a value was entered
 * in SEOdash for it; with nothing configured this returns nothing and the page is unchanged.
 */
import type { Contribution, CoreSeo, PageInput } from "../kit.js";
import type { EntryRecord } from "./entry.js";
import { absoluteUrl } from "./text.js";
import { renderTemplate, type VariableContext } from "./variables.js";

export interface CollectionTitles {
	/** Title template for entries of this collection. Empty: keep the site's own title. */
	title: string;
	/** Description template. Empty: keep the entry's own description. */
	description: string;
	noindex: boolean;
	nofollow: boolean;
}

export interface TitlesSettings {
	/** Value of `%%sep%%` where EmDash's own title separator cannot be read. */
	separator: string;
	homeTitle: string;
	homeDescription: string;
	/** Site-wide robots directives, added to every page. */
	nofollow: boolean;
	noimageindex: boolean;
	nosnippet: boolean;
	/** Per-collection templates, keyed by collection slug. */
	collections: Record<string, CollectionTitles>;
}

export interface SocialSettings {
	ogEnabled: boolean;
	twitterEnabled: boolean;
	twitterCard: "summary" | "summary_large_image";
	/** Print `twitter:site` and `article:publisher` from the site's social profiles. */
	creditProfiles: boolean;
	fbAppId: string;
	fbPages: string;
	/** Profiles EmDash's own settings have no field for. */
	pinterest: string;
	extra: string;
}

export interface AdvancedSettings {
	pinterest: string;
	yandex: string;
	baidu: string;
	dublinCore: boolean;
}

/** Values EmDash's site settings own; SEOdash's copies are used only where those cannot be read. */
export interface Identity {
	separator: string;
	/** Fallback sharing image SEOdash should print itself ("" when EmDash already does). */
	defaultImage: string;
	twitter: string;
	facebook: string;
	/** Verification codes SEOdash should print itself ("" when EmDash already does). */
	google: string;
	bing: string;
}

export interface HeadInput {
	page: PageInput;
	titles: TitlesSettings;
	social: SocialSettings;
	advanced: AdvancedSettings;
	identity: Identity;
	site: { name: string; url: string; locale?: string };
	vars: VariableContext;
	record?: EntryRecord | null;
	seo?: CoreSeo | null;
}

const ROBOTS_ORDER = ["noindex", "nofollow", "noimageindex", "nosnippet"];

/** `@name` from an X/Twitter profile URL or handle. */
export function twitterHandle(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	const fromUrl = /^(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/@?([A-Za-z0-9_]{1,15})/i.exec(trimmed);
	const name = fromUrl ? fromUrl[1] : /^@?([A-Za-z0-9_]{1,15})$/.exec(trimmed)?.[1];
	return name ? `@${name}` : "";
}

/**
 * The robots value with SEOdash's directives added to the page's own, or null when SEOdash adds
 * nothing (the site's tag then stays as it is).
 */
export function robotsContent(existing: string | null | undefined, add: string[]): string | null {
	const current = (existing ?? "")
		.split(",")
		.map((directive) => directive.trim().toLowerCase())
		.filter(Boolean);
	const wanted = add.filter((directive) => !current.includes(directive));
	if (!wanted.length) return null;
	// A negative directive replaces its positive form ("index" → "noindex").
	const kept = current.filter((directive) => !wanted.includes(`no${directive}`));
	const merged = [...kept, ...wanted];
	const rank = (directive: string) => {
		const index = ROBOTS_ORDER.indexOf(directive);
		return index === -1 ? ROBOTS_ORDER.length : index;
	};
	return merged.sort((a, b) => rank(a) - rank(b)).join(", ");
}

/** An absolute http(s) address, or "" when there is no address to resolve against: never a relative one. */
function httpUrl(url: string, base: string): string {
	const out = absoluteUrl(url, base);
	return /^https?:\/\//i.test(out) ? out : "";
}

export function buildHead(input: HeadInput): Contribution[] {
	const { page, titles, social, advanced, identity, site, vars, record, seo } = input;
	const out: Contribution[] = [];
	const siteUrl = site.url || page.siteUrl || "";
	const isHome = page.path === "/" || page.path === "";
	const collection = page.content ? titles.collections[page.content.collection] : undefined;

	// Templates fill in only where the entry's own SEO fields are empty.
	const titleTemplate = isHome ? titles.homeTitle : (collection?.title ?? "");
	const descriptionTemplate = isHome ? titles.homeDescription : (collection?.description ?? "");
	const templateTitle = !seo?.title && titleTemplate ? renderTemplate(titleTemplate, vars) : "";
	const templateDescription = !seo?.description && descriptionTemplate ? renderTemplate(descriptionTemplate, vars) : "";

	if (templateDescription) out.push({ kind: "meta", name: "description", content: templateDescription });

	const directives: string[] = [];
	if (collection?.noindex) directives.push("noindex");
	if (titles.nofollow || collection?.nofollow || record?.nofollow) directives.push("nofollow");
	if (titles.noimageindex || record?.noimageindex) directives.push("noimageindex");
	if (titles.nosnippet || record?.nosnippet) directives.push("nosnippet");
	const robots = robotsContent(page.seo?.robots, directives);
	if (robots) out.push({ kind: "meta", name: "robots", content: robots });

	const ogTitle = record?.ogTitle || templateTitle;
	const ogDescription = record?.ogDescription || templateDescription;
	const pageImage = page.seo?.ogImage || page.image;
	const ogImage = httpUrl(record?.ogImage || (pageImage ? "" : identity.defaultImage), siteUrl);

	if (social.ogEnabled) {
		if (ogTitle) out.push({ kind: "property", property: "og:title", content: ogTitle });
		if (ogDescription) out.push({ kind: "property", property: "og:description", content: ogDescription });
		if (ogImage) out.push({ kind: "property", property: "og:image", content: ogImage });
		if (social.fbAppId) out.push({ kind: "property", property: "fb:app_id", content: social.fbAppId });
		if (social.fbPages) out.push({ kind: "property", property: "fb:pages", content: social.fbPages });
		if (social.creditProfiles && page.pageType === "article" && /^https?:\/\//.test(identity.facebook)) {
			out.push({ kind: "property", property: "article:publisher", content: identity.facebook });
		}
	}

	if (social.twitterEnabled) {
		const twitterTitle = record?.twitterTitle || ogTitle;
		const twitterDescription = record?.twitterDescription || ogDescription;
		const twitterImage = httpUrl(record?.twitterImage ?? "", siteUrl) || ogImage;
		if (twitterTitle) out.push({ kind: "meta", name: "twitter:title", content: twitterTitle });
		if (twitterDescription) out.push({ kind: "meta", name: "twitter:description", content: twitterDescription });
		if (twitterImage) out.push({ kind: "meta", name: "twitter:image", content: twitterImage });
		// EmDash prints the large card whenever a page has an image; only the other choice needs a tag.
		if (social.twitterCard === "summary" && (twitterImage || pageImage)) {
			out.push({ kind: "meta", name: "twitter:card", content: "summary" });
		} else if (twitterImage && !pageImage) {
			out.push({ kind: "meta", name: "twitter:card", content: "summary_large_image" });
		}
		const handle = social.creditProfiles ? twitterHandle(identity.twitter) : "";
		if (handle) {
			out.push({ kind: "meta", name: "twitter:site", content: handle });
			out.push({ kind: "meta", name: "twitter:creator", content: handle });
		}
	}

	const verification: Array<[string, string]> = [
		["google-site-verification", identity.google],
		["msvalidate.01", identity.bing],
		["p:domain_verify", advanced.pinterest],
		["yandex-verification", advanced.yandex],
		["baidu-site-verification", advanced.baidu],
	];
	for (const [name, content] of verification) {
		if (content.trim()) out.push({ kind: "meta", name, content: content.trim() });
	}

	if (advanced.dublinCore) {
		const dcTitle = ogTitle || page.seo?.ogTitle || page.pageTitle || page.title;
		const dcDescription = ogDescription || page.description;
		if (dcTitle) out.push({ kind: "meta", name: "dc.title", content: dcTitle });
		if (dcDescription) out.push({ kind: "meta", name: "dc.description", content: dcDescription });
		out.push({ kind: "meta", name: "dc.relation", content: page.canonical || page.url });
		if (siteUrl) out.push({ kind: "meta", name: "dc.source", content: siteUrl });
		const language = page.locale || site.locale;
		if (language) out.push({ kind: "meta", name: "dc.language", content: language });
	}

	return out;
}
