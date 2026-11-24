/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Structured data (JSON-LD).
 *
 * Three sources, printed in this order: the site-wide nodes (publisher, website, breadcrumbs, local
 * business), the schemas an editor added to the entry, and the automatic rules of the entry's
 * collection. Nothing prints while the output is switched off under Output, an entry's own schemas
 * included; the panel shows them as switched off.
 *
 * EmDash prints one node of its own under the id `primary` (a WebSite, or a BlogPosting on article
 * pages) and the first contribution of an id wins, so the WebSite node here takes that id on
 * non-article pages and an entry's article schema takes it on article pages.
 */
import { formBlock, type FieldSpec, type FormSpec, mediaLink, readForm } from "../../admin/forms.js";
import { defineSection } from "../../core/settings.js";
import { VARIABLE_HELP, type VariableContext, renderTemplate } from "../../core/variables.js";
import { type Action, type ActResult, type Block, type Contribution, type Ctx, type EntryView, type Env, type HeadState, type Module, type PageState, type PageTab, all, fail, isRecord, ok, store, str, note } from "../../kit.js";
import { type SiteIdentity, identityOf, variablesFor } from "../meta.js";
import { HOURS, OUTPUT, type OutputSettings, type Site, breadcrumbNode, isHome, localForm, localNode, localSection, outputSection, publisherForm, publisherId, publisherNode, publisherSection, siteOf, websiteId, websiteNode } from "./site.js";
import { missingRequired } from "./required.js";
import { type BuildContext, type SchemaType, TYPES, type Values, reader, typeOf } from "./types.js";
import { CONTEXT, type Node, absoluteUrl, prune } from "./util.js";

// ── Stored data ─────────────────────────────────────────────────

/** One schema an editor added to an entry. */
interface Stored {
	collection: string;
	entryId: string;
	entryKey: string;
	type: string;
	values: Values;
	createdAt: string;
	updatedAt: string;
}

/** One automatic rule: a type, the collection it covers, and its field mapping. */
interface Rule {
	id: string;
	type: string;
	collection: string;
	values: Values;
}

const MAX_PER_ENTRY = 20;
const MAX_RULES = 50;
/** Longest value of a multiline field (pasted JSON-LD, long lists). */
const MAX_LONG_TEXT = 60000;

const rulesSection = defineSection<{ rules: Rule[] }>("schemaRules", { rules: [] }, (value) => ({
	rules: value.rules.filter((rule): rule is Rule => isRecord(rule) && typeof rule.id === "string" && typeof rule.collection === "string" && typeOf(rule.type) !== undefined && isRecord(rule.values)).slice(0, MAX_RULES),
}));

const schemas = (ctx: Ctx) => store<Stored>(ctx, "schemas");
const keyOf = (collection: string, id: string) => `${collection}:${id}`;
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

async function entrySchemas(ctx: Ctx, collection: string, id: string): Promise<Array<{ id: string; data: Stored }>> {
	const found = await all(schemas(ctx), { entryKey: keyOf(collection, id) }, MAX_PER_ENTRY);
	return found.filter((item) => typeOf(item.data.type) && isRecord(item.data.values)).sort((a, b) => (a.data.createdAt < b.data.createdAt ? -1 : a.data.createdAt > b.data.createdAt ? 1 : 0));
}

// ── Building nodes ──────────────────────────────────────────────

/** Variables are rendered line by line, so list fields keep their lines. */
function renderText(value: string, vars: VariableContext): string {
	if (!value.includes("%%")) return value;
	return value
		.split(/\r?\n/)
		.map((line) => (line.includes("%%") ? renderTemplate(line, vars) : line))
		.join("\n");
}

