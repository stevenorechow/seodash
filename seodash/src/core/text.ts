/**
 * Reads an entry's content: Portable Text (EmDash's rich text) or plain strings, reduced to the
 * parts SEO checks and templates need: text, headings, links and images.
 */

export interface ContentOutline {
	text: string;
	headings: Array<{ level: number; text: string }>;
	links: Array<{ href: string; text: string; nofollow: boolean }>;
	images: Array<{ alt: string }>;
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

function spanText(children: unknown): string {
	if (!Array.isArray(children)) return "";
	return children.map((child) => (isNode(child) && typeof child.text === "string" ? child.text : "")).join("");
}

function isPortableText(value: unknown): value is Node[] {
	return Array.isArray(value) && value.some((item) => isNode(item) && typeof item._type === "string");
}

function readBlocks(blocks: Node[], out: ContentOutline, texts: string[]): void {
	for (const block of blocks) {
		if (block._type === "block") {
			const text = spanText(block.children).trim();
			const style = typeof block.style === "string" ? block.style : "normal";
			const heading = /^h([1-6])$/.exec(style);
			if (heading && text) out.headings.push({ level: Number(heading[1]), text });
			if (text) texts.push(text);
			const defs = Array.isArray(block.markDefs) ? block.markDefs.filter(isNode) : [];
			for (const def of defs) {
				if (def._type !== "link" || typeof def.href !== "string") continue;
				const linked = Array.isArray(block.children)
					? block.children.filter((c) => isNode(c) && Array.isArray(c.marks) && c.marks.includes(def._key))
					: [];
				const rel = typeof def.rel === "string" ? def.rel : "";
				out.links.push({ href: def.href, text: spanText(linked).trim(), nofollow: /\bnofollow\b/.test(rel) || def.nofollow === true });
			}
			continue;
		}
		if (block._type === "image") {
			const alt = typeof block.alt === "string" ? block.alt : isNode(block.asset) && typeof block.asset.alt === "string" ? block.asset.alt : "";
			out.images.push({ alt });
			continue;
		}
		// Custom blocks: count any nested rich text and plain strings as page text.
		for (const [name, value] of Object.entries(block)) {
			if (name.startsWith("_")) continue;
			if (isPortableText(value)) readBlocks(value, out, texts);
			else if (typeof value === "string" && value.trim() && !/^https?:\/\//.test(value) && /\s/.test(value)) texts.push(value.trim());
		}
	}
}

/** Outline of every rich-text and long-text field of an entry's data. */
export function outlineContent(data: Record<string, unknown>, skip: string[] = ["title", "slug", "seo"]): ContentOutline {
	const out: ContentOutline = { text: "", headings: [], links: [], images: [] };
	const texts: string[] = [];
	for (const [name, value] of Object.entries(data)) {
		if (skip.includes(name)) continue;
		if (isPortableText(value)) readBlocks(value, out, texts);
	}
	out.text = texts.join("\n");
	return out;
}

export function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

export function firstString(data: Record<string, unknown>, names: string[]): string {
	for (const name of names) {
		const value = data[name];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

/** URL of an image field: a URL string, a media reference with `url` or `src`, or a file in the media library. */
export function imageUrl(value: unknown): string {
	if (typeof value === "string") return value;
	if (isNode(value)) {
		if (typeof value.url === "string") return value.url;
		if (typeof value.src === "string") return value.src;
		// A file in EmDash's own media library is served from its storage key.
		const key = isNode(value.meta) ? value.meta.storageKey : undefined;
		if (typeof key === "string" && key && (value.provider === undefined || value.provider === "local")) return `/_emdash/api/media/file/${key}`;
	}
	return "";
}

export function absoluteUrl(url: string, base: string): string {
	if (!url) return "";
	try {
		return new URL(url, base || undefined).toString();
	} catch {
		return url;
	}
}
