/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Content analysis: checks one entry's search title, description, content and links against
 * common on-page SEO guidance and its target keywords. Pure: no I/O.
 */
import type { ContentOutline } from "./text.js";
import { wordCount } from "./text.js";

/** `info` is shown and never counted: every finding on an entry hidden from search engines. */
export type Severity = "good" | "info" | "low" | "medium" | "high";

export interface Check {
	id: string;
	label: string;
	severity: Severity;
	detail: string;
}

export interface AnalysisInput {
	title: string;
	/** True when the title was written for search (SEO field or template), not just the entry title. */
	titleIsCustom: boolean;
	description: string;
	descriptionIsCustom: boolean;
	slug: string;
	url: string | null;
	siteUrl: string;
	canonical: string | null;
	noIndex: boolean;
	nofollow: boolean;
	hasImage: boolean;
	hasSchema: boolean;
	updatedAt: string | null;
	keywords: string[];
	/** The entry's own title, shown as the page heading (H1) by most templates. */
	heading: string;
	outline: ContentOutline;
	now?: Date;
}

export interface Analysis {
	checks: Check[];
	/** 0–100, or null for an entry hidden from search engines, which is not scored. */
	score: number | null;
	words: number;
	keywordUse: Array<{ keyword: string; count: number; density: number }>;
}

export const NOT_SCORED = "Hidden from search engines, not scored";
export const TITLE_LIMIT = 60;
export const DESCRIPTION_LIMIT = 160;
const MIN_WORDS = 300;
const LONG_CONTENT = 900;
const WORDS_PER_SECTION = 300;