function nodesOf(type: SchemaType, values: Values, context: BuildContext, vars: VariableContext): Node[] {
	const merged: Values = { ...type.defaults, ...values };
	const rendered: Values = {};
	for (const [key, value] of Object.entries(merged)) rendered[key] = typeof value === "string" && !type.raw ? renderText(value, vars) : value;
	const built = type.build(reader(rendered, context), context);
	if (!built) return [];
	const list = Array.isArray(built) ? built : [built];
	// Pasted JSON-LD is printed as it was entered.
	if (type.raw) return list;
	return list.map(prune).filter((node): node is Node => node !== null).map((node) => ({ "@context": CONTEXT, ...node }));
}

interface Scope {
	site: Site;
	identity: SiteIdentity;
	output: OutputSettings;
	publisherName: string;
}

function buildContext(scope: Scope, pageUrl: string, publishedAt: string, vars: VariableContext): BuildContext {
	const { site, identity, output } = scope;
	const logo = absoluteUrl(identity.logo, site.home);
	const linked = output.enabled && output.publisher && Boolean(site.home);
	return {
		siteUrl: site.home,
		siteName: site.name,
		pageUrl,
		publisher: linked ? { "@id": publisherId(site) } : { "@type": "Organization", name: scope.publisherName || site.name, url: site.home, logo: logo ? { "@type": "ImageObject", url: logo } : undefined },
		website: output.enabled && output.website && site.home ? { "@id": websiteId(site) } : null,
		publishedAt,
		render: (template) => renderTemplate(template, vars),
	};
}

const templatesOf = (items: Array<{ values: Values }>) => items.flatMap((item) => Object.values(item.values).filter((value): value is string => typeof value === "string" && value.includes("%%")));

async function scopeOf(ctx: Ctx, env: Env, output?: OutputSettings): Promise<Scope> {
	const [identity, settings, publisher] = await Promise.all([identityOf(ctx, env), output ?? outputSection.load(ctx.settings), publisherSection.load(ctx.settings)]);
	return { site: siteOf(ctx.site), identity, output: settings, publisherName: publisher.name };
}

async function contributions(ctx: Ctx, env: Env, state: HeadState): Promise<Contribution[]> {
	const page = state.page;
	const ref = page.content;
	const output = await outputSection.load(ctx.settings);
	if (!output.enabled) return [];
	const manual = ref ? (await entrySchemas(ctx, ref.collection, ref.id)).map((item) => item.data) : [];

	const scope = await scopeOf(ctx, env, output);
	const { site, identity } = scope;
	const pageUrl = page.canonical || page.url;
	const out: Contribution[] = [];
	const add = (id: string, node: Node | null) => {
		if (node) out.push({ kind: "jsonld", id, graph: { "@context": CONTEXT, ...node } });
	};

	{
		const publisher = await publisherSection.load(ctx.settings);
		if (output.publisher) add("seodash:publisher", publisherNode(publisher, site, identity));
		// On article pages `primary` belongs to the article.
		if (output.website) add(page.pageType === "article" ? "seodash:website" : "primary", websiteNode(output, publisher, site, identity));
		if (output.breadcrumbs) add("seodash:breadcrumbs", breadcrumbNode(page, site));
		const local = await localSection.load(ctx.settings);
		if (local.enabled && (local.everyPage || isHome(page))) add("seodash:local", localNode(local, site, identity));
	}

	if (!ref) return out;
	const rules = (await rulesSection.load(ctx.settings)).rules.filter((rule) => rule.collection === ref.collection && !manual.some((item) => item.type === rule.type));
	const items = printable([...manual, ...rules]);
	if (!items.length) return out;

	const entry = await state.entry();
	const vars = await variablesFor(ctx, identity, entry, templatesOf(items), page.articleMeta?.author ?? "");
	if (vars.entry) {
		vars.entry.url = pageUrl;
		vars.entry.image = page.image || entry?.image || "";
		vars.entry.publishedAt = page.articleMeta?.publishedTime || vars.entry.publishedAt;
		vars.entry.updatedAt = page.articleMeta?.modifiedTime || vars.entry.updatedAt;
	}
	const context = buildContext(scope, pageUrl, vars.entry?.publishedAt ?? "", vars);
	let primaryTaken = false;
	let position = 0;
	let faq: Node | null = null;
	for (const item of items) {
		const type = typeOf(item.type);
		if (!type) continue;
		let nodes: Node[];
		try {
			nodes = nodesOf(type, item.values, context, vars);
		} catch (error) {
			ctx.log.warn("SEOdash structured data skipped", { type: item.type, error: String(error) });
			continue;
		}
		if (!nodes.length) continue;
		// Several FAQ items on one entry print as one FAQPage: a page may have only one.
		if (type.id === "faq") {
			if (faq && Array.isArray(faq.mainEntity)) {
				faq.mainEntity = [...faq.mainEntity, ...((nodes[0]?.mainEntity as unknown[]) ?? [])];
				continue;
			}
			faq = nodes[0] ?? null;
		}
		position += 1;
		const replacesCore = type.article === true && page.pageType === "article" && !primaryTaken;
		if (replacesCore) primaryTaken = true;
		out.push({ kind: "jsonld", id: replacesCore ? "primary" : `seodash:entry:${position}`, graph: nodes.length === 1 ? (nodes[0] as Node) : nodes });
	}
	return out;
}

