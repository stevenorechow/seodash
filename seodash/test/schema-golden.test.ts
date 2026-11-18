/**
 * The structured data types against their output before the table-driven rebuild (fixture written
 * from revision c00f290's types.ts): same fields, defaults and labels, and byte-for-byte the same
 * JSON-LD, property order included, for every type and set of values in schema-golden-cases.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TYPES, reader } from "../src/modules/schema/types.js";
import { CASES } from "./schema-golden-cases.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/schema-golden.json", import.meta.url), "utf8")) as Record<string, string>;
const sortKeys = (x: unknown): unknown => (Array.isArray(x) ? x.map(sortKeys) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, sortKeys((x as Record<string, unknown>)[key])])) : x);

describe("structured data types match their output before the rebuild", () => {
	for (const type of TYPES) {
		it(type.id, () => {
			expect(JSON.stringify(sortKeys({ ...type, build: undefined, check: undefined }))).toBe(golden[`${type.id}:spec`]);
			for (const item of CASES(TYPES).filter((candidate) => candidate.type === type.id)) {
				let out: string;
				try {
					out = JSON.stringify(type.build(reader(item.values, item.context), item.context)) ?? "null";
				} catch (error) {
					out = `THROW ${String(error)}`;
				}
				expect(out, item.name).toBe(golden[item.name]);
			}
		});
	}
});
