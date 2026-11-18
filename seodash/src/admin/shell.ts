/**
 * The admin shell: turns the modules' tabs, panel sections and widgets into EmDash Block Kit
 * responses, and routes each form submit or button press to the module that owns it.
 */
import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { ActResult, Action, Ctx, EntryView, Env, Module, PagePath, PageState, PageTab } from "../kit.js";
import { type FeatureStatus, featureStatus } from "../core/features.js";
import { isRecord } from "../kit.js";
import { PAGES, PORT } from "../port.js";

/** The Overview page's address in the admin (a plugin page cannot be the bare "/"). */
export const OVERVIEW_PATH = "/overview";

/**
 * EmDash does not show a form field's description, so each one becomes a line above its form.
 * Walks into tabs, accordions and columns.
 */
function hints(blocks: Block[]): Block[] {
	return blocks.flatMap((block) => {
		const any = block as unknown as { type: string; blocks?: Block[]; panels?: Array<{ blocks: Block[] }>; columns?: Block[][]; fields?: Array<{ label: string; description?: string }> };
		if (any.blocks) any.blocks = hints(any.blocks);
		for (const panel of any.panels ?? []) panel.blocks = hints(panel.blocks);
		if (any.type === "columns") any.columns = any.columns!.map(hints);
		if (any.type !== "form") return [block];
		const lines: Block[] = [];
		for (const field of any.fields!) {
			if (field.description) lines.push({ type: "context", text: `${field.label}: ${field.description}` });
			delete field.description;
		}
		return [...lines, block];
	});
}

/** Sidebar pages for the admin config: those the chosen modules add a tab to. */
export function adminPages(modules: Module[]): Array<{ path: string; label: string; icon: string; group: string }> {
	const used = new Set(modules.flatMap((module) => (module.tabs ?? []).map((tab) => tab.page)));
	return PAGES.filter((page) => used.has(page.path)).map((page) => ({ ...page, path: page.path === "/" ? OVERVIEW_PATH : page.path, group: PORT.group }));
}

export function adminWidgets(modules: Module[]): Array<{ id: string; title: string; size: "full" | "half" | "third" }> {
	return modules.flatMap((module) => (module.widgets ?? []).map(({ id, title, size }) => ({ id, title, size })));
}

const normalize = (page: string): PagePath => {
	const trimmed = page.replace(/\/+$/, "") || "/";
	const path = (trimmed === OVERVIEW_PATH ? "/" : trimmed) as PagePath;
	return PAGES.some((known) => known.path === path) ? path : "/";
};

const SETTINGS_LINK: Block = { type: "actions", elements: [{ type: "link", label: "Open features", target: { kind: "plugin-page", path: "/settings" }, appearance: "secondary" }] };

/** Shown above a tab that stays visible while its feature is off, so what it needs can be entered. */
function offNotice(status: FeatureStatus): Block[] {
	const label = status.module.feature?.label ?? "This feature";
	if (status.missing) return [{ type: "banner", variant: "default", title: `${label} is off`, description: `Needs: ${status.missing}.` }];
	return [
		{ type: "banner", variant: "default", title: `${label} is off`, description: "Its settings are kept. Switch it on to use it again." },
		{ type: "actions", elements: [{ type: "button", label: "Switch on", action_id: "features:on", value: status.module.id, style: "primary" }] },
	];
}