/**
 * What prints, in order: the first item of each type (all FAQ items, which merge into one FAQPage,
 * and every custom item). A second Product or Event would describe the page twice.
 */
function printable<T extends { type: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	return items.filter((item) => item.type === "faq" || item.type === "custom" || (!seen.has(item.type) && Boolean(seen.add(item.type))));
}

// ── Forms shared by the panel and the rules ─────────────────────

const VARIABLES_NOTE = `Any field can use variables: ${VARIABLE_HELP.map((v) => `%%${v.name}%%`).join(", ")}. Empty fields are left out.`;

function readValues(type: SchemaType, submitted: Record<string, unknown>, current: Values): Values {
	const base: Values = { ...type.defaults };
	for (const field of type.fields) if (field.key in current) base[field.key] = current[field.key] as string | boolean;
	const out = readForm<Values>({ id: "", fields: type.fields }, submitted, base);
	for (const field of type.fields) {
		const value = submitted[field.key];
		if (field.kind === "text" && field.multiline && typeof value === "string") out[field.key] = value.slice(0, MAX_LONG_TEXT).trim();
	}
	return out;
}

function summaryOf(nodes: Node[]): string {
	const node = nodes[0];
	if (!node) return "—";
	for (const key of ["name", "headline", "title"]) if (typeof node[key] === "string") return (node[key] as string).slice(0, 80);
	if (isRecord(node.itemReviewed) && typeof node.itemReviewed.name === "string") return node.itemReviewed.name.slice(0, 80);
	if (Array.isArray(node.mainEntity)) return `${node.mainEntity.length} ${node.mainEntity.length === 1 ? "question" : "questions"}`;
	const type = Array.isArray(node["@type"]) ? node["@type"].join(", ") : node["@type"];
	return typeof type === "string" ? type : "—";
}

const typeMenu = (actionId: string, label: string) => ({ type: "menu" as const, action_id: actionId, label, items: TYPES.map((type) => ({ label: type.label, value: type.id })) });

const removeButton = (actionId: string, value: string, what: string) => ({
	type: "button" as const,
	action_id: actionId,
	label: "Remove",
	value,
	style: "danger" as const,
	confirm: { title: `Remove this ${what}?`, text: "It will no longer be printed.", confirm: "Remove", deny: "Cancel", style: "danger" as const },
});

const cancelButton = (actionId: string): Block => ({ type: "actions", elements: [{ type: "button", action_id: actionId, label: "Cancel" }] });

// ── Entry panel ─────────────────────────────────────────────────

/**
 * Which schema the editor has open. The host keeps no state between interactions and a panel
 * section is not told which action led to its render, so the selection is kept for a short while.
 */
interface Editing {
	id?: string;
	type?: string;
	/** Values that were rejected, so the editor does not lose them. */
	draft?: Values;
	at: number;
}

const EDITING_TTL = 30 * 60 * 1000;
const editingKey = (entry: EntryView) => `schema:editing:${keyOf(entry.collection, entry.id)}`;

