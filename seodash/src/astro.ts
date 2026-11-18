/**
 * Astro integration that serves the IndexNow key file at `/indexnow-key.txt`. It answers 404 until
 * IndexNow is switched on in the admin, so adding the integration changes nothing by itself.
 *
 *   import { seodash, seodashRoutes } from "seodash";
 *   integrations: [emdash({ plugins: [seodash()] }), seodashRoutes()]
 */
interface SetupHook {
	injectRoute(route: { pattern: string; entrypoint: string; prerender?: boolean }): void;
}

export function seodashRoutes() {
	return {
		name: "seodash",
		hooks: {
			"astro:config:setup": ({ injectRoute }: SetupHook) => {
				injectRoute({ pattern: "/indexnow-key.txt", entrypoint: "seodash/routes/indexnow", prerender: false });
			},
		},
	};
}
