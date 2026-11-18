/**
 * Settings → Features: switches each feature on or off. A feature that still needs something
 * (an API key, another feature) is listed with what it needs and cannot be switched on until then.
 */
import { type FeatureStatus, featureStatus, loadFlags, saveFlags } from "../core/features.js";
import { type Block, type Ctx, type Env, type Module, fail, ok } from "../kit.js";
import { PORT } from "../port.js";

const named = (status: FeatureStatus) => status.module.feature!.label;

async function listed(ctx: Ctx, env: Env): Promise<FeatureStatus[]> {
	return (await featureStatus(ctx, env)).filter((status) => status.module.feature);
}

async function tab(ctx: Ctx, env: Env): Promise<Block[]> {
	const all = await listed(ctx, env);
	const ready = all.filter((status) => !status.missing);
	const waiting = all.filter((status) => status.missing);
	const blocks: Block[] = [{ type: "context", text: "Switch off what this site does not use. A feature that is off adds nothing and does no work; its settings are kept." }];
	if (ready.length) {
		blocks.push({
			type: "form",
			block_id: "features:save",
			fields: ready.map((status) => ({ type: "toggle" as const, action_id: status.module.id, label: named(status), description: status.module.feature!.description, initial_value: status.wanted })),
			submit: { label: "Save", action_id: "features:save" },
		});
	}
	if (waiting.length) {
		blocks.push({ type: "divider" }, { type: "section", text: "Not set up yet" });
		for (const status of waiting) {
			const setup = setupOf(status.module) !== null;
			blocks.push({
				type: "section",
				text: `**${named(status)}**\n${status.module.feature!.description}\nNeeds: ${status.missing}.`,
				...(setup ? { accessory: { type: "button" as const, label: "Set up", action_id: "features:setup", value: status.module.id } } : {}),
			});
		}
	}
	return blocks;
}

/** Where what a feature still needs is entered: the place it names, or its own set-up tab. */
function setupOf(module: Module | undefined): { page: string; tab: string } | null {
	if (!module) return null;
	if (module.feature?.setup) return module.feature.setup;
	const tab = (module.tabs ?? []).find((candidate) => candidate.setup);
	return tab ? { page: tab.page, tab: module.id } : null;
}

/** Lets a module tidy up (or build what it serves) when its feature is switched. */
async function switched(ctx: Ctx, env: Env, module: Module, on: boolean): Promise<void> {
	try {
		await module.on?.toggle?.(ctx, env, on);
	} catch (error) {
		ctx.log.error(`${PORT.name} feature switch failed`, { module: module.id, error: String(error) });
	}
}

export const features: Module = {
	id: "features",
	tabs: [{ page: "/settings", label: "Features", order: 0, render: tab }],
	async act(ctx, env, action) {
		const flags = await loadFlags(ctx);
		if (action.id === "setup") {
			const where = setupOf(env.installed.find((module) => module.id === action.value));
			return where ? { tab: where.tab, page: where.page } : null;
		}
		if (action.id === "on") {
			const status = (await listed(ctx, env)).find((candidate) => candidate.module.id === action.value);
			if (!status) return null;
			if (status.missing) return fail(`${named(status)} needs: ${status.missing}.`);
			await saveFlags(ctx, { ...flags, [status.module.id]: true });
			await switched(ctx, env, status.module, true);
			return { ...ok(`${named(status)} switched on`), tab: status.module.id };
		}
		if (action.id !== "save" || !action.values) return null;
		let changed = 0;
		const turned: Array<[Module, boolean]> = [];
		for (const status of await listed(ctx, env)) {
			const value = action.values[status.module.id];
			// Only what was shown as a switch can be changed: a feature that is not set up stays off.
			if (typeof value !== "boolean" || status.missing || value === status.wanted) continue;
			flags[status.module.id] = value;
			turned.push([status.module, value]);
			changed++;
		}
		if (changed) await saveFlags(ctx, flags);
		for (const [module, on] of turned) await switched(ctx, env, module, on);
		return changed ? ok("Saved") : { toast: { type: "info", message: "Nothing changed" } };
	},
};