async function editingOf(ctx: Ctx, entry: EntryView): Promise<Editing | null> {
	try {
		const marker = await ctx.kv.get<Editing>(editingKey(entry));
		return marker && typeof marker.at === "number" && Date.now() - marker.at < EDITING_TTL ? marker : null;
	} catch {
		return null;
	}
}

const setEditing = (ctx: Ctx, entry: EntryView, marker: Omit<Editing, "at"> | null) => (marker ? ctx.kv.set(editingKey(entry), { ...marker, at: Date.now() }) : ctx.kv.delete(editingKey(entry)).then(() => undefined));

const OFF: Block = { type: "banner", description: "Structured data is switched off. Nothing here is printed until it is switched on under Structured data → Output." };

async function renderPanel(ctx: Ctx, env: Env, view: EntryView): Promise<Block[]> {
	const [records, scope, rules, marker] = await Promise.all([entrySchemas(ctx, view.collection, view.id), scopeOf(ctx, env), rulesSection.load(ctx.settings), editingOf(ctx, view)]);
	const covering = rules.rules.filter((rule) => rule.collection === view.collection);
	const vars = await variablesFor(ctx, scope.identity, view, templatesOf([...records.map((record) => record.data), ...covering]));
	const context = buildContext(scope, view.url ?? "", view.publishedAt ?? "", vars);
	const build = (type: SchemaType, values: Values): Node[] => {
		try {
			return nodesOf(type, values, context, vars);
		} catch {
			return [];
		}
	};

	const rows: Array<Record<string, unknown>> = [];
	const shown = new Set(printable(records.map((record) => record.data)));
	const extra: string[] = [];
	const gaps: string[] = [];
	const gap = (type: SchemaType, nodes: Node[]) => {
		const missing = missingRequired(type.id, nodes[0]);
		if (missing.length) gaps.push(`${type.label} lacks what Google requires for a rich result: ${missing.join(", ")}.`);
	};
	for (const record of records) {
		const type = typeOf(record.data.type);
		if (!type) continue;
		const nodes = build(type, record.data.values);
		const duplicate = !shown.has(record.data);
		if (duplicate && !extra.includes(type.label)) extra.push(type.label);
		else gap(type, nodes);
		rows.push({
			type: type.label,
			summary: summaryOf(nodes),
			status: duplicate ? "Not printed" : !scope.output.enabled ? "Switched off" : nodes.length ? "Printed" : "Incomplete",
			edit: { type: "button", action_id: "schema:edit", label: "Edit", value: record.id },
			remove: removeButton("schema:remove", record.id, "structured data"),
		});
	}
	const ruleShown = new Set(printable(covering));
	for (const rule of covering) {
		const type = typeOf(rule.type);
		if (!type || !ruleShown.has(rule)) continue;
		const replaced = records.some((record) => record.data.type === rule.type);
		const nodes = build(type, rule.values);
		if (!replaced) gap(type, nodes);
		rows.push({ type: type.label, summary: summaryOf(nodes), status: replaced ? "Replaced by this entry's own" : !scope.output.enabled ? "Automatic, switched off" : nodes.length ? "Automatic" : "Automatic, incomplete" });
	}

	const blocks: Block[] = [
		...(scope.output.enabled ? [] : [OFF]),
		...extra.map((label): Block => ({ type: "banner", variant: "alert", description: `Only the first ${label} is printed. A page should describe one ${label}; remove the others or edit the first.` })),
		...gaps.map((description): Block => ({ type: "banner", variant: "alert", description })),
		{
			type: "table",
			page_action_id: "schema:list",
			columns: [
				{ key: "type", label: "Type" },
				{ key: "summary", label: "Describes" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "edit", label: "", format: "element" },
				{ key: "remove", label: "", format: "element" },
			],
			rows,
			empty_text: "No structured data for this entry yet.",
		},
	];
	if (records.length < MAX_PER_ENTRY) blocks.push({ type: "actions", elements: [typeMenu("schema:add", "Add structured data")] });

	const editing = marker?.id ? records.find((record) => record.id === marker.id) : undefined;
	const type = typeOf(editing ? editing.data.type : marker && !marker.id ? marker.type : undefined);
	if (type) {
		const saved = editing?.data.values ?? {};
		const values: Values = { ...type.defaults, ...saved, ...marker?.draft };
		blocks.push({ type: "divider" }, { type: "section", text: editing ? `Edit: ${type.label}` : `New: ${type.label}` });
		if (type.note) blocks.push(note(type.note));
		blocks.push(formBlock({ id: editing ? `schema:save/${editing.id}` : `schema:save/new/${type.id}`, fields: type.fields }, values), cancelButton("schema:cancel"), note(VARIABLES_NOTE));
		const preview = editing ? build(type, saved) : [];
		if (preview.length) blocks.push(note("What is printed now:"), { type: "code", code: JSON.stringify(preview.length === 1 ? preview[0] : preview, null, 2).slice(0, 6000), language: "jsonc" });
	}
	return blocks;
}