async function renderPage(ctx: Ctx, env: Env, path: PagePath, state: PageState): Promise<Block[]> {
	const info = PAGES.find((page) => page.path === path) ?? PAGES[0]!;
	const header: Block = { type: "header", text: info.path === "/" ? PORT.group : info.label };
	const owners = env.installed.filter((module) => (module.tabs ?? []).some((tab) => tab.page === path));
	const off = new Map<string, FeatureStatus>();
	if (owners.some((module) => !env.modules.includes(module))) {
		for (const status of await featureStatus(ctx, env, owners)) if (!status.on) off.set(status.module.id, status);
	}
	const tabs = owners
		.flatMap((module) => (module.tabs ?? []).map((tab) => ({ tab, module: module.id })))
		.filter(({ tab, module }) => tab.page === path && (!off.has(module) || tab.setup))
		.sort((a, b) => a.tab.order - b.tab.order);
	if (tabs.length === 0) {
		if (!off.size) return [header, { type: "empty", title: "Nothing here yet", size: "sm" }];
		const blocks: Block[] = [header];
		for (const status of off.values()) blocks.push(...offNotice(status));
		return [...blocks, SETTINGS_LINK];
	}
	const panels = await Promise.all(
		tabs.map(async ({ tab, module }) => {
			try {
				const status = off.get(module);
				return { label: tab.label, blocks: [...(status ? offNotice(status) : []), ...(await tab.render(ctx, env, state))] };
			} catch (error) {
				ctx.log.error(`${PORT.name} tab failed`, { tab: tab.label, error: String(error) });
				return { label: tab.label, blocks: [{ type: "banner", variant: "error", title: "This section could not be loaded", description: "Reload the page. If it keeps happening, check the server log." } as Block] };
			}
		}),
	);
	if (panels.length === 1) return [header, ...panels[0]!.blocks];
	// Open the tab that was asked for, else stay on the one the action came from: the tab that
	// claims it, or the acting module's first tab.
	const action = state.action;
	const mine = (t: { tab: PageTab; module: string }) => t.module === action?.module;
	const focused = state.focus ? tabs.findIndex((t) => t.module === state.focus) : -1;
	const active = focused >= 0 ? focused : action ? Math.max(tabs.findIndex((t) => mine(t) && t.tab.owns?.(action) === true), tabs.findIndex(mine)) : -1;
	return [header, { type: "tab", panels, ...(active > 0 ? { default_tab: active } : {}) }];
}

interface Parsed {
	type: string;
	page: string;
	module: string;
	action: Action | null;
}

function parse(input: unknown): Parsed | null {
	if (!isRecord(input) || typeof input.type !== "string") return null;
	const page = typeof input.page === "string" ? input.page : "/";
	const raw = typeof input.action_id === "string" ? input.action_id : "";
	const split = raw.indexOf(":");
	if (!raw || split < 1) return { type: input.type, page, module: "", action: null };
	const action: Action = { id: raw.slice(split + 1) };
	if (input.type === "form_submit" && isRecord(input.values)) action.values = input.values;
	if (input.type === "block_action") action.value = input.value;
	return { type: input.type, page, module: raw.slice(0, split), action };
}

async function act(ctx: Ctx, env: Env, parsed: Parsed, entry: EntryView | null): Promise<ActResult | null> {
	if (!parsed.action) return null;
	// Off means off: a switched-off module does nothing, in the panel or on a page. The exception
	// is a module that still needs something (a key): it acts on admin pages so that can be saved.
	const on = env.modules.find((candidate) => candidate.id === parsed.module);
	let module = on;
	if (!module && !entry) {
		const off = env.installed.find((candidate) => candidate.id === parsed.module);
		const waiting = off?.tabs?.some((tab) => tab.setup) || Boolean(await off?.feature?.needs?.(ctx, env).catch(() => null));
		if (waiting) module = off;
	}
	if (!module?.act) return null;
	// The panel is open to authors: it may only send what the module declares for it, never an admin action.
	if (entry && !module.panelActions?.includes(parsed.action.id.split("/")[0]!)) return null;
	try {
		return await module.act(ctx, env, parsed.action, entry);
	} catch (error) {
		ctx.log.error(`${PORT.name} action failed`, { action: `${parsed.module}:${parsed.action.id}`, error: String(error) });
		return { toast: { type: "error", message: error instanceof Error && error.message ? error.message.slice(0, 200) : "Something went wrong." } };
	}
}

/**
 * After a refused save the form is given a new identity. EmDash keys blocks by `block_id` and each
 * control keeps its own state, so under the old id a switch the user turned on would still show on
 * although nothing was saved. Under a new id it shows the stored value again.
 */
function remount(blocks: Block[], parsed: Parsed | null, result: ActResult | null): Block[] {
	if (parsed?.type !== "form_submit" || result?.toast?.type !== "error") return blocks;
	const submitted = `${parsed.module}:${parsed.action?.id ?? ""}`;
	const suffix = `~${Date.now().toString(36)}`;
	const visit = (list: Block[]): void => {
		for (const block of list) {
			const any = block as unknown as { type: string; block_id?: string; submit?: { action_id?: string }; blocks?: Block[]; panels?: Array<{ blocks: Block[] }>; columns?: Block[][] };
			if (any.type === "form" && any.submit?.action_id === submitted) any.block_id = `${String(any.block_id ?? submitted).split("~")[0]}${suffix}`;
			if (any.blocks) visit(any.blocks);
			for (const panel of any.panels ?? []) visit(panel.blocks);
			if (any.type === "columns") for (const column of any.columns ?? []) visit(column);
		}
	};
	visit(blocks);
	return blocks;
}

