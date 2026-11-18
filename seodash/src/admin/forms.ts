/**
 * Settings forms: a field list describes one form, which is rendered as an EmDash Block Kit form
 * and read back from its submission. Each field names a key of a flat settings object.
 */
import type { Block, FormField } from "@emdash-cms/blocks";
import type { Ctx } from "../kit.js";

interface Shared {
	key: string;
	label: string;
	/** One line of explanation, shown above the form (EmDash does not show it beside the field). */
	description?: string;
	/** Show the field only while another field of the form has this value. */
	when?: { field: string; eq: unknown };
}

export type FieldSpec =
	| (Shared & { kind: "text"; placeholder?: string; multiline?: boolean })
	| (Shared & { kind: "number"; min?: number; max?: number })
	| (Shared & { kind: "toggle" })
	| (Shared & { kind: "select"; options: Array<{ label: string; value: string }> })
	| (Shared & { kind: "date" })
	/** Collection slugs, ticked from a list and kept as a comma-separated string. None ticked means all. `withCollections` fills the list. */
	| (Shared & { kind: "collections"; options?: Array<{ label: string; value: string }> })
	/** An image, by address (or media ID where EmDash's own field holds one). */
	| (Shared & { kind: "image" })
	/** Write-only: shows whether a value is saved; an empty submission keeps it. Not part of the values object. */
	| (Shared & { kind: "secret"; placeholder?: string });

export interface FormSpec {
	/** Identifies the form in a submission (`action_id` of its Save button). */
	id: string;
	fields: FieldSpec[];
	submitLabel?: string;
}

type Values = Record<string, unknown>;

/** Longest value a text field accepts. */
const MAX_TEXT = 5000;

function element(field: FieldSpec, value: unknown, savedSecrets: Record<string, boolean>): FormField {
	const condition = field.when ? { condition: { field: field.when.field, eq: field.when.eq } } : {};
	const base = { action_id: field.key, label: field.label, ...condition, ...(field.description ? { description: field.description } : {}) };
	switch (field.kind) {
		case "toggle":
			return { type: "toggle", ...base, initial_value: value === true };
		case "select": {
			const current = typeof value === "string" && field.options.some((option) => option.value === value) ? value : field.options[0]?.value;
			return { type: "select", ...base, options: field.options, ...(current !== undefined ? { initial_value: current } : {}) };
		}
		case "number":
			return {
				type: "number_input",
				...base,
				...(typeof value === "number" ? { initial_value: value } : {}),
				...(field.min !== undefined ? { min: field.min } : {}),
				...(field.max !== undefined ? { max: field.max } : {}),
			};
		case "collections": {
			const saved = typeof value === "string" ? value.split(",").map((slug) => slug.trim()).filter(Boolean) : [];
			// A saved slug the site no longer lists stays ticked, so saving does not drop it.
			const options = [...(field.options ?? []), ...saved.filter((slug) => !field.options?.some((option) => option.value === slug)).map((slug) => ({ label: slug, value: slug }))];
			return { type: "checkbox", ...base, options, initial_value: saved };
		}
		case "date":
			return { type: "date_input", ...base, ...(typeof value === "string" && value ? { initial_value: value } : {}) };
		case "image":
			// The host does not render its media picker inside plugin forms, so an image is an address.
			return { type: "text_input", ...base, placeholder: "Image address, or copy one from the media library", initial_value: typeof value === "string" ? value : "" };
		case "secret":
			return { type: "secret_input", ...base, ...(field.placeholder ? { placeholder: field.placeholder } : {}), has_value: savedSecrets[field.key] === true };
		default:
			return {
				type: "text_input",
				...base,
				...(field.placeholder ? { placeholder: field.placeholder } : {}),
				...(field.multiline ? { multiline: true } : {}),
				initial_value: typeof value === "string" ? value : typeof value === "number" ? String(value) : "",
			};
	}
}

/** Fills the list of each `collections` field with the site's collections that have pages. */
export async function withCollections(ctx: Ctx, spec: FormSpec): Promise<FormSpec> {
	const list = ((await ctx.schema?.listCollections()) ?? []).filter((collection) => !collection.hidden && (collection as { routable?: boolean }).routable !== false);
	const options = list.map((collection) => ({ label: collection.label, value: collection.slug }));
	return { ...spec, fields: spec.fields.map((field) => (field.kind === "collections" ? { ...field, options } : field)) };
}

/** `secrets` says which secret fields already hold a value. */
export function formBlock(spec: FormSpec, source: object, savedSecrets: Record<string, boolean> = {}): Block {
	const values = source as Values;
	return {
		type: "form",
		block_id: spec.id,
		fields: spec.fields.map((field) => element(field, values[field.key], savedSecrets)),
		submit: { label: spec.submitLabel ?? "Save", action_id: spec.id },
	};
}

function readField(field: FieldSpec, value: unknown, present: boolean, current: unknown): unknown {
	switch (field.kind) {
		case "toggle":
			return typeof value === "boolean" ? value : current;
		case "select":
			return typeof value === "string" && field.options.some((option) => option.value === value) ? value : current;
		case "number": {
			const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
			if (!Number.isFinite(parsed)) return current;
			return Math.min(field.max ?? Number.MAX_SAFE_INTEGER, Math.max(field.min ?? -Number.MAX_SAFE_INTEGER, parsed));
		}
		case "secret":
			return current;
		case "collections":
			return Array.isArray(value) ? value.filter((slug) => typeof slug === "string").join(",") : current;
		default:
			if (typeof value === "string") return value.slice(0, MAX_TEXT).trim();
			// An emptied text field can arrive as null.
			if ((value === null || value === undefined) && present) return "";
			return current;
	}
}

/**
 * The submitted values of a form's fields, by key. A field missing from the submission or of the
 * wrong type keeps its current value; a select only accepts one of its options. Secret fields are
 * left out: read them with `readSecrets`.
 */
export function readForm<T extends object>(spec: FormSpec, submitted: Values, current: T): T {
	const out: Values = { ...(current as Values) };
	for (const field of spec.fields) {
		if (field.kind === "secret") continue;
		out[field.key] = readField(field, submitted[field.key], field.key in submitted, out[field.key]);
	}
	return out as T;
}

/** Newly entered secret values, by field key. Fields left empty are absent (keep the saved value). */
export function readSecrets(spec: FormSpec, submitted: Values): Record<string, string> {
	const out: Record<string, string> = {};
	for (const field of spec.fields) {
		const value = submitted[field.key];
		if (field.kind === "secret" && typeof value === "string" && value.trim()) out[field.key] = value.trim();
	}
	return out;
}