async function actPanel(ctx: Ctx, action: Action, view: EntryView): Promise<ActResult | null> {
	const collection = schemas(ctx);
	const own = async (id: unknown) => {
		if (typeof id !== "string" || !id) return null;
		const record = await collection.get(id);
		return record && record.entryKey === keyOf(view.collection, view.id) ? record : null;
	};
	if (action.id === "list") return {};
	if (action.id === "add") {
		const type = typeOf(action.value);
		if (!type) return fail("Choose a type of structured data.");
		await setEditing(ctx, view, { type: type.id });
		return {};
	}
	if (action.id === "edit") {
		if (!(await own(action.value))) return fail("That structured data no longer exists.");
		await setEditing(ctx, view, { id: str(action.value) });
		return {};
	}
	if (action.id === "cancel") {
		await setEditing(ctx, view, null);
		return {};
	}
	if (action.id === "remove") {
		if (!(await own(action.value))) return fail("That structured data no longer exists.");
		await collection.delete(str(action.value));
		const marker = await editingOf(ctx, view);
		if (marker?.id === action.value) await setEditing(ctx, view, null);
		return ok("Removed");
	}
	if (action.id.startsWith("save/") && action.values) {
		const target = action.id.slice("save/".length);
		const existing = target.startsWith("new/") ? null : await own(target);
		const type = typeOf(existing ? existing.type : target.startsWith("new/") ? target.slice("new/".length) : undefined);
		if (!type) return fail("That structured data no longer exists.");
		const values = readValues(type, action.values, existing?.values ?? {});
		const problem = type.check?.(values) ?? null;
		if (problem) {
			await setEditing(ctx, view, { ...(existing ? { id: target } : { type: type.id }), draft: values });
			return fail(problem);
		}
		const now = new Date().toISOString();
		if (existing) {
			await collection.put(target, { ...existing, values, updatedAt: now });
		} else {
			const others = await entrySchemas(ctx, view.collection, view.id);
			if (others.length >= MAX_PER_ENTRY) return fail(`An entry can have up to ${MAX_PER_ENTRY} schemas.`);
			// Schemas print in the order they were added, so a new one always sorts last.
			const last = others[others.length - 1]?.data.createdAt ?? "";
			const createdAt = last >= now ? new Date(new Date(last).getTime() + 1).toISOString() : now;
			await collection.put(`${keyOf(view.collection, view.id)}:${newId()}`, { collection: view.collection, entryId: view.id, entryKey: keyOf(view.collection, view.id), type: type.id, values, createdAt, updatedAt: now });
		}
		await setEditing(ctx, view, null);
		return ok("Saved");
	}
	return null;
}

// ── Automatic rules ─────────────────────────────────────────────

/** The collections whose entries are pages of the site. */
async function visibleCollections(ctx: Ctx): Promise<Array<{ slug: string; label: string }>> {
	const collections = (await ctx.schema?.listCollections()) ?? [];
	return collections.filter((collection) => !collection.hidden && (collection as { routable?: boolean }).routable !== false).map((collection) => ({ slug: collection.slug, label: collection.label }));
}

