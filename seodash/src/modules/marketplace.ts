/**
 * The marketplace (sandboxed) build's modules: the same features, without the code a sandboxed
 * plugin cannot use, so the bundle fits the 128 KB limit.
 */
import type { Module } from "../kit.js";
import { audit } from "./audit.js";
import { checks } from "./checks.js";
import { entryModule } from "./entry.js";
import { features } from "./features.js";
import { indexingModule } from "./indexing.js";
import { meta } from "./meta.js";
import { schema } from "./schema/index.js";
import { tools } from "./tools.js";

/** The sandbox cannot write EmDash's own SEO fields, so the panel shows them read-only. */
export const MODULES: Module[] = [features, meta, entryModule(), schema, audit, indexingModule(), checks, tools];
