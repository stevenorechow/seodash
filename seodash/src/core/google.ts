/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Google service-account sign-in: exchanges the account's JSON key for a short-lived access token
 * (OAuth 2.0 JWT bearer flow), using Web Crypto so it runs in any runtime. Tokens are cached in the
 * plugin's key-value store until shortly before they expire.
 */
import type { Ctx } from "../kit.js";

export interface ServiceAccount {
	client_email: string;
	private_key: string;
}

/** Parses the JSON key file Google gives for a service account; null when it is not one. */
export function parseServiceAccount(json: string): ServiceAccount | null {
	try {
		const parsed = JSON.parse(json) as Partial<ServiceAccount>;
		if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") return null;
		if (!parsed.private_key.includes("PRIVATE KEY")) return null;
		return { client_email: parsed.client_email, private_key: parsed.private_key };
	} catch {
		return null;
	}
}

const base64url = (bytes: Uint8Array | string) => {
	const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
	let binary = "";
	for (const byte of data) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function signedJwt(account: ServiceAccount, scope: string, now: number): Promise<string> {
	const pem = account.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
	const der = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = base64url(JSON.stringify({ iss: account.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
	return `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
}

/** Hosts a module must allow to use Google APIs with a service account. */
export const GOOGLE_AUTH_HOST = "oauth2.googleapis.com";

/**
 * An access token for `scope` (space-separated OAuth scopes). Throws with a readable message when
 * Google refuses the key.
 */
export async function googleToken(ctx: Ctx, account: ServiceAccount, scope: string): Promise<string> {
	const cacheKey = `google-token:${account.client_email}:${scope}`;
	const cached = await ctx.kv.get<{ token: string; expires: number }>(cacheKey);
	const now = Math.floor(Date.now() / 1000);
	if (cached && cached.expires - 120 > now) return cached.token;
	if (!ctx.http) throw new Error("SEOdash has no network access on this site.");
	const assertion = await signedJwt(account, scope, now);
	const response = await ctx.http.fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
		signal: AbortSignal.timeout(10_000),
	});
	const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
	if (!response.ok || !body.access_token) throw new Error(`Google did not accept the service account key${body.error_description ? `: ${body.error_description}` : "."}`);
	await ctx.kv.set(cacheKey, { token: body.access_token, expires: now + (body.expires_in ?? 3600) });
	return body.access_token;
}

/** Name of the secret that holds the service-account JSON key, shared by every Google feature. */
export const GOOGLE_KEY_SECRET = "google-service-account";

/**
 * Google's answer when an API is not switched on for the key's Cloud project, in plain words.
 * Its own message is long and carries a project number and a console address.
 */
export function googleMessage(message: string): string {
	const api = /^(.+? API) has not been used in project|^(.+? API) is disabled/i.exec(message);
	const name = api?.[1] ?? api?.[2];
	return name ? `The ${name.replace(/^Google /, "")} is not switched on for this service account's Google Cloud project. Enable it there (APIs and services), wait a few minutes and try again.` : message;
}