const ruleForm = (id: string, type: SchemaType, collections: Array<{ slug: string; label: string }>): FormSpec => ({
	id,
	fields: [{ kind: "select", key: "ruleCollection", label: "Applies to every entry of", options: collections.map((collection) => ({ label: collection.label, value: collection.slug })) } satisfies FieldSpec, ...type.fields],
});

const RULE_ACTIONS = ["rule-add", "rule-edit", "rule-remove", "rule-cancel", "rules"];
const isRuleAction = (id: string) => RULE_ACTIONS.includes(id) || id.startsWith("rule-save/");

async function renderRules(ctx: Ctx, state: PageState): Promise<Block[]> {
	const [output, stored, collections] = await Promise.all([outputSection.load(ctx.settings), rulesSection.load(ctx.settings), visibleCollections(ctx)]);
	const rules = stored.rules;
	const blocks: Block[] = [];
	if (!output.enabled) blocks.push({ type: "banner", description: "Structured data is switched off, so rules are not printed yet. Switch it on under Output." });
	blocks.push(note("A rule prints one type of structured data on every entry of a collection, filled from its values. An entry's own structured data of that type wins."));
	if (!collections.length) return [...blocks, { type: "empty", title: "No collections found", size: "sm" }];

	const labelOf = (slug: string) => collections.find((collection) => collection.slug === slug)?.label ?? slug;
	blocks.push({
		type: "table",
		page_action_id: "schema:rules",
		columns: [
			{ key: "type", label: "Type" },
			{ key: "collection", label: "Collection" },
			{ key: "edit", label: "", format: "element" },
			{ key: "remove", label: "", format: "element" },
		],
		rows: rules.map((rule) => ({ type: typeOf(rule.type)?.label ?? rule.type, collection: labelOf(rule.collection), edit: { type: "button", action_id: "schema:rule-edit", label: "Edit", value: rule.id }, remove: removeButton("schema:rule-remove", rule.id, "rule") })),
		empty_text: "No rules yet.",
	});
	if (rules.length < MAX_RULES) blocks.push({ type: "actions", elements: [typeMenu("schema:rule-add", "Add rule")] });

	// The action that led here says which form to show; nothing is kept between interactions.
	const action = state.action?.module === "schema" ? state.action : undefined;
	let type: SchemaType | undefined;
	let target = "";
	let values: Values = {};
	let collection = collections[0]?.slug ?? "";
	if (action?.id === "rule-add") {
		type = typeOf(action.value);
		target = `new/${type?.id ?? ""}`;
	} else if (action?.id === "rule-edit") {
		const rule = rules.find((candidate) => candidate.id === action.value);
		type = typeOf(rule?.type);
		if (rule) [target, values, collection] = [rule.id, rule.values, rule.collection];
	} else if (action?.id.startsWith("rule-save/") && action.values) {
		// A submission that was rejected is shown again as it was sent.
		target = action.id.slice("rule-save/".length);
		const rule = rules.find((candidate) => candidate.id === target);
		const candidate = typeOf(rule ? rule.type : target.startsWith("new/") ? target.slice("new/".length) : undefined);
		if (candidate) {
			const submitted = readValues(candidate, action.values, rule?.values ?? {});
			if (candidate.check?.(submitted)) [type, values, collection] = [candidate, submitted, str(action.values.ruleCollection) || rule?.collection || collection];
		}
	}
	if (type) {
		blocks.push({ type: "divider" }, { type: "section", text: target.startsWith("new/") ? `New rule: ${type.label}` : `Edit rule: ${type.label}` });
		if (type.note) blocks.push(note(type.note));
		blocks.push(formBlock(ruleForm(`schema:rule-save/${target}`, type, collections), { ...type.defaults, ...values, ruleCollection: collection }), cancelButton("schema:rule-cancel"), {
			type: "context",
			text: `${VARIABLES_NOTE} Use %%_cf_field%% to read any field of the entry.`,
		});
	}
	return blocks;
}

