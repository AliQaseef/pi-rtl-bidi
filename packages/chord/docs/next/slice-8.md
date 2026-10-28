# Slice 8: registries and `host.root` (spec)

Status: **draft, open points marked "Decision needed"** (2026-10-27), written by the redesign session. Built in
parallel with 6b (mostly new files). The single source for building 8, together with `design.md` (§7, §8, §11, §16,
§17, §18, §24 read in full), the decision log `decisions.md` (R21, R23, R25, Q8, D1 of "Review round 1", "Registries
work like Durable's", "Changing contributions, `self.writable`", W4, "Failures are watch calls", "Slice 8 is
'Registries and `host.root`'"), the feature map and carry-over of `slices.md` (slice 8), and the root `AGENTS.md`
"Chord v2 Code Style".

8 builds the extension point between plugins (registries), in-process values that change (`self.writable`), wake
signals for failed objects (`retryOn`), and the call scope for code outside objects (`host.root`). The harness object
is p3's base code; Chord shows it only in an example.

## What an app can do after this slice

```ts
// the defining plugin (e.g. http): the token, exported for other plugins
export const Http = defineRegistry<HttpContribution, Router>("chord.http", { version: 2 });   // shared: identity only
export default defineFacet((host, self) => {
  host.serve(Http, {                                              // the one provider (Q8), as for object types
    compose: (table, { report }) => buildRouter(table, report),   // pure; always a value; conflicts reported
    accepts: { 1: (old: HttpContributionV1): HttpContribution => upgrade(old) },
  });
  host.serve(HttpServer, (_, self) => {
    const router = self.registry(Http);                           // a NativeWatchable of the composed value
    self.on(router, ({ value }, ctx) => …);
    return { … };
  });
});

// any plugin: a facet or a host-lifetime object contributes one value per registry
export default defineFacet((host, self) => {
  self.contribute(Http, { routes: { "GET /notes/export": exportNotes } });
});
host.serve(McpStore, (_, self) => {                               // local, empty params (R21)
  const ext = self.writable(mcpExtension([]));                    // an in-process value that changes
  self.contribute(HarnessExtensions, ext);
  self.on(mcp.tools, ({ value: tools }) => ext.set(mcpExtension(tools)));
  self.retryOn(self.registry(HarnessModels));                     // a model contribution wakes a failed attempt
  return {};
});

// code outside objects (a Durable tool, a CLI): a call scope
await host.root(async (ctx) => (await ctx.get(Notes, { session })).add(note, ctx), context);
```

## 1. Registries

- **Token and provider (D1, owner, 2026-10-27):** the token `defineRegistry<C, V>(name, { version })` is shared, as a
  contract: its name (as types, `[a-z0-9@/._~-]`), the contribution type `C`, the composed value type `V`, and the
  version the bundling plugin was built against. The defining plugin's facet provides it with `host.serve(R, {
  compose, accepts? })`, as it serves object types (adapters with the provider, never in the shared token, as
  `checkAccepts` for contracts); a second serve on a host is refused; a reload replaces it (slice 7).

- **Contributors** (R21): facets (by plugin name) and host-lifetime objects (`local`, empty params: by plugin name and
  type), at most one value per registry each; `self.contribute(R, value | Watchable | NativeWatchable)` in a facet setup
  or such an object's factory (a type error elsewhere; a declaration error at runtime). A facet's contribution is in the
  table while its plugin is loaded; an object's from `live` until it ends, fails or restarts.
- **The table:** an immutable list of `{ contributor, plugin, value }`, sorted by plugin name, then type (never load
  order); a contribution carries its token's version: an older one is adapted once with the declaration's `accepts`
  when the table is built, an older one without an adapter or a newer one is left out and reported (`HostError`
  `contribution_refused { registry, plugin, version }`).
- **`compose(table, { report })`:** pure, runs whenever the table changes (a contributor goes live or ends, a
  contribution that is a watchable changes), in the owner's flush, never inside another owner's commit step (W4);
  `report(conflict)` goes to `onError` as `registry_conflict { registry, message, plugins }`.
- **Failures (owner, 2026-10-27):** contributions never fail the registry. A contribution that is a watchable and fails
  is left out of the table and reported (`contribution_failed { registry, plugin, error }`), the table recomposes without
  it, and it is back once it heals. A `compose` that throws (the owner's bug) is reported (`registry_failed { registry,
  error }`), the composed value's watches get a `failed` call, and `.value` keeps the last good composition (an extension
  point stays available; derives keep their own rule, `.value` throwing while failed); the next good composition
  replaces it. Before any good composition `.value` throws the error.
- **Without a provider** (the defining plugin is not loaded): the composed value is failed with
  `unavailable/undeclared` (readers see the error as from a failed reference); contributions wait in the table; its
  serve heals it.
- **Reading:** `self.registry(R)` in any object's factory returns a `NativeWatchable<V>` (a derive source, an `on`
  source, a `retryOn` source); methods and routines read `.value` at use; `host.registry(R)` for code outside objects.
- **Helpers:** `keyed(table, entriesOf)` (a map, a duplicate key reported, the first by plugin name wins) and
  `ordered(table, itemsOf, orderOf?)`.
- **Use sites guard contributions** (Q8): Chord's helpers keep each entry's plugin name; the guide shows catching a
  contribution's throws and rejections, reporting the plugin, and continuing.
- **Registries carry natives** (design §17): a contribution may be any in-process value; an entry lives exactly as long
  as its contributor.

## 2. `self.writable(initial)`

A `NativeWatchable<T>` with `set(value)` (identity compared: `set` of the same value notifies nobody; a new value is a
new frame), owned by the attempt (dropped with it); never a state member (a type error and the member check refuse
it); usable as a contribution, a derive source and an `on` source. `set` inside a batch marks it there; outside, it
opens its own batch.

## 3. `self.retryOn(...sources)`

In any object's factory, anywhere: Chord installs a watch on each source before natives open, so a failed open still
has them; a call of any source while the object is failed (`transient` or `broken`) retries it as `ref.retry()` does
(backoff skipped, an attempt now, holders told `loading`); ignored while live or activating. Sources must live
independently of the attempt: a registry's composed value, another object's `writable` reached through a registry,
`constant`; a reference's member is a type error (it would fail with the dependency, R18 handles that).

> **Decision needed (D2): which calls retry.** A registry value's `failed` call (compose threw) is no reason to retry
> the dependent. Proposal: only `value` calls retry; `failed` calls are ignored.

## 4. `host.root(fn, context, options?)`

> **Decision needed (D3): the signature and its guarantees** (design §26 #25). Proposal: `host.root<T>(fn: (ctx: Ctx)
> => Promise<T>, context: Context, options?: { principal?: P }): Promise<T>`: `fn` gets a call context like a
> handler's: the host's principal (or `options.principal`, a trusted same-host caller's choice, as base code acting for
> an authenticated user), this host's incarnation, `context`'s telemetry and abort signal linked until `fn` settles
> (`withLinkedAbortSignal`), and `ctx.get`. When `fn` settles, every reference it took is released and a later
> `ctx.get` throws `released`; an aborted `fn` that does not stop keeps running, but its references are already
> released (as a handler after its caller's cancellation). `host.root` before `load` resolved parks its `ctx.get`s
> like any reference; after `host.close` it rejects `released`. No span of its own until slice 9.

- `chord(fn, context)` is p3's helper over `host.root` (design §24); Chord ships none.

## 5. Durable on registries (examples, p3's pattern)

- Durable's `HarnessOptions.registry` takes a `RegistryReader` (`snapshot()`, `subscribe(listener)`); Durable gets
  `registryReader(watchable)` (in its `src`, as `StoreStorage`): `snapshot()` reads the watchable's value,
  `subscribe` watches it. `models` and `settings` already accept functions.
- **Durable's views from other objects** (carry-over from 6b): the object that opens Durable contributes its harness to
  a registry (`HarnessRegistry`, p3's); another object reads it with `self.registry(...)` and follows a view:
  `self.follow((observer, ctx) => self.registry(HarnessRegistry).value.observeConversation(id, observer, ctx))`; a
  harness that ends ends the follow (R4), a new one is followed on the next attempt (`retryOn` the registry).
- Example `29-registries.ts` (a router registry with two contributing plugins, a conflict reported, a `writable`
  contribution, a missing declaration healing); example `30-host-root.ts`; example `31-harness-registry.ts` (a
  Durable harness on the store, its extensions from a registry, its views followed by a second object).

## 6. Carry-over

From `slices.md` "Slice 8": `host.root` (D3); `retryOn` (section 3); registries recomposing in the owner's flush (W4);
`host.activity` on the facet's host: not built (nothing needs it; dropped from the carry-over); Durable's views from
other objects (section 5). Left to slice 7: registries on reload (a reload replaces a contribution and a declaration
atomically; staging composes nothing, decision D1 of "Review round 1"); `accepts` of contracts and jobs.

## 7. Tests and cost

- One `describe` per mechanism: tokens and providers (two serves refused, a missing one healing), contributors
  (R21's type and runtime refusals, facet and object lifetimes, one value each), the table (order by plugin, versions
  adapted, refused versions reported), `compose` (in the flush, after a commit that changed a watchable contribution,
  conflicts reported, a throw as a failure call and its heal), reading (`self.registry` in derives and `on`, `.value` at
  use), `writable` (identity, batching, as a contribution), `retryOn` (a failed object retried by a contribution, value
  calls only, sources installed before natives), `host.root` (principal, release at settle, abort, before load, after
  close), `registryReader` with a Durable harness; GC for every table, writable and root scope.
- Cost guards: one compose per flush per changed table; no compose for an unchanged table; a `writable.set` of the same
  value costs one comparison.
