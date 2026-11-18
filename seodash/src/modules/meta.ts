/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Titles & meta, social tags and verification: the settings pages and the head tags they produce.
 *
 * EmDash already owns the title separator, default sharing image, Google and Bing verification and
 * the site's main social profiles (Settings → SEO and Settings → Social). SEOdash reads those and
 * only asks for them itself where the host does not expose them (the marketplace sandbox).
 */
import { formBlock, type FormSpec, readForm, textField, toggleField } from "../admin/forms.js";
import { type AdvancedSettings, buildHead, type CollectionTitles, type Identity, type SocialSettings, type TitlesSettings } from "../core/head.js";
import { defineSection, merge } from "../core/settings.js";
import { VARIABLE_HELP, type VariableContext, renderTemplate } from "../core/variables.js";
import { type Block, type CoreSite, type Ctx, type EntryView, type Env, type Module, ok, note } from "../kit.js";

export const DEFAULT_COLLECTION_TITLES: CollectionTitles = { title: "", description: "", noindex: false, nofollow: false };

export const titlesSection = defineSection<TitlesSettings>(
	"titles",
	{ separator: "-", homeTitle: "", homeDescription: "", nofollow: false, noimageindex: false, nosnippet: false, collections: {} },
	(titles) => {
		const collections: Record<string, CollectionTitles> = {};
		for (const [slug, value] of Object.entries(titles.collections)) collections[slug] = merge(DEFAULT_COLLECTION_TITLES, value);
		return { ...titles, collections };
	},
);

export const socialSection = defineSection<SocialSettings>("social", {
	ogEnabled: true,
	twitterEnabled: true,
	twitterCard: "summary_large_image",
	creditProfiles: false,
	fbAppId: "",
	fbPages: "",
	pinterest: "",
	extra: "",
});

export const advancedSection = defineSection<AdvancedSettings>("advanced", { pinterest: "", yandex: "", baidu: "", dublinCore: false });

/** SEOdash's own copy of what EmDash's site settings hold; used only where those cannot be read. */
interface Fallback {
	separator: string;
	defaultImage: string;
	google: string;
	bing: string;
	twitter: string;
	facebook: string;
	instagram: string;
	linkedin: string;
	youtube: string;
}
export const fallbackSection = defineSection<Fallback>("site", { separator: "-", defaultImage: "", google: "", bing: "", twitter: "", facebook: "", instagram: "", linkedin: "", youtube: "" });

export interface SiteIdentity extends Identity {
	tagline: string;
	logo: string;
	/** Every known profile URL of the site, for `sameAs`. */
	profiles: string[];
}

const profileUrl = (value: string, base: string) => {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return `${base}${trimmed.replace(/^@/, "")}`;
};