async function actRules(ctx: Ctx, action: Action): Promise<ActResult | null> {
	if (action.id === "rule-add" || action.id === "rule-edit" || action.id === "rule-cancel" || action.id === "rules") return {};
	const stored = await rulesSection.load(ctx.settings);
	if (action.id === "rule-remove") {
		const rules = stored.rules.filter((rule) => rule.id !== action.value);
		if (rules.length === stored.rules.length) return fail("That rule no longer exists.");
		await rulesSection.save(ctx.settings, { rules });
		return ok("Removed");
	}
	if (action.id.startsWith("rule-save/") && action.values) {
		const target = action.id.slice("rule-save/".length);
		const existing = stored.rules.find((rule) => rule.id === target);
		const type = typeOf(existing ? existing.type : target.startsWith("new/") ? target.slice("new/".length) : undefined);
		if (!type) return fail("That rule no longer exists.");
		const collections = await visibleCollections(ctx);
		const collection = str(action.values.ruleCollection) || existing?.collection || "";
		if (!collections.some((candidate) => candidate.slug === collection)) return fail("Choose a collection.");
		const values = readValues(type, action.values, existing?.values ?? {});
		const problem = type.check?.(values) ?? null;
		if (problem) return fail(problem);
		const twin = type.id !== "custom" && stored.rules.some((rule) => rule.id !== existing?.id && rule.type === type.id && rule.collection === collection);
		if (twin) return fail(`${collections.find((candidate) => candidate.slug === collection)?.label ?? collection} already has an automatic ${type.label} rule. Edit that one instead.`);
		if (existing) {
			await rulesSection.save(ctx.settings, { rules: stored.rules.map((rule) => (rule.id === target ? { ...rule, collection, values } : rule)) });
		} else {
			if (stored.rules.length >= MAX_RULES) return fail(`There can be up to ${MAX_RULES} rules.`);
			await rulesSection.save(ctx.settings, { rules: [...stored.rules, { id: newId(), type: type.id, collection, values }] });
		}
		return ok("Saved");
	}
	return null;
}

// ── The module ──────────────────────────────────────────────────

/**
 * `owns` tells the admin shell which of this module's tabs an action belongs to, so the page stays
 * on that tab after the action.
 */
type OwnedTab = PageTab & { owns(action: Action): boolean };
const tab = (definition: OwnedTab): PageTab => definition;

/** Per invocation: the entries, by collection, that have structured data of their own (see `prepare`). */
const PREPARED = new WeakMap<Ctx, Map<string, Set<string>>>();

