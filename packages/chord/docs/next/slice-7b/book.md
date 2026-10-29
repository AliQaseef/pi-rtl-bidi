---
title: Slice 7b: reloading plugins in a running Chord app
cover: Slice 7b / Reload
kicker: A design brief · Chord v2 · slice 7b · 2026-10-29
subtitle: What happens to objects, references, jobs and registries when a plugin's code changes on one host or across many, what is decided and what the owner still decides
stats:
  - 4 | steps of a reload on one host
  - 3 | fates of a live object
  - 26 | carry-over items from slices 3a to 7a
  - 5 | decisions open
note: |
  A brief before the slice 7b spec, written by the redesign session from `design.md` §21, the dependency model
  (`dependencies/model.md`, decided and built for 7a in pi `339847eb1`), the carry-over in `slices.md` and the code at
  `339847eb1`. Marks: **Decided** points cite the decision; **Open** points are the owner's, with a recommendation.
colophon: Slice 7b brief · 2026-10-29 · Chord v2
---

# Before we begin {.preface}

Mario edits the notes plugin while a session is open: a new method, a renamed field in a document, a second state
member. He presses Reload. The server, the session's worker and two browser tabs run the old notes code; within a
second they should all run the new one, with the notes, the open views and the running export job intact, and without
restarting a single process.

Chord v2 can do everything around that today: objects, references across hosts, the store, jobs, registries, and since
7a a dependency model in which a missing provider is a wait, not an error. What it cannot do yet is change code. `load`
runs once per host (`host.ts`: "load runs once per host"). Slice 7b adds the reload, on one host and across hosts.

## Six things to know

:::findings
1. **A reload is a transaction per host.** Load the bundles, stage the new declarations, commit atomically, then let
   each object follow; any code error before the commit leaves the host entirely on its old code.
2. **A live object has three fates.** Pure objects swap in place; objects with natives drain and restart; objects of a
   removed type end, and their holders wait.
3. **Old calls finish on old code.** A pure swap keeps the running calls' old handles valid until they settle; only new
   calls see the new code.
4. **Versions are the provider's business.** A provider accepts older consumers through `accepts`; a consumer that does
   not fit waits (7a), it is not ended.
5. **7a already decided most of the hard part.** Removal, dropped versions and installs are waits woken by a
   publication; a reload's commit is such a publication.
6. **Five points are open:** the reload API, the rollout across hosts, loader D, a `writable` across a swap, and the
   install watchdog.
:::

## Words used throughout

A **reload** changes the code of one or more plugins on one host. A **facet** is a plugin's code for one host kind; a
**bundle** is the built JavaScript of a facet. **Staging** runs the new facets and factories against a recording
`self` without activating anything. The **commit** switches the host to the new code at once and is a **publication**
in 7a's sense. A **pure** object has no natives (`self.open`), in its old or its new code. A **rollout** is a reload
of the same code set on every host, server first.

# One Host Reloads {#host lede="Four steps, all or nothing up to the commit."}

Design §21 fixes the shape. **Decided.**

```text
1. load      the new bundles; an import or syntax error rejects
2. staging   facet setups and every live object's new factory run with a recording `self`
             (declarations only, nothing activated); any throw rejects
3. commit    the host switches to the new code atomically: a publication (7a)
4. after     each object follows its fate (chapter II)
```

Rollback is all or nothing per host, and only for code errors: an import error, a throwing setup or factory. A failed
`open`, a registry conflict or a failing `migrate` after the commit are runtime states of single objects, never a
reason to roll back. A host is at revision R or R−1, never in between.

Staging runs factories against a recording `self` because a factory only declares: it returns members and calls
`self.state`, `self.get`, `self.open` and so on, and the recording tells Chord what changed (a new dependency, a native
added or removed, a member gone) before anything happens.

:::sequence animate | A reload of the notes plugin on the worker. Nothing is visible to callers until the commit.
actor app "base code" "reload control"
actor host "worker W" ""
actor objs "notes objects" "live"
app -> host: reload([notes v2], ctx)
host -> host: load bundles
host -> host: staging: setups + new factories (recording self)
host => host: commit: types, registries, contributions swapped; publication
host => objs: each follows its fate
objs --> app: resolved: { reloaded, restarted, ended, failed }
:::

