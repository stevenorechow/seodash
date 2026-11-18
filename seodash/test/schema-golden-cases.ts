/** Inputs for the structured data golden test: every type, six sets of values, with and without a site address. */
import type { BuildContext, SchemaType, Values } from "../src/modules/schema/types.js";

const context = (site: string): BuildContext => ({ siteUrl: site, siteName: "Acme", pageUrl: `${site}page`, publisher: { "@id": `${site}#publisher` }, website: { "@id": `${site}#website` }, publishedAt: "2026-01-02T03:04:05Z", render: (text) => text.replace(/%%post_title%%/g, "Hello") });

function sample(key: string, kind: string, options: Array<{ value: string }> | undefined, n: number): string | boolean {
	if (kind === "toggle") return n % 2 === 0;
	if (kind === "select") return options?.[n % options.length]?.value ?? "";
	const k = key.toLowerCase();
	if (n % 7 === 3) return "";
	if (/date|start|end|deadline|valid|published|founded/.test(k)) return n % 2 ? "2026-05-01" : "2026-05-01T10:00";
	if (/url|image|logo|thumbnail|link|menu|embed|content/.test(k)) return n % 2 ? "/rel/path.jpg" : "https://example.com/x.jpg";
	if (/duration|time|prep|cook|total/.test(k)) return n % 2 ? "1h 30m" : "PT45M";
	if (/price|rating|value|count|salary|amount|lat|long|employees|calories|pages|best|worst|min|max/.test(k)) return n % 2 ? "12.5" : "3";
	if (/question|steps|ingredients|instructions|lines|hours|offers|sameas|list|tools|supply|cuisine|notes/.test(k)) return n % 2 ? "One | Two\nThree | Four" : "Mon-Fri 09:00-17:00\nA? | B.";
	return `${key} %%post_title%% v${n}`;
}

export function CASES(types: SchemaType[]): Array<{ name: string; type: string; values: Values; context: BuildContext }> {
	const out: Array<{ name: string; type: string; values: Values; context: BuildContext }> = [];
	for (const type of types) {
		for (let variant = 0; variant < 6; variant++) {
			const values: Values = { ...type.defaults };
			type.fields.forEach((field, index) => (values[field.key] = sample(field.key, field.kind, (field as { options?: Array<{ value: string }> }).options, variant + index)));
			if (variant === 4) for (const field of type.fields) if (field.key !== type.titleField) values[field.key] = field.kind === "toggle" ? false : "";
			if (variant === 5) values[type.titleField ?? "name"] = "";
			for (const site of ["https://acme.test/", ""]) out.push({ name: `${type.id}:${variant}:${site ? "site" : "nosite"}`, type: type.id, values: { ...values }, context: context(site) });
		}
	}
	return out;
}