export const schema: Module = {
	id: "schema",
	panelActions: ["list", "add", "edit", "cancel", "remove", "save"],
	feature: { label: "Structured data", description: "Schema.org data for entries, the publisher and a local business." },
	capabilities: ["content:read", "schema:read", "taxonomies:read"],
	storage: { schemas: { indexes: ["collection", "entryKey"] } },
	tabs: [
		tab({
			page: "/schema",
			label: "Output",
			order: 10,
			owns: (action) => action.id === "output",
			async render(ctx) {
				const output = await outputSection.load(ctx.settings);
				return [
					...(output.enabled ? [] : [OFF]),
					formBlock(OUTPUT, output),
					note("To search engines the site search URL is a template: keep {search_term_string} where the search words go."),
				];
			},
		}),
		tab({
			page: "/schema",
			label: "Publisher",
			order: 20,
			owns: (action) => action.id === "publisher",
			async render(ctx, env) {
				const [settings, identity] = await Promise.all([publisherSection.load(ctx.settings), identityOf(ctx, env)]);
				return [
					note("Who is behind the site. Search engines use this for the site's name, logo and contact details."),
					formBlock(publisherForm(ctx.site.name), settings),
					...mediaLink(ctx.site.url),
					{
						type: "fields",
						fields: [
							{ label: "Logo", value: settings.logo ? "Set here" : identity.logo ? "The site logo" : "Not set" },
							{ label: "Profiles", value: identity.profiles.length ? identity.profiles.join(", ") : "None" },
						],
					},
					note("The site's social profiles are added automatically. Manage them under Social."),
				];
			},
		}),
		tab({
			page: "/schema",
			label: "Local business",
			order: 30,
			owns: (action) => action.id === "local" || action.id === "hours",
			async render(ctx) {
				const settings = await localSection.load(ctx.settings);
				return [
					note("For a business with a physical location or a service area: its address, contact details and opening hours."),
					formBlock(localForm(ctx.site.name), settings),
					...mediaLink(ctx.site.url),
					{ type: "accordion", label: "Opening hours", default_open: settings.enabled, blocks: [note("Times in 24-hour form, e.g. 09:00. Use the second pair for a business that closes in the middle of the day."), formBlock(HOURS, settings)] },
				];
			},
		}),
		tab({
			page: "/schema",
			label: "Automatic",
			order: 40,
			owns: (action) => isRuleAction(action.id),
			render: (ctx, _env, state) => renderRules(ctx, state),
		}),
	],
	panel: [{ id: "schema", label: "Structured data", order: 40, render: renderPanel }],

	async act(ctx, _env, action, entry) {
		if (entry) return actPanel(ctx, action, entry);
		const settings = ctx.settings;
		if (action.values) {
			if (action.id === "output") {
				await outputSection.save(settings, readForm(OUTPUT, action.values, await outputSection.load(settings)));
				return ok("Saved");
			}
			if (action.id === "publisher") {
				await publisherSection.save(settings, readForm(publisherForm(ctx.site.name), action.values, await publisherSection.load(settings)));
				return ok("Saved");
			}
			if (action.id === "local" || action.id === "hours") {
				await localSection.save(settings, readForm(action.id === "local" ? localForm(ctx.site.name) : HOURS, action.values, await localSection.load(settings)));
				return ok("Saved");
			}
		}
		return isRuleAction(action.id) ? actRules(ctx, action) : null;
	},

	async head(ctx, env, state) {
		try {
			return await contributions(ctx, env, state);
		} catch (error) {
			ctx.log.error("SEOdash structured data failed", { error: String(error) });
			return [];
		}
	},

	on: {
		async delete(ctx, _env, event) {
			const found = await all(schemas(ctx), { entryKey: keyOf(event.collection, event.id) }, MAX_PER_ENTRY * 5);
			if (found.length) await schemas(ctx).deleteMany(found.map((item) => item.id));
			await ctx.kv.delete(`schema:editing:${keyOf(event.collection, event.id)}`);
		},
	},

	/** One or two queries tell which entries of the collection have structured data of their own. */
	async prepare(ctx, _env, collection) {
		const known = PREPARED.get(ctx) ?? new Map<string, Set<string>>();
		PREPARED.set(ctx, known);
		if (known.has(collection)) return;
		const keys = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 3; page++) {
			const found = await schemas(ctx).query({ where: { collection }, limit: 100, ...(cursor ? { cursor } : {}) });
			for (const item of found.items) keys.add((item.data as { entryKey?: string }).entryKey ?? "");
			cursor = found.hasMore ? found.cursor : undefined;
			if (!cursor) break;
		}
		// More than three pages: each entry is counted on its own instead.
		if (!cursor) known.set(collection, keys);
	},

	async facts(ctx, _env, entry) {
		if (!(await outputSection.load(ctx.settings)).enabled) return {};
		const prepared = PREPARED.get(ctx)?.get(entry.collection);
		if (prepared ? prepared.has(keyOf(entry.collection, entry.id)) : (await schemas(ctx).count({ entryKey: keyOf(entry.collection, entry.id) })) > 0) return { hasSchema: true };
		const rules = await rulesSection.load(ctx.settings);
		return rules.rules.some((rule) => rule.collection === entry.collection) ? { hasSchema: true } : {};
	},
};
