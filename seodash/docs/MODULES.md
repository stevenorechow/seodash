# Writing a SEOdash feature module

A feature is one `Module` object (`src/kit.ts`). `src/compose.ts` turns the list in
`src/modules/index.ts` into a plugin. The same modules run in the trusted build (`src/plugin.ts`)
and in the marketplace sandbox (`marketplace/src/plugin.ts`). Read `src/kit.ts` first, then `src/modules/meta.ts` (settings tabs
and head tags) and `src/modules/entry.ts` (entry panel) as worked examples.

## Rules

1. **Extend EmDash, never duplicate it.** EmDash core already has: per-entry SEO fields (title,
   description, image, canonical, hide from search engines), a redirect manager with a 404 log,
   loop detection, import and automatic redirects on slug change, `sitemap.xml`, a `robots.txt`
   editor with an AI-training opt-out, staging mode (site-wide noindex), Google and Bing
   verification, the title separator, a default sharing image, the site's social profiles, media
   alt text and captions, and media usage tracking. Do not build a second copy of any of these.
   Read core values (`env.core(ctx)`, `entry.seo`) and write them in place
   (`ctx.content.update(collection, id, { seo })`); add only what core lacks.
2. **Additive output.** With default settings a module changes nothing on the public site. Print a
   tag only for a value someone entered or a feature someone switched on. Defaults are "off"/empty.
3. **Portable code.** Use only the plugin context (`Ctx`) and Web APIs (`fetch` via `ctx.http`,
   `crypto.subtle`, `URL`, `TextEncoder`). No Node built-ins, no npm runtime dependencies, no
   imports from `emdash` except types. Network calls go through `request(ctx, url, init)` or
   `ctx.http.fetch`; declare `capabilities` and `allowedHosts` on the module
   (`network:request` + hosts, or `network:request:unrestricted` when hosts cannot be known).
4. **Native-looking UI, no branding.** All UI is EmDash Block Kit
   (`.claude/skills/creating-plugins/references/block-kit.md` at the repo root). Plain, short
   labels in sentence case; no product names, slogans, upsells or emoji; never mention the plugin
   this was ported from. Explain a setting in one `context` line only when the label is not enough.
5. **Never fail the host.** A hook or head contribution that throws must not break a page render or
   a save: catch, log with `ctx.log`, carry on. Bound every loop over content and every fetch
   (timeouts via `AbortSignal.timeout`, page sizes, max items per run). Scheduled work must be
   resumable in small batches: a run may be cut off after a few seconds on Cloudflare.

## Conventions

- **Settings:** `defineSection(id, defaults)` from `src/core/settings.ts`, loaded and saved with
  `ctx.settings`. API keys and tokens go through the `secrets` helper and `kind: "secret"` form
  fields (`readSecrets`), and are never rendered back.
- **Forms:** `formBlock(spec, values, savedSecrets?)` / `readForm(spec, submitted, current)` from
  `src/admin/forms.ts`. Field kinds: text (optionally multiline), number, toggle, select, date,
  secret, image (an address field). Block Kit forms on admin pages and panels do **not** support
  `repeater` or `media_picker`; use a multiline text field with one item per line for lists.
- **Action ids** are `<moduleId>:<name>`; the shell strips the prefix and calls the module's
  `act(ctx, env, action, entry)`. `entry` is non-null for the entry panel. Return `ok("Saved")`,
  `fail("…")`, or `null` for an id that is not yours. Return `{ refresh: true }` from a panel
  action that changed EmDash's own fields. Tables need a `page_action_id` (also `<moduleId>:…`).
- **Admin pages** are fixed (`PagePath` in `src/kit.ts`): `/` Overview, `/content`, `/titles`,
  `/social`, `/schema`, `/links`, `/reports`, `/settings`. A module adds tabs to them with `tabs`.
  A module with several tabs on one page gives each an `owns(action)` so the page stays on it.
- **Agent tools and publishing rules:** `tools` (MCP, backed by a private route, Zod input) and
  `beforePublish` (return a reason to block, or null).
- **Storage:** declare collections and their indexes in `module.storage`; use `store<T>(ctx, name)`
  and `all(...)`. Only indexed fields can be used in `where` / `orderBy`.
- **Entries:** `env.entry(ctx, collection, id)` returns an `EntryView` (title, excerpt, EmDash SEO
  fields, URL, content outline, SEOdash's own record). List content with
  `ctx.content.list(collection, { limit, cursor, where: { status: "published" } })` and collections
  with `ctx.schema.listCollections()`.
- **Exact host API shapes** are in `node_modules/emdash/dist/types-CImd8MBY.d.mts` (search for
  `interface PluginContext`, `MediaAccess`, `ContentAccess`, …) and the hook events in
  `.claude/skills/creating-plugins/references/hooks.md`. Check them rather than guessing.

## Host calls

In the sandbox an invocation may make about 30 host calls, and every read or write through `ctx`
is one. `compose()` hands each hook and route a per-invocation view of the context
(`src/core/scope.ts`) that reads all `config:*` settings in one call and remembers `kv.get`,
`schema` lookups and storage `get`s. Keep to it:

- Read many records with `prime(ctx, store, ids)` (one call) before a loop of `get`s, and write
  many with `putMany`.
- In a loop over entries, pass the listed item to `env.entry(ctx, collection, id, listed)`.
- Long work checks `hostCalls(ctx)` and stops early; the next run continues from a cursor.
- A module that needs facts about many entries implements `prepare()`.

`test/budget.test.ts` fails when a page, hook or batch goes over.

## Features (on/off switches)

Give a module a `feature: { label, description }` and it gets a switch under Settings → Features
(`src/modules/features.ts`, state in `config:features`). While it is off, `compose()` leaves the
module out of `env.modules`: no head tags, hooks, scheduled jobs, panel sections, tabs, widget
content or routes. `env.installed` is every module in the build, on or off.

- `off: true` starts the feature switched off.
- `needs(ctx, env)` returns what is still missing ("An API key"), or null. Until it returns null
  the feature cannot be switched on and is listed under "Not set up yet".
- `requires: ["reports"]` names features that must be on first.
- A tab marked `setup: true` stays visible while the feature is off, so what it needs can be
  entered there; the shell shows a notice and, once ready, a "Switch on" button above it.
- `on.toggle(ctx, env, on)` runs when the feature is switched: build or clear what the module serves.
- Do not add a second "enabled" toggle inside a module's settings; the feature switch is the switch.
- To ask whether another feature is on, look in `env.modules`, not `env.installed`.
- Root routes and site helpers read `config:features` themselves (see `src/routes/indexnow.ts`).

## Tests

`test/helpers.ts` has `harness(modules, options)`: a fake plugin context (content, schema, storage,
settings, http, cron, email) plus `page()`, `submit()`, `press()`, `panel()`, `head()`, and
`valid(response)`, which runs EmDash's own Block Kit validator. See `test/meta.test.ts`. Every tab,
panel section and widget a module renders must pass `valid`. Extend the fake context when a module
needs a host API it lacks; keep it faithful to the real type.

Run `npx tsc --noEmit` and `npx vitest run`.
