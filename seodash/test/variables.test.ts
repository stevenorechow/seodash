import { describe, expect, it } from "vitest";
import { renderTemplate, trimWords } from "../src/core/variables.js";
import { entryVars, vars } from "./helpers.js";

describe("renderTemplate", () => {
	it("fills entry and site variables", () => {
		const out = renderTemplate("%%post_title%% %%sep%% %%sitetitle%%", vars({ entry: entryVars() }));
		expect(out).toBe("Hello world - Acme");
	});

	it("removes unknown variables and the separators they leave behind", () => {
		expect(renderTemplate("%%nope%% %%sep%% %%sitetitle%%", vars())).toBe("Acme");
		expect(renderTemplate("%%sitetitle%% %%sep%% %%post_title%% %%sep%% %%tagline%%", vars())).toBe("Acme - Tools that work");
		expect(renderTemplate("%%sitetitle%% %%sep%% %%page%%", vars({ page: 1 }))).toBe("Acme");
	});

	it("prints the page number only after the first page", () => {
		expect(renderTemplate("%%sitetitle%% %%sep%% Page %%page%%", vars({ page: 3 }))).toBe("Acme - Page 3");
	});

	it("reads entry fields with _cf_", () => {
		const ctx = vars({ entry: entryVars() });
		expect(renderTemplate("%%_cf_subtitle%% (%%_cf_count%%)", ctx)).toBe("The subtitle (3)");
		expect(renderTemplate("%%_cf_missing%%x", ctx)).toBe("x");
	});

	it("formats dates and the current year", () => {
		const ctx = vars({ entry: entryVars() });
		expect(renderTemplate("%%post_date%%", ctx)).toBe("January 15, 2026");
		expect(renderTemplate("© %%currentyear%%", ctx)).toBe("© 2026");
		expect(renderTemplate("%%currentmonth_num%%", ctx)).toBe("03");
	});

	it("falls back from excerpt to trimmed content", () => {
		const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
		const out = renderTemplate("%%post_excerpt%%", vars({ entry: entryVars({ excerpt: "", content: long }) }));
		expect(out.split(" ")).toHaveLength(50);
		expect(out.endsWith("…")).toBe(true);
	});

	it("keeps a pipe separator literal", () => {
		expect(renderTemplate("%%nope%% %%sep%% %%sitetitle%%", vars({ separator: "|" }))).toBe("Acme");
		expect(renderTemplate("A %%sep%% B", vars({ separator: "|" }))).toBe("A | B");
	});

	it("returns an empty string for an empty template", () => {
		expect(renderTemplate("", vars())).toBe("");
	});
});

describe("trimWords", () => {
	it("leaves short text alone", () => {
		expect(trimWords("one  two\nthree")).toBe("one two three");
	});
});