/**
 * The outcome of an action, shown at the top of what was re-rendered. EmDash pins toasts to the top-right
 * corner, over the header's theme switch and user menu, so the shell shows the message inline instead.
 */
function notice(result: ActResult | null): Block[] {
	const toast = result?.toast;
	if (!toast?.message) return [];
	return [{ type: "banner", block_id: `notice-${toast.type}`, variant: toast.type === "error" ? "error" : "default", description: toast.message }];
}

/** Handles one interaction from an admin page or dashboard widget. `live` gives the environment as the features stand now. */
export async function handleAdmin(input: unknown, ctx: Ctx, live: () => Promise<Env>): Promise<BlockResponse> {
	const parsed = parse(input);
	if (!parsed) return { blocks: [] };
	let env = await live();
	if (parsed.page.startsWith("widget:")) {
		const id = parsed.page.slice("widget:".length);
		const owner = env.installed.find((module) => (module.widgets ?? []).some((candidate) => candidate.id === id));
		const widget = owner?.widgets?.find((candidate) => candidate.id === id);
		if (!owner || !widget) return { blocks: [] };
		if (!env.modules.includes(owner)) return { blocks: [{ type: "context", text: `${owner.feature?.label ?? "This feature"} is switched off.` }] };
		return { blocks: await widget.render(ctx, env) };
	}
	const result = parsed.type === "page_load" ? null : await act(ctx, env, parsed, null);
	// The action may have switched a feature on or off, or saved what one was waiting for.
	if (result) env = await live();
	const page = normalize(result?.page ?? parsed.page);
	const state: PageState = { ...(parsed.action ? { action: { ...parsed.action, module: parsed.module } } : {}), ...(result?.tab ? { focus: result.tab } : {}) };
	return { blocks: [...notice(result), ...remount(hints(await renderPage(ctx, env, page, state)), parsed, result)] };
}

/** Handles one interaction from the panel beside a saved entry. `target` is host-attested. */
export async function handlePanel(input: unknown, target: { collection: string; id: string } | undefined, ctx: Ctx, live: () => Promise<Env>): Promise<BlockResponse> {
	if (!target) return { blocks: [] };
	// A port can leave out entries that are not pages of the site (testimonials, FAQ items).
	if (PORT.unroutable) {
		const info = (await ctx.schema?.getCollection(target.collection)) as { routable?: boolean } | null | undefined;
		if (info?.routable === false) return { blocks: [{ type: "empty", title: "No page of its own", description: PORT.unroutable, size: "sm" }] };
	}
	const env = await live();
	let entry = await env.entry(ctx, target.collection, target.id);
	if (!entry) return { blocks: [{ type: "empty", title: PORT.unsaved, size: "sm" }] };
	const parsed = parse(input);
	const result = parsed && parsed.type !== "panel_load" ? await act(ctx, env, parsed, entry) : null;
	// Show what was just saved.
	if (result) entry = (await env.entry(ctx, target.collection, target.id)) ?? entry;
	const current = entry;
	const sections = env.modules.flatMap((module) => (module.panel ?? []).map((section) => ({ section, module: module.id }))).sort((a, b) => a.section.order - b.section.order);
	const blocks: Block[] = [];
	for (const { section, module } of sections) {
		let content: Block[];
		try {
			content = await section.render(ctx, env, current);
		} catch (error) {
			ctx.log.error(`${PORT.name} panel section failed`, { section: section.id, error: String(error) });
			content = [{ type: "banner", variant: "error", description: "This section could not be loaded. Reopen the entry; if it keeps happening, check the server log." }];
		}
		if (!content.length) continue;
		if (section.order === 0) blocks.push(...content);
		else blocks.push({ type: "accordion", label: section.label, default_open: parsed?.module === module || section.open?.(current) === true, blocks: content });
	}
	// Nothing that works on entries is switched on: say so instead of showing an empty panel.
	if (!blocks.length) blocks.push({ type: "context", text: "Nothing is switched on for entries yet." }, SETTINGS_LINK);
	return { blocks: [...notice(result), ...remount(hints(blocks), parsed, result)], ...(result?.refresh ? { refresh: true as const } : {}) };
}
