/**
 * The feature modules, in the order their head tags are printed. The trusted build and the
 * marketplace build carry the same set, which fits the marketplace's 128 KB code limit.
 */
import type { Module } from "../kit.js";
import { audit } from "./audit.js";
import { checks } from "./checks.js";
import { entry } from "./entry.js";
import { features } from "./features.js";
import { indexing } from "./indexing.js";
import { meta } from "./meta.js";
import { schema } from "./schema/index.js";
import { tools } from "./tools.js";

export const MODULES: Module[] = [features, meta, entry, schema, audit, indexing, checks, tools];