export async function identityOf(ctx: Ctx, env: Env, social?: SocialSettings): Promise<SiteIdentity> {
	const core = await env.core(ctx);
	const extras = social ?? (await socialSection.load(ctx.settings));
	const more = [extras.pinterest, ...extras.extra.split(/\r?\n/)].map((line) => line.trim()).filter((url) => /^https?:\/\//.test(url));
	if (core) {
		const p = core.profiles;
		const profiles = [
			profileUrl(p.facebook, "https://www.facebook.com/"),
			profileUrl(p.twitter, "https://x.com/"),
			profileUrl(p.instagram, "https://www.instagram.com/"),
			profileUrl(p.linkedin, "https://www.linkedin.com/company/"),
			profileUrl(p.youtube, "https://www.youtube.com/"),
			profileUrl(p.github, "https://github.com/"),
		].filter(Boolean);
		// EmDash prints the default image and the Google/Bing codes itself.
		return { separator: core.separator.trim() || "-", defaultImage: "", google: "", bing: "", twitter: p.twitter, facebook: profileUrl(p.facebook, "https://www.facebook.com/"), tagline: core.tagline, logo: core.logo, profiles: [...profiles, ...more] };
	}
	const own = await fallbackSection.load(ctx.settings);
	const profiles = [own.facebook, own.twitter, own.instagram, own.linkedin, own.youtube].filter((url) => /^https?:\/\//.test(url));
	return { separator: own.separator || "-", defaultImage: own.defaultImage, google: own.google, bing: own.bing, twitter: own.twitter, facebook: own.facebook, tagline: "", logo: "", profiles: [...profiles, ...more] };
}

async function termNames(ctx: Ctx, collection: string, id: string): Promise<{ categories: string[]; tags: string[] }> {
	const out = { categories: [] as string[], tags: [] as string[] };
	try {
		const terms = (await ctx.taxonomies?.getEntryTerms(collection, id)) ?? [];
		for (const term of terms as Array<{ label?: string; name?: string; taxonomy?: string }>) {
			const label = term.label ?? term.name ?? "";
			if (!label) continue;
			if (/tag/i.test(term.taxonomy ?? "")) out.tags.push(label);
			else out.categories.push(label);
		}
	} catch {
		// Taxonomies are optional context for templates.
	}
	return out;
}

const usesTerms = (...templates: string[]) => templates.some((template) => /%%\s*post_(category|tag)\s*%%/.test(template));

export async function variablesFor(ctx: Ctx, identity: SiteIdentity, entry: EntryView | null, templates: string[] = [], author = ""): Promise<VariableContext> {
	const vars: VariableContext = {
		siteTitle: ctx.site.name,
		tagline: identity.tagline,
		siteUrl: ctx.site.url,
		separator: identity.separator,
		now: new Date(),
		locale: ctx.site.locale || "en",
		targetKeywords: entry?.record.targetKeywords ?? "",
	};
	if (entry) {
		const terms = usesTerms(...templates) ? await termNames(ctx, entry.collection, entry.id) : { categories: [], tags: [] };
		vars.collectionLabel = entry.collectionLabel;
		vars.entry = {
			title: entry.title,
			excerpt: entry.excerpt,
			content: entry.outline.text,
			url: entry.url ?? "",
			image: entry.image,
			author,
			publishedAt: entry.publishedAt,
			updatedAt: entry.updatedAt,
			categories: terms.categories,
			tags: terms.tags,
			fields: entry.data,
		};
	}
	return vars;
}

export interface SearchAppearance {
	title: string;
	titleSource: "seo" | "template" | "entry";
	description: string;
	descriptionSource: "seo" | "template" | "excerpt" | "none";
	/** What the templates alone produce ("" when the collection has none). */
	templateTitle: string;
	templateDescription: string;
}

/** The title and description search engines get for an entry, and where each comes from. */
export async function searchAppearance(ctx: Ctx, env: Env, entry: EntryView, titles?: TitlesSettings): Promise<SearchAppearance> {
	const settings = titles ?? (await titlesSection.load(ctx.settings));
	const template = settings.collections[entry.collection];
	let templateTitle = "";
	let templateDescription = "";
	// Templates belong to the titles feature: switched off, they are not applied anywhere.
	const off = env.installed.some((module) => module.id === "meta") && !env.modules.some((module) => module.id === "meta");
	if (!off && (template?.title || template?.description)) {
		const vars = await variablesFor(ctx, await identityOf(ctx, env), entry, [template.title, template.description]);
		templateTitle = template?.title ? renderTemplate(template.title, vars) : "";
		templateDescription = template?.description ? renderTemplate(template.description, vars) : "";
	}
	const seoTitle = entry.seo?.title?.trim() ?? "";
	const seoDescription = entry.seo?.description?.trim() ?? "";
	return {
		title: seoTitle || templateTitle || entry.title,
		titleSource: seoTitle ? "seo" : templateTitle ? "template" : "entry",
		description: seoDescription || templateDescription || entry.excerpt,
		descriptionSource: seoDescription ? "seo" : templateDescription ? "template" : entry.excerpt ? "excerpt" : "none",
		templateTitle,
		templateDescription,
	};
}

// ── Forms ───────────────────────────────────────────────────────

/** The variables a template can use, folded away until needed. */
const VARIABLES: Block = {
	type: "accordion",
	label: "Variables",
	blocks: [{ type: "table", page_action_id: "meta:variables", columns: [{ key: "name", label: "Variable" }, { key: "label", label: "Gives" }], rows: VARIABLE_HELP.map((v) => ({ name: `%%${v.name}%%`, label: v.label })) }],
};

const HOME: FormSpec = {
	id: "meta:home",
	fields: [
		textField("homeTitle", "Home page title", { placeholder: "%%sitetitle%% %%sep%% %%tagline%%" }),
		textField("homeDescription", "Home page description", { multiline: true }),
	],
};

const ROBOTS: FormSpec = {
	id: "meta:robots",
	fields: [
		toggleField("nofollow", "Ask search engines not to follow links (nofollow)"),
		toggleField("noimageindex", "Ask search engines not to index images (noimageindex)"),
		toggleField("nosnippet", "Ask search engines not to show text snippets (nosnippet)"),
	],
};

const collectionForm = (slug: string): FormSpec => ({
	id: `meta:collection/${slug}`,
	fields: [
		textField("title", "Title template", { placeholder: "%%post_title%% %%sep%% %%sitetitle%%" }),
		textField("description", "Description template", { placeholder: "%%post_excerpt%%", multiline: true }),
		toggleField("noindex", "Hide these entries from search engines (noindex)", { description: "EmDash's sitemap still lists them. To leave an entry out of the sitemap too, hide it in its own SEO settings." }),
		toggleField("nofollow", "Ask search engines not to follow their links (nofollow)"),
	],
});

const SHARING: FormSpec = {
	id: "meta:sharing",
	fields: [
		toggleField("ogEnabled", "Add to the Open Graph tags", { description: "EmDash prints basic sharing tags either way. These add what is set per entry, such as its sharing title and image." }),
		toggleField("twitterEnabled", "Add to the X (Twitter) card tags"),
		{
			kind: "select",
			key: "twitterCard",
			label: "X card size",
			options: [
				{ label: "Large image", value: "summary_large_image" },
				{ label: "Small image", value: "summary" },
			],
		},
		toggleField("creditProfiles", "Credit the site's profiles on shared links", { description: "Adds the X handle (twitter:site) and the Facebook page (article:publisher). Leave off if the site's templates already print them." }),
		textField("fbAppId", "Facebook app ID"),
		textField("fbPages", "Facebook page ID (link ownership)"),
	],
};

const PROFILES: FormSpec = {
	id: "meta:profiles",
	fields: [
		textField("pinterest", "Pinterest URL"),
		textField("extra", "Other profile URLs (one per line)", { multiline: true }),
	],
};

const VERIFICATION: FormSpec = {
	id: "meta:verification",
	fields: [
		textField("pinterest", "Pinterest"),
		textField("yandex", "Yandex"),
		textField("baidu", "Baidu"),
		toggleField("dublinCore", "Dublin Core tags", { description: "Extra title, description and language tags read by some libraries and archives." }),
	],
};

/** Shown only where EmDash's own site settings cannot be read. */
const FALLBACK: FormSpec = {
	id: "meta:site",
	fields: [
		textField("separator", "Title separator", { placeholder: "-" }),
		textField("defaultImage", "Default sharing image URL"),
		textField("google", "Google Search Console verification code"),
		textField("bing", "Bing Webmaster Tools verification code"),
		textField("twitter", "X (Twitter) profile URL"),
		textField("facebook", "Facebook page URL"),
		textField("instagram", "Instagram URL"),
		textField("linkedin", "LinkedIn URL"),
		textField("youtube", "YouTube URL"),
	],
};

const set = (value: string) => (value.trim() ? value.trim() : "Not set");

function coreFields(core: CoreSite, which: "titles" | "social" | "verification"): Block[] {
	const fields =
		which === "titles"
			? [
					{ label: "Title separator", value: set(core.separator) },
					{ label: "Tagline", value: set(core.tagline) },
				]
			: which === "social"
				? [
						{ label: "Default sharing image", value: core.defaultImage ? "Set" : "Not set" },
						{ label: "X (Twitter)", value: set(core.profiles.twitter) },
						{ label: "Facebook", value: set(core.profiles.facebook) },
						{ label: "Instagram", value: set(core.profiles.instagram) },
						{ label: "LinkedIn", value: set(core.profiles.linkedin) },
						{ label: "YouTube", value: set(core.profiles.youtube) },
					]
				: [
						{ label: "Google Search Console", value: core.googleVerification ? "Set" : "Not set" },
						{ label: "Bing Webmaster Tools", value: core.bingVerification ? "Set" : "Not set" },
					];
	return [{ type: "fields", fields }, note("These come from EmDash's own settings (Settings → SEO and Settings → Social). Change them there.")];
}

/** The collections whose entries are pages of the site. */
async function visibleCollections(ctx: Ctx) {
	const collections = (await ctx.schema?.listCollections()) ?? [];
	return collections.filter((collection) => !collection.hidden && (collection as { routable?: boolean }).routable !== false);
}

export const meta: Module = {
	id: "meta",
	feature: { label: "Titles and social tags", description: "Title and description templates, robots directives and social sharing tags." },
	capabilities: ["content:read", "schema:read", "taxonomies:read"],
	tabs: [
		{
			page: "/titles",
			label: "Collections",
			order: 10,
			async render(ctx) {
				const titles = await titlesSection.load(ctx.settings);
				const collections = await visibleCollections(ctx);
				const blocks: Block[] = [note("Templates fill in only where an entry's own SEO title or description is empty, so nothing written is replaced. Leave one empty to keep what the site prints today.")];
				if (!collections.length) blocks.push({ type: "empty", title: "No collections found", size: "sm" });
				for (const collection of collections) {
					const set = { ...DEFAULT_COLLECTION_TITLES, ...titles.collections[collection.slug] };
					blocks.push({ type: "accordion", label: set.title || set.description ? `${collection.label} · Custom` : collection.label, blocks: [formBlock(collectionForm(collection.slug), set)] });
				}
				blocks.push(VARIABLES);
				return blocks;
			},
		},
		{
			page: "/titles",
			label: "Home",
			owns: (action) => action.id === "home",
			order: 20,
			async render(ctx, env) {
				const core = await env.core(ctx);
				return [
					note("Used for the home page when its entry has no SEO title or description of its own."),
					formBlock(HOME, await titlesSection.load(ctx.settings)),
					VARIABLES,
					...(core ? coreFields(core, "titles") : []),
				];
			},
		},
		{
			page: "/titles",
			label: "Robots",
			owns: (action) => action.id === "robots",
			order: 30,
			async render(ctx, env) {
				const core = await env.core(ctx);
				const blocks: Block[] = [];
				if (core?.staging) blocks.push({ type: "banner", variant: "alert", title: "The site is in staging", description: "EmDash is asking search engines not to index any page. Go live under Settings when the site is ready." });
				blocks.push(note("These apply to every page. To hide the whole site use EmDash's staging mode; to hide one entry use its SEO fields."), formBlock(ROBOTS, await titlesSection.load(ctx.settings)));
				return blocks;
			},
		},
		{
			page: "/social",
			label: "Sharing",
			order: 10,
			async render(ctx) {
				return [note("How pages look when shared. Each entry can override its sharing title, description and image."), formBlock(SHARING, await socialSection.load(ctx.settings))];
			},
		},
		{
			page: "/social",
			label: "Profiles",
			owns: (action) => action.id === "profiles",
			order: 20,
			async render(ctx, env) {
				const core = await env.core(ctx);
				return [...(core ? coreFields(core, "social") : []), note("Profiles listed here are added to the site's structured data."), formBlock(PROFILES, await socialSection.load(ctx.settings))];
			},
		},
		{
			page: "/settings",
			label: "Verification",
			order: 60,
			async render(ctx, env) {
				const core = await env.core(ctx);
				return [
					...(core ? coreFields(core, "verification") : []),
					note("Paste the code each service gives you (the content value of its meta tag)."),
					formBlock(VERIFICATION, await advancedSection.load(ctx.settings)),
					...(core ? [] : [{ type: "divider" } as Block, note("Site details") as Block, formBlock(FALLBACK, await fallbackSection.load(ctx.settings))]),
				];
			},
		},
	],

	async act(ctx, _env, action) {
		const values = action.values;
		if (!values) return null;
		const settings = ctx.settings;
		if (action.id === "home" || action.id === "robots") {
			const spec = action.id === "home" ? HOME : ROBOTS;
			await titlesSection.save(settings, readForm(spec, values, await titlesSection.load(settings)));
			return ok("Saved");
		}
		if (action.id.startsWith("collection/")) {
			const slug = action.id.slice("collection/".length);
			const known = (await ctx.schema?.listCollections()) ?? [];
			if (!known.some((collection) => collection.slug === slug)) return null;
			const titles = await titlesSection.load(settings);
			const current = { ...DEFAULT_COLLECTION_TITLES, ...titles.collections[slug] };
			titles.collections = { ...titles.collections, [slug]: readForm(collectionForm(slug), values, current) };
			await titlesSection.save(settings, titles);
			return ok("Saved");
		}
		if (action.id === "sharing" || action.id === "profiles") {
			await socialSection.save(settings, readForm(action.id === "sharing" ? SHARING : PROFILES, values, await socialSection.load(settings)));
			return ok("Saved");
		}
		if (action.id === "verification") {
			await advancedSection.save(settings, readForm(VERIFICATION, values, await advancedSection.load(settings)));
			return ok("Saved");
		}
		if (action.id === "site") {
			await fallbackSection.save(settings, readForm(FALLBACK, values, await fallbackSection.load(settings)));
			return ok("Saved");
		}
		return null;
	},

	async head(ctx, env, state) {
		const [titles, social, advanced] = await Promise.all([titlesSection.load(ctx.settings), socialSection.load(ctx.settings), advancedSection.load(ctx.settings)]);
		const page = state.page;
		const isHome = page.path === "/" || page.path === "";
		const collection = page.content ? titles.collections[page.content.collection] : undefined;
		const templates = isHome ? [titles.homeTitle, titles.homeDescription] : [collection?.title ?? "", collection?.description ?? ""];
		// The entry is only read when a template needs its values.
		const entry = page.content && templates.some(Boolean) ? await state.entry() : null;
		const identity = await identityOf(ctx, env, social);
		const vars = await variablesFor(ctx, identity, entry, templates, page.articleMeta?.author ?? "");
		if (entry && vars.entry) {
			vars.entry.url = page.canonical || page.url;
			vars.entry.image = page.image || entry.image;
		}
		return buildHead({ page, titles, social, advanced, identity, site: { name: ctx.site.name, url: ctx.site.url, locale: ctx.site.locale }, vars, record: state.record, seo: entry?.seo ?? null });
	},
};
