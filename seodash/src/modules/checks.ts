/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Publishing checks: optional rules that stop an entry from going live until its basics are in
 * place. Off by default. Uses EmDash's publication policy hook, so the rule holds wherever the
 * entry is published from (editor, API, scheduler, agents).
 */
import { formBlock, type FormSpec, readForm, withCollections, toggleField } from "../admin/forms.js";
import { defineSection } from "../core/settings.js";
import { outlineContent } from "../core/text.js";
import { type Module, ok, note } from "../kit.js";
import { searchAppearance } from "./meta.js";

export interface ChecksSettings {
	requireDescription: boolean;
	requireAlt: boolean;
	/** Collection slugs the rules apply to, comma-separated. Empty: every collection with SEO fields. */
	collections: string;
}

export const checksSection = defineSection<ChecksSettings>("checks", { requireDescription: false, requireAlt: false, collections: "" });

const FORM: FormSpec = {
	id: "checks:settings",
	fields: [
		toggleField("requireDescription", "Require a search description", { description: "An entry needs an SEO description, an excerpt or a description template before it can be published." }),
		toggleField("requireAlt", "Require alt text on images", { description: "Every image needs alt text before publishing. This applies to entries hidden from search engines too, because alt text is for accessibility." }),
		{ kind: "collections", key: "collections", label: "Only these collections", description: "None ticked means every collection." },
	],
};

export const checks: Module = {
	id: "checks",
	feature: { label: "Publishing rules", description: "Optional rules an entry must meet before it can be published." },
	capabilities: ["content:read", "schema:read"],
	tabs: [
		{
			page: "/settings",
			label: "Publishing",
			order: 45,
			async render(ctx) {
				return [note("Rules an entry must meet before it is published, however it is published, scheduled entries included."), formBlock(await withCollections(ctx, FORM), await checksSection.load(ctx.settings))];
			},
		},
	],
	async act(ctx, _env, action) {
		if (action.id !== "settings" || !action.values) return null;
		await checksSection.save(ctx.settings, readForm(FORM, action.values, await checksSection.load(ctx.settings)));
		return ok("Saved");
	},
	async beforePublish(ctx, env, event) {
		const settings = await checksSection.load(ctx.settings);
		if (!settings.requireDescription && !settings.requireAlt) return null;
		const wanted = settings.collections.split(",").map((slug) => slug.trim()).filter(Boolean);
		if (wanted.length && !wanted.includes(event.collection)) return null;
		// The event carries the draft that is about to go live; the saved entry supplies the rest.
		const draft = (event.content.data as Record<string, unknown> | undefined) ?? event.content;
		if (settings.requireAlt) {
			const missing = outlineContent(draft).images.filter((image) => !image.alt.trim()).length;
			if (missing) return `${missing} image${missing === 1 ? " has" : "s have"} no alt text. Add alt text before publishing.`;
		}
		if (settings.requireDescription && event.id) {
			const saved = await env.entry(ctx, event.collection, event.id);
			// A description is for search results; an entry hidden from search engines has no use for one.
			if (saved?.seo && !saved.seo.noIndex) {
				const excerpt = ["excerpt", "description", "summary", "intro"].some((field) => typeof draft[field] === "string" && (draft[field] as string).trim());
				const appearance = await searchAppearance(ctx, env, saved);
				if (!excerpt && appearance.descriptionSource === "none") return "Add a search description (in the SEO section of the editor) or an excerpt before publishing.";
			}
		}
		return null;
	},
};