:::review | Open 1: the API
Today a host has `load(facets, ctx)`, once. Proposal: `host.reload(facets, ctx)` with the plugins' new facets (by
plugin name: added, changed; a plugin missing from the list is removed), resolving with a report of what each object
did, rejecting with the code error and nothing changed. `load` stays the first call. Alternative: one
`host.load` that may be called again. Recommended: the separate `reload`, because its result differs (a report, not a
barrier) and its rollback rule does not apply to the first load (a throwing first setup closes the host).
:::

# Three Fates {#fates lede="What happens to each live object at the commit."}

The commit compares each live object's old and new declarations. **Decided** (design §21, owner 2026-10-26, the
dependency model).

| The object | Fate | Calls | Documents, jobs |
| --- | --- | --- | --- |
| pure, old and new (no `self.open`) | **swapped in place**: new methods, derives and routines; references kept, new ones made | running calls finish on old handles; new calls see new code | stay |
| has natives, old or new | **restarted**: new calls park, running calls drain (`closeTimeout`), natives close (`reload`), the new factory runs, natives reopen | park during the restart | stay; running job runs end `aborted { reload }`, `finish` runs on new code |
| its type is gone | **ended**: natives close (`end`), callers rejected, handlers drain | rejected | in-memory gone; persisted stay until retired |
| a new dependency is missing (any of the above) | **parks** (decision 4): gate closed, `failed { waiting }` | reject | stay |

```ts
// notes v1                                     // notes v2: pure, swapped in place
host.serve(NoteStore, (_, self) => {           host.serve(NoteStore, (_, self) => {
  const notes = self.state(Notes);               const notes = self.state(Notes);      // same document, v2 migrates it
  return {                                       const count = self.derive([notes], ([n]) => n.list.length);
    notes,                                       return {
    add: (a, ctx) => self.tx(…, ctx),              notes, count,                       // a new exposed member
  };                                               add: (a, ctx) => self.tx(…, ctx),
});                                                rename: (a, ctx) => self.tx(…, ctx), // a new method
                                                 };
                                               });
```

Rules that come with the fates, all **decided**:

- **R15, old code and migrated documents:** an old call that touches a document whose version rose throws once; the
  document stays intact; the call is not resent.
- **Derives** have no names: exposed derives are matched by their member name, internal ones are rebuilt.
- **Routines** hand over per object: the old ones are aborted, the new ones start once the old calls finished, bounded
  by `closeTimeout`; calls do not wait for it.
- **Instance ids:** a restarted object gets a new instance id (an old activation chain must not match it); a swapped one
  keeps it.
- **Broken objects** of a reloaded plugin are retried, as `ref.retry()` does.
- **A parked object** of a reloaded plugin is replaced by the new factory's attempt in one handover: the new requests
  bind before the old ones are released (the mechanism 7a removed comes back here).
- **In-memory documents** migrate on reload through their definition's `migrate` (6a built the version check).

:::review | Open 2: a `writable` across a pure swap
A pure swap runs the new factory, so `self.writable(initial)` makes a new writable at its initial value. An object that
contributes MCP's tool list through a writable then contributes an empty list until its restarted routine sets it again:
the tools vanish for a moment. Options: (a) accept it (the routine refills it within one call); (b) keep a writable's
value across a swap when the new factory declares a writable at the same position (as members are matched by name).
Recommended: (a); writables have no names, and position matching would be the first positional rule in Chord.
:::

# Consumers Across a Reload {#consumers lede="Holds, versions and old calls; 7a decided that nothing is ended for a code change."}

A reference on another host points at an object whose code may change under it. **Decided** (design §21, §22 and the
dependency model):

| The provider's reload | The consumer's hold | It sees |
| --- | --- | --- |
| still accepts the hold's version, object swapped | kept; re-subscribed through the version's mappings | one `[["r", value]]` per changed member |
| still accepts it, object restarted | kept | `loading`, then a fresh `bound` |
| stops accepting the version | unbound `version` | `failed { waiting }`; it binds again if a later reload accepts it |
| removes the type | unbound `not_served` | `failed { waiting }`; it binds again when the type comes back |

A provider accepts older consumers through `accepts`, written once with the provider, never in the shared contract
(Q10):

```ts
export const NotesV2 = evolve(NotesV1, (e) => e.state("editor", "notes", arr(NoteV2)).args("add", NoteV2));

host.serve(NotesV2, factory, {
  accepts: {
    1: {
      state: { editor: { notes: (current) => current.map(toV1) } },   // what a v1 tab sees, as a diff per commit
      methods: { add: { args: (old) => toV2(old) } },                 // a v1 tab's call, mapped forward
    },
  },
});
```

