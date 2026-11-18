/**
 * Which features are switched on. A module with a `feature` can be turned off under
 * Settings → Features; one that still lacks something it needs (an API key, another feature)
 * cannot be turned on yet. Modules without a `feature` are always on.
 */
import type { Ctx, Env, Module } from "../kit.js";
import { sectionKey } from "./settings.js";

export const FEATURES_KEY = sectionKey("features");

export type Flags = Record<string, boolean>;

export interface FeatureStatus {
	module: Module;
	/** What the site owner chose (or the default). */
	wanted: boolean;
	/** Why it cannot run yet; null when nothing is missing. */
	missing: string | null;
	/** Wanted and nothing missing. */
	on: boolean;
}

export async function loadFlags(ctx: Ctx): Promise<Flags> {
	try {
		const stored = await ctx.settings.get<unknown>(FEATURES_KEY);
		if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
		return Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "boolean")) as Flags;
	} catch {
		return {};
	}
}

export const saveFlags = (ctx: Ctx, flags: Flags): Promise<void> => ctx.settings.set(FEATURES_KEY, flags);

const wanted = (module: Module, flags: Flags): boolean => (module.feature ? (flags[module.id] ?? module.feature.off !== true) : true);

/** True when the feature with this id is chosen (ignores what it may still need). */
export async function featureWanted(ctx: Ctx, env: Env, id: string): Promise<boolean> {
	const module = env.installed.find((candidate) => candidate.id === id);
	return module ? wanted(module, await loadFlags(ctx)) : false;
}

/** The state of each of `modules`. `env.installed` supplies the features they depend on. */
export async function featureStatus(ctx: Ctx, env: Env, modules: Module[] = env.installed, lazy = false): Promise<FeatureStatus[]> {
	const chosen = await loadFlags(ctx);
	const known = new Map<string, FeatureStatus>();
	const resolve = async (module: Module, depth: number): Promise<FeatureStatus> => {
		const done = known.get(module.id);
		if (done) return done;
		const status: FeatureStatus = { module, wanted: wanted(module, chosen), missing: null, on: false };
		const feature = module.feature;
		if (feature) {
			for (const id of depth < 4 ? (feature.requires ?? []) : []) {
				const other = env.installed.find((candidate) => candidate.id === id);
				if (!other) status.missing = "A feature this build does not include";
				else if (!(await resolve(other, depth + 1)).on) status.missing = `${other.feature?.label ?? id} switched on`;
				if (status.missing) break;
			}
			// A feature that is off anyway is not asked what it needs on public pages.
			if (!status.missing && feature.needs && (status.wanted || !lazy)) {
				try {
					status.missing = await feature.needs(ctx, env);
				} catch {
					status.missing = "Its settings could not be read";
				}
			}
		}
		status.on = status.wanted && !status.missing;
		known.set(module.id, status);
		return status;
	};
	const out: FeatureStatus[] = [];
	for (const module of modules) out.push(await resolve(module, 0));
	return out;
}

/** The modules of `modules` that are on. */
export async function activeModules(ctx: Ctx, env: Env, modules: Module[]): Promise<Module[]> {
	if (!env.installed.some((module) => module.feature)) return modules;
	return (await featureStatus(ctx, env, modules, true)).filter((status) => status.on).map((status) => status.module);
}
