/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/** Settings export and import. */
import { formBlock, type FormSpec } from "../admin/forms.js";
import { type Block, type Ctx, type Module, fail, isRecord, ok } from "../kit.js";

const IMPORT: FormSpec = { id: "tools:import", submitLabel: "Import", fields: [{ kind: "text", key: "json", label: "Settings to import (JSON)", multiline: true }] };

const SECTION_KEY = /^config:[a-zA-Z][a-zA-Z0-9-]{0,40}$/;

/** Every settings section as one JSON document. API keys and cached files are not included. */
export async function exportSettings(ctx: Ctx): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const { key, value } of await ctx.settings.list("config:")) {
		if (SECTION_KEY.test(key) && isRecord(value)) out[key] = value;
	}
	return out;
}

export const tools: Module = {
	id: "tools",
	tabs: [
		{
			page: "/settings",
			label: "Import and export",
			order: 90,
			async render(ctx) {
				const blocks: Block[] = [
					{ type: "context", text: "Copy these settings to move them to another site. API keys are not included." },
					{ type: "code", language: "jsonc", code: JSON.stringify(await exportSettings(ctx), null, 2) },
					{ type: "divider" },
					formBlock(IMPORT, { json: "" }),
					{ type: "context", text: "Importing replaces the sections found in the pasted settings and leaves the others as they are." },
				];
				return blocks;
			},
		},
	],
	async act(ctx, _env, action) {
		if (action.id !== "import" || !action.values) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(action.values.json ?? ""));
		} catch {
			return fail("That is not valid JSON.");
		}
		if (!isRecord(parsed)) return fail("Paste the settings exactly as they were exported.");
		const sections = Object.entries(parsed).filter(([key, value]) => SECTION_KEY.test(key) && isRecord(value));
		if (!sections.length) return fail("No settings were found in that text.");
		for (const [key, value] of sections) await ctx.settings.set(key, value);
		return ok(`Imported ${sections.length} section${sections.length === 1 ? "" : "s"}`);
	},
};