- **Old-version calls:** `checkArgs` returns `{ kind: "method", args, result? }` or `{ kind: "call", args, call }`; Chord
  runs the handler or the provider's replacement and maps the result back (L1 built the check; 7b invokes it).
- **Adapted bindings get diffs:** Chord keeps the last adapted value per binding and sends `diffRevisions`, so an old
  tab never receives a whole state per commit.
- **On the wire** (7b's half of 7a's model): a `failed` on a bound hold unbinds it; the provider drops its unsent
  pending work and keeps the ack slots of messages already sent; a consumer whose own code moves to a new version
  releases its old hold and makes a new one.
- **A consumer reloaded itself** gets new requests from its new factory; the handover binds them before it releases the
  old.

Today `host.serve` binds every provider with an empty accepts table (`host.ts`: `bindProvider(contract, {})`); 7b passes
the provider's table. Small and **decided** in shape (Q10, `bindProvider`); the option's place is `host.serve(Type,
factory, { accepts, linger })`.

# Jobs Across a Reload {#jobs lede="Runs belong to the object; their versions are mapped forward."}

**Decided** (design §15, owner 2026-10-24 and 2026-10-26):

```ts
const ExportJob = defineJob("notes.export", {
  version: 2,
  args: obj({ format: oneOf("md", "html") }),
  result: obj({ path: str() }),
  accepts: { 1: { args: (old) => ({ format: "md" }), result: (old) => ({ path: old.file }) } },
});
```

- A run started on an older version finishes on its old code across a pure swap; `finish` and `running` see its args
  and result mapped forwards, once per run.
- Without an adapter, or for a run of a newer version (a rollback), the run is `blocked { version }` until a reload
  brings matching code; blocked runs are retried on every reload. Nothing is aborted or discarded for a version change.
- A native restart aborts running runs (`aborted { reload }`) and `finish` runs on the new code.
- A job the new code no longer declares: its runs are `blocked { version }` (the same family), kept until a reload
  declares it again or they are aborted.
- Persisted runs of another version or fingerprint stay blocked with their record as stored, resolved by the reload
  that brings their version.

# Registries Across a Reload {#registries lede="A provider and its contributions are swapped in one batch."}

**Decided** (slice 8 §6, design §17): the commit replaces a plugin's contributions and a registry's provider in one
batch; staging composes nothing (D1). The record keeps the provider, facet contributions by plugin and object
contributions by object apart, so a reload of one plugin replaces exactly its parts (today `RegistryRecord.serve`
refuses a second serve). Older readers across a reload of the provider follow its new `accepts[old].value`. A reader
waits (7a) when the new provider no longer serves its version. `retryOn` watches are re-declared by the new factory.

# Across Hosts {#rollout lede="The same reload on every host, in an order that cannot deadlock."}

**Decided** (design §21 and the dependency model): a revision is the complete code set; the server installs first,
then workers, then clients; installs are serialized per host; a host that starts or reconnects installs the current
revision first; a revision carries a code-set digest so an unchanged server restart reinstalls nothing; an install
never waits for activations (a reverse-order rollout would deadlock); each host knows only its own install: while it
installs, holds that do not fit its running code wait `installing`, re-evaluated when the install ends; a host whose
own install was rejected fails its own requests with the reason.

:::steps | The notes contract goes from v1 to v2; the server installs first
+++ Before
S, W and T run revision R. T's notes view holds W's `Notes` v1. All live.
+++ S installs R+1
S has no notes objects of its own; its install commits. T, still on R, holds nothing on S that changed.
+++ W installs R+1 with `accepts[1]`
W's `Notes` v2 swaps in place and still accepts v1: T's hold is re-subscribed through the mapping and gets one diff.
+++ W installs R+1 without `accepts[1]`
T's hold becomes unbound `version`: `failed { waiting }`, last notes readable, calls reject with "update the page".
+++ T reloads its page
T's new code holds v2 with a new hold id; it binds; the old hold is released.
:::