export function parseKeywords(value: string): string[] {
	return [...new Set(value.split(",").map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
}

const fold = (text: string) =>
	text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "");

/** Times `keyword` appears in `text` as whole words, ignoring case and accents. */
export function countKeyword(text: string, keyword: string): number {
	const needle = fold(keyword).trim();
	if (!needle) return 0;
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
	return (fold(text).match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu")) ?? []).length;
}

const has = (text: string, keywords: string[]) => keywords.filter((keyword) => countKeyword(text, keyword) > 0);
const list = (items: string[]) => items.map((item) => `"${item}"`).join(", ");

function isInternal(href: string, siteUrl: string): boolean {
	if (/^(#|mailto:|tel:)/i.test(href)) return false;
	if (href.startsWith("/") && !href.startsWith("//")) return true;
	try {
		return new URL(href).host === new URL(siteUrl).host;
	} catch {
		return false;
	}
}

export function analyze(input: AnalysisInput): Analysis {
	const { outline, keywords } = input;
	const checks: Check[] = [];
	const add = (id: string, label: string, severity: Severity, detail: string) => checks.push({ id, label, severity, detail });
	const words = wordCount(outline.text);
	const now = input.now ?? new Date();

	// Search title
	if (!input.title) add("title", "Search title", "high", "No title is set. Give the entry a title.");
	else if (!input.titleIsCustom) add("title", "Search title", "medium", "Using the entry title. Fill in SEO Title in the editor's SEO section to control how the page appears in results.");
	else if (input.title.length > TITLE_LIMIT) add("title", "Search title", "medium", `${input.title.length} characters. Shorten it: titles over ${TITLE_LIMIT} are usually cut off in results.`);
	else if (keywords.length && !has(input.title, keywords).length) add("title", "Search title", "medium", "None of the target keywords appear in the title. Work one in.");
	else add("title", "Search title", "good", keywords.length ? `Contains ${list(has(input.title, keywords))}.` : `${input.title.length} characters.`);

	// Description
	if (!input.description) add("description", "Description", "high", "No description is set, so search engines pick their own text. Fill in Meta Description in the editor's SEO section.");
	else if (!input.descriptionIsCustom) add("description", "Description", "low", "Using the entry excerpt. Fill in Meta Description in the editor's SEO section to control the snippet in results.");
	else if (input.description.length > DESCRIPTION_LIMIT) add("description", "Description", "medium", `${input.description.length} characters. Shorten it: descriptions over ${DESCRIPTION_LIMIT} are usually cut off.`);
	else if (keywords.length && !has(input.description, keywords).length) add("description", "Description", "medium", "None of the target keywords appear in the description. Work one in.");
	else add("description", "Description", "good", keywords.length ? `Contains ${list(has(input.description, keywords))}.` : `${input.description.length} characters.`);

	// Keywords in the address
	if (keywords.length) {
		const slugText = input.slug.replace(/[-_/]+/g, " ");
		const found = has(slugText, keywords);
		add("slug", "Keywords in the address", found.length ? "good" : "medium", found.length ? `The address contains ${list(found)}.` : "The page address contains none of the target keywords. Change the slug if the page is new.");
	}

	// Headings
	const h1 = outline.headings.filter((heading) => heading.level === 1);
	const subheadings = outline.headings.filter((heading) => heading.level >= 2);
	if (h1.length > 1) {
		add("h1", "Main heading", "high", `The content has ${h1.length} H1 headings. A page should have one main heading; use H2 and below for the rest.`);
	} else if (h1.length === 1) {
		// Page builders put the main heading in the content, so one H1 there is only worth a look.
		add("h1", "Main heading", "low", "The content has an H1 heading. If the page also shows the entry title as its main heading, change this one to H2.");
	} else if (keywords.length && input.heading && !has(input.heading, keywords).length) {
		add("h1", "Main heading", "medium", "None of the target keywords appear in the entry title. Work one in.");
	} else if (input.heading) {
		add("h1", "Main heading", "good", "One main heading: the entry title.");
	}
	if (keywords.length && subheadings.length) {
		const found = has(subheadings.map((heading) => heading.text).join(" \n "), keywords);
		add("subheadings", "Keywords in subheadings", found.length ? "good" : "low", found.length ? `Subheadings contain ${list(found)}.` : "No subheading contains a target keyword. Use one in an H2 or H3.");
	}
	let skipped = false;
	let previous = 1;
	for (const heading of outline.headings) {
		if (heading.level > previous + 1) skipped = true;
		previous = heading.level;
	}
	if (outline.headings.length) add("hierarchy", "Heading order", skipped ? "low" : "good", skipped ? "A heading level is skipped (for example H2 straight to H4). Use each level in turn." : "Headings follow in order.");

	// Content depth and structure
	if (words > 0 || outline.headings.length) {
		add("depth", "Content length", words < MIN_WORDS ? "medium" : "good", words < MIN_WORDS ? `${words} words. Aim for at least ${MIN_WORDS} to cover the topic in depth.` : `${words} words.`);
		const perSection = Math.round(words / (subheadings.length + 1));
		if (words >= LONG_CONTENT) {
			add(
				"structure",
				"Sections",
				perSection > WORDS_PER_SECTION ? "low" : "good",
				perSection > WORDS_PER_SECTION ? `Sections average ${perSection} words. Add subheadings to keep them under about ${WORDS_PER_SECTION}.` : `Sections average ${perSection} words.`,
			);
			if (!outline.images.length && !input.hasImage) add("media", "Images", "medium", `Long content (${words} words) without an image. Add relevant images.`);
		}
	}

	// Keyword use in the content
	const keywordUse = keywords.map((keyword) => {
		const count = countKeyword(outline.text, keyword);
		return { keyword, count, density: words ? Math.round((count * wordCount(keyword) * 1000) / words) / 10 : 0 };
	});
	if (keywords.length && words > 0) {
		const unused = keywordUse.filter((use) => use.count === 0).map((use) => use.keyword);
		add("keywords", "Keywords in content", unused.length ? "medium" : "good", unused.length ? `Not found in the content: ${list(unused)}.` : keywordUse.map((use) => `"${use.keyword}" ×${use.count} (${use.density}%)`).join(", "));
	}

	// Images
	if (outline.images.length) {
		const missing = outline.images.filter((image) => !image.alt.trim()).length;
		add("alt", "Image alt text", missing ? "high" : "good", missing ? `${missing} of ${outline.images.length} images have no alt text. Describe each one in its alt text.` : `All ${outline.images.length} images have alt text.`);
	}

	// Links
	const internal = outline.links.filter((link) => isInternal(link.href, input.siteUrl));
	const outbound = outline.links.filter((link) => /^https?:\/\//i.test(link.href) && !isInternal(link.href, input.siteUrl));
	if (words >= MIN_WORDS) {
		add("internal", "Internal links", internal.length ? "good" : "medium", internal.length ? `${internal.length} link${internal.length === 1 ? "" : "s"} to other pages of this site.` : "No links to other pages of this site. Link to related pages.");
		add("outbound", "Outbound links", outbound.length ? "good" : "low", outbound.length ? `${outbound.length} link${outbound.length === 1 ? "" : "s"} to other sites.` : "No links to other sites. Linking to sources can help readers.");
	}
	const nofollowed = outline.links.filter((link) => link.nofollow).length;
	if (nofollowed) add("nofollow", "Nofollow links", "low", `${nofollowed} link${nofollowed === 1 ? " is" : "s are"} marked nofollow.`);

	// Indexing
	// Hiding an entry is a choice, not a fault: it is pointed out and no more.
	if (input.noIndex) add("robots", "Search visibility", "info", "This entry is hidden from search engines.");
	else if (input.nofollow) add("robots", "Search visibility", "medium", "Search engines are asked not to follow this page's links. Change it under Robots if that is not intended.");
	else add("robots", "Search visibility", "good", "Search engines can index this page.");
	if (input.canonical && input.url) {
		const same = input.canonical.replace(/\/+$/, "") === input.url.replace(/\/+$/, "") || input.canonical.replace(/\/+$/, "") === input.url.replace(/^https?:\/\/[^/]+/, "").replace(/\/+$/, "");
		if (!same) add("canonical", "Canonical URL", "high", `Points to another address (${input.canonical}). Search engines will index that page instead. Clear Canonical URL in the SEO section unless that is intended.`);
	}

	// Sharing
	add("image", "Sharing image", input.hasImage ? "good" : "medium", input.hasImage ? "An image is set for social sharing." : "No image is set, so shared links show without a picture. Add one in the editor's SEO section or as a featured image.");
	if (!input.hasSchema) add("schema", "Structured data", "low", "No structured data is set. Add it under Structured data if a type fits the page.");

	// Freshness
	if (input.updatedAt && now.getTime() - new Date(input.updatedAt).getTime() > 365 * 86400 * 1000) {
		add("fresh", "Freshness", "medium", "Not updated in over a year. Review that it is still accurate.");
	}

	// Nothing needs fixing on an entry that search engines are told to skip: its findings are notes.
	if (input.noIndex) {
		for (const check of checks) if (check.severity !== "good") check.severity = "info";
		return { checks, score: null, words, keywordUse };
	}
	const weight: Record<Severity, number> = { good: 0, info: 0, low: 1, medium: 3, high: 6 };
	const lost = checks.reduce((sum, check) => sum + weight[check.severity], 0);
	const possible = checks.length * 6;
	const score = possible ? Math.max(0, Math.round(100 - (lost / possible) * 100 * 1.6)) : 100;
	return { checks, score, words, keywordUse };
}

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3, good: 4 };
export const bySeverity = (a: Check, b: Check) => ORDER[a.severity] - ORDER[b.severity];
export const SEVERITY_LABEL: Record<Severity, string> = { high: "Fix", medium: "Improve", low: "Consider", info: "Note", good: "Good" };
