/**
 * Warnings for structured data that lacks a property Google requires for a rich result. This
 * build leaves the check out to stay within the marketplace size limit.
 */
import type { Node } from "./util.js";

export function missingRequired(_type: string, _node: Node | undefined): string[] {
	return [];
}