:::review | Open 3: who runs the rollout
Chord's part is per host: `host.reload`, the `installing` state, and what a hold sees. The rest is distribution:
building bundles, sending them to workers, telling tabs to reload, ordering, the digest. Options: (a) Chord ships a
rollout protocol over its links (an `install` message from the server down, `installed`/`rejected` up, the digest in
`hello`); (b) distribution is the app's (p3's base code calls `host.reload` on each host and orders them), as p2 does
today (`apps/p2/src/hosts/server.ts` `performReload`: prepare every host, commit, publish bundles). Recommended: (b) for
7b, with Chord's per-host guarantees; a protocol only if a second app needs the same code.
:::

:::review | Open 4: the install watchdog (design §26 #24)
An install that hangs (a bundle that never loads, a staging factory that awaits forever, which it may not) leaves its
holds `installing` forever. Options: (a) a watchdog: `host.reload` rejects after `installTimeout` (default 60 s) and the
host stays on its old code; (b) no Chord timer: the app's context bounds the reload. Recommended: (b): `reload` takes a
context like everything else, and the app passes its deadline; a host option would be the only timer left in reload.
:::

# Loader D {#loader lede="How a plugin's new code gets into a running process."}

p2 designed it (`apps/p2/docs/plugin-loading.md` §9, §14); Chord has not built it. **Decided in p2's design:**

- **One base bundle per surface** holds every host package once: Chord, Durable, pi-ai, pi-tui, TypeBox, React and
  `react-dom`, plus the app's runtime. A change to it restarts the hosts.
- **One script per facet**, an esbuild bundle wrapped as a function of its host packages, which are external and
  passed in, so there is one Chord and one React per process:

  ```js
  // notes/worker.facet.js, built
  (require, chord, durable, react) => {
    const { defineFacet, local, str } = chord;   // the host's instance, not a copy
    /* the plugin's own files, contracts included (bundled: their versions are the plugin's) */
    return defineFacet((host, self) => { … });
  }
  ```

- **Evaluation:** `vm.Script.runInThisContext` on Node (server, workers, TUI worker), a classic `<script>` plus one CSS
  file in the browser. No module map: an old generation is closures the GC reclaims once nothing holds them.
- **Stable script names** per (facet, content digest), with V8's compilation cache off on hosts that reload in place
  (measured: every distinct compile otherwise stays in memory, +5.6 MiB per 100 compiles of 72 KB).
- **Contracts are never host packages:** each facet bundles its own contract version, or `accepts` would never apply.
- **Blockers** to solve: `instanceof` across plugins, plugin files shared between plugins (copied with their module
  state), `import.meta.url`, Node builtins through the passed `require`, CSS and wasm assets.

:::review | Open 5: where loader D lives
(a) Chord ships the facet-script format, its evaluation (Node `vm`, browser `<script>`) and an esbuild helper that
marks host packages external; an app chooses its host packages. (b) Chord knows only `host.reload(facets)`;
bundling and evaluation are entirely the app's (p3's base code). Recommended: (a): every Chord app gets live reload,
and the blockers are solved once; Chord's kernel stays free of it (a separate subpath, `@earendil-works/chord/next/loader`),
so Durable Objects, which forbid `eval`, compose statically as before.
:::

# Decisions {.epilogue lede="What is settled for the spec, and what the owner decides first."}

**Decided** (spec material): the four steps and rollback per host; the three fates and the parking of a swap with a
missing dependency; old calls on old handles (R15); derives matched by member name; the routine handover; new instance
ids on restart; broken objects retried on reload; the handover of a parked attempt; in-memory `migrate`; holds kept,
re-subscribed or freshly bound; unbound `version` and `not_served` instead of `gone`; old-version calls and adapted
bindings as diffs; `accepts` in `host.serve`; jobs' version mapping, `blocked { version }` and retries on reload, runs
aborted on a native restart; registries swapped in one batch; rollout order, serialized installs, the digest,
`installing`, installs never waiting for activations; loader D's design.

**Open** for the owner:

| # | Point | Recommended |
| --- | --- | --- |
| 1 | the API: `host.reload(facets, ctx)` returning a report, or `load` callable again | `host.reload` |
| 2 | a `writable` across a pure swap: back to its initial value, or kept by position | back to initial |
| 3 | who runs the rollout: a Chord protocol, or the app calling `host.reload` per host | the app |
| 4 | the install watchdog: a host option `installTimeout`, or the app's context | the app's context |
| 5 | where loader D lives: Chord (`chord/next/loader`), or the app | Chord |
