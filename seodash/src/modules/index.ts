/**
 * The trusted build's feature modules, in the order their head tags are printed. The marketplace
 * build's list (`marketplace.ts`) has the same features, without what the sandbox cannot use.
 */
import type { Module } from "../kit.js";
import { audit } from "./audit.js";
import { checks } from "./checks.js";
import { entry } from "./entry.js";
import { features } from "./features.js";
import { indexingModule } from "./indexing.js";
import { meta } from "./meta.js";
import { schema } from "./schema/index.js";
import { tools } from "./tools.js";

/** Without Google's Indexing API, which does not fit the sandbox size limit. */
const indexing = indexingModule();

export const MODULES: Module[] = [features, meta, entry, schema, audit, indexing, checks, tools];
