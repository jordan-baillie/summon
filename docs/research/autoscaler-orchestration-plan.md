# Summon — Autoscaler & Orchestration Implementation Plan (Ideas 1–6)

> A concrete, code-level roadmap to make Summon the standout **orchestrated agent harness whose
> fleet scales itself automatically**. Every file/line reference below was verified against the
> current source. Every behavior change is flag-gated; with no new env flags set, the harness is
> byte-for-byte identical to today.

## End state

| # | Feature | Turns this... | ...into this |
|---|---------|---------------|--------------|
| 1 | **Governor signals** | a blind 200ms-poll semaphore (`core.ts:362-364`) | an instrumented FIFO admission controller exposing `queueDepth/oldestWaitMs/inUseWeight/headroom/reservedTokens` |
| 2 | **Elastic WarmPool** | a fixed `size` pool (`pool.ts:28,34`) | a `{min,max,target}` band with `setTarget()`/`reapIdle()` and scale-to-zero |
| 3 | **FleetController** | static pool size, admit() blocks forever at the budget wall | a demand-driven control loop that grows/shrinks/prewarms/sheds |
| 4 | **Scale Dial + spectacle** | a flat agent list | a governor gauge, queue meter, per-bundle pool gauges, a `/harness-scale` knob, and a frame-pure "summoning" fan-out animation |
| 5 | **Auto-Planner** | hand-authored blueprint JSON | `plan_and_run({goal})` synthesizes + validates + runs a DAG inline |
| 6 | **Best-of-N / quorum** | one attempt per task | spawn K, deterministic-verify pre-filter, judge the survivors |

**Dependency spine:** `1 → 2 → 3 → 4` (signals → elastic pool → controller → spectacle). Ideas **5**
and **6** are fully parallelizable amplifiers that depend on nothing in the spine — only on
already-shipped core surfaces (`validateBlueprint`/`runBlueprint` for 5; `withRetry`/`parseVerdict`/
`SpawnResult` for 6).

## Build philosophy

- **Strictly incremental & flag-gated.** Every PR is independently shippable and green under
  `npm run check` (biome `--error-on-warnings` + `check:ts-imports` + `check:startup-lazy` +
  `check:worker-boot` + `check:no-claude-oauth` + `tsgo --noEmit` + `check:browser-smoke`) plus the
  harness unit tests (`node --experimental-strip-types --test` over `src/builtin/harness/test/*.test.ts`)
  and vitest for suite tests.
- **Observe-only / dry-run is always the first ship.** Idea 1 keeps `reserveGate` off; idea 2
  collapses to `min=max=target=POOL_SIZE`; idea 3 only constructs the controller under
  `HARNESS_AUTOSCALE=1` and actuates only under `HARNESS_AUTOSCALE_ACT=1`; idea 4 defaults to
  `auto` (== today); idea 5 ships dry-run-only; idea 6's combinator is pure and the field/tool are additive.
- **House rules enforced throughout:** erasable TS only (explicit fields + ctor assignment, no
  `enum`/`namespace`/parameter-properties/`import=`), no inline/dynamic imports, no `any` unless
  unavoidable, DI-friendly modules (injected clock/deps), and the **TUI jitter invariants**
  (`isAnimating` untouched, timer quiesces when no agent is `running`, render is a pure function of
  `(vm, frame)`).

---

## Shared scaffolding (build these once, first)

Five ideas touch the same files; build the shared pieces before the features that consume them.

1. **Canonical agent-event vocabulary.** Lock the field names once so the emitter
   (`spawn-agent.ts` runOne emit closure `:166`) and the consumer (`observe.ts` `reduce` `:24-63` +
   `web-surface.ts snapshot()`) agree: `{ window_pct, load_pct, in_use, max_weight, queued,
   queue_depth, waited_ms }`. `reduce()` must read every field defensively (`typeof === 'number'` +
   carry-forward) so a missing field never blanks a gauge. **Emitter side (idea 1 PR2) lands before
   consumer side (idea 4).**
2. **Injectable clock convention** — `now?: () => number` defaulting to `() => Date.now()`. Idea 1
   adds it to `WindowGovernorOpts`; ideas 2 and 3 mirror it verbatim. Lets wait-latency / idle-TTL /
   cooldown math be unit-tested with an advance-the-clock fake instead of flaky real timers.
3. **Pool-transport drivable seams** — `poolStatsAll()`, `setPoolTarget(name,n)`,
   `reapPool(name,maxIdle)`, `reapAllPools(now,ttl)`. **Idea 2 owns these** (it owns the `WarmPool`
   primitives they delegate to); idea 3 imports them (its own delegation PR becomes a no-op).
4. **Reusable gauge primitive** — a pure `gauge(pct, w): string` mini-bar using the existing
   `PAL.run → PAL.fail` ramp in `observe.ts`, injected after the header rail (`~:200`) and **before**
   the `if (total === 0) return L` early-return (`~:201`) so it renders with zero agents. Owned by
   idea 4; reused by idea 3's autoscale line. Must **not** touch `isAnimating` (`:73`).
5. **ViewModel field-extension discipline** — add `governor?`, `pools?`, `autoscale?`, `burst?` as
   **optional, additive** fields to `ViewModel` (`observe.ts:16-20`) and additive `governor`/`pools`
   keys (null when absent) to `web-surface.ts snapshot()`. Every new `reduce` case mutates in place,
   returns void, and adds **no** `status:'running'` agent, so `isAnimating` stays false for
   pure-signal events.

---

## Milestones

### M0 — Spine foundations (ideas 1 + 2)
Ideas 1 and 2 have zero dependencies and own the two foundational primitives. They touch disjoint
core files (`core.ts` vs `pool.ts`), so their PR1s land in parallel.

- **1.PR1 core:** rewrite `WindowGovernor` with FIFO `waiters[]`+`enqueuedAt`, injectable clock,
  `pump()`/`makeRelease()`, reserved-token accounting (`reserveGate` default **off**), and 5 getters.
  Existing governor tests stay green **unmodified**.
- **1.PR2 extension:** wire `AdmitHooks` into runOne (`spawn-agent.ts:180`) so `queued`/`admitted`
  flow through the emit closure; pass `reserveTokens = estimateTokens(prompt.length)`; read
  `HARNESS_WINDOW_RESERVE` at the gov ctor (`:43`).
- **2.PR1 pool.ts:** `{min,max,target}` band + `idleSince` WeakMap + injectable clock; back-compat
  ctor clamp; `setTarget()`/`reapIdle()`. 7 frozen pool tests stay green.
- **2.PR2 pool-transport.ts:** `poolBand()` reading `HARNESS_POOL_MIN/MAX`; `poolFor()` passes
  `{min,max,target:min}`; export the drivable seams.

**Acceptance:** all 4 existing `WindowGovernor` tests + all 7 existing `WarmPool` tests pass
unmodified (proves zero behavior change). With no new flags: admission decisions byte-identical;
`poolFor()` reports `min===max===target===POOL_SIZE`.

### M1 — FleetController, observe-only (idea 3)
Hard-depends on 1 (signals) + 2 (`setTarget`/`reapIdle`/`poolStatsAll`). The controller file itself
(`3.PR1`) is pure-DI and can be **written in parallel** with M0, merged once M0's seams are real.

- **3.PR1** `src/fleet-controller.ts`: class + pure `computeTarget()`/`routeTransport()`/
  `degradeTier()`, coded entirely against injected `FleetControllerOpts` function members. Full DI test suite.
- **3.PR2** pool-transport delegation — **no-op if 2.PR2 shipped it**.
- **3.PR3** extension wiring (**observe-only**, `actuate:false` hardwired): construct only under
  `HARNESS_AUTOSCALE=1`; `start()` with an `.unref()`'d timer; route runOne transport through
  `fleet.routeTransport`; `fleet.stop()` in shutdown **before** `drainAllPools()`; emit `autoscale` via `onTick`.

**Acceptance:** with `HARNESS_AUTOSCALE` unset — zero new timers/emits, transport byte-identical.
With it set (observe-only) — an `autoscale` event fires every tick carrying `ControllerTick[]`, but
`setPoolTarget`/`reapPool`/`prewarm` are **never** called.

### M2 — Scale dial + elastic-fleet spectacle (idea 4)
Split so the **S-slice ships with no spine dependency** (the governor numbers are already on the wire).

- **4.PR1 (S):** `reduce()` captures `window_pct`/`load_pct` off the **existing** `spawned`/`done`
  events; render a **static** governor gauge (shared `gauge()` primitive), gated by `HARNESS_GAUGE`;
  `isAnimating` unchanged + regression test.
- **4.PR2:** web mirror — additive `governor`/`pools` keys in `snapshot()`.
- **4.PR3:** scale knob — new `src/scale.ts` (`resolveScaleMode`/`scaleParams`/`scaleLabel`,
  string-union type) + `/harness-scale` command; wire `HARNESS_SCALE` at the gov ctor.
- **4.PR4 (consumes 1+3):** `queued`/`admitted`/`scaling` cases + queue-depth meter + dual-arc gauge upgrade.
- **4.PR5 (consumes 2+3):** `pool`/`prewarm` cases + per-bundle pool panel + frame-pure tier-colored
  "summoning" streak (one per spawned agent); burst byte-stability test.

### M3 — Reliability amplifiers (ideas 5 + 6, a parallel second track)
Run fully concurrent with M0/M1/M2. Both ship their safest slice first.

- **6.PR1** core: `runQuorum` + `tallyQuorum` + `candidateKey` + `parseQuorumPick` + `QuorumOutcome`
  (pure, 10 new tests).
- **6.PR2** blueprint: `best_of?: number` on `BlueprintNode` + `validateBlueprint` `>=2` and
  XOR-with-`fan_out_from` checks.
- **6.PR3** extension: `spawn_quorum` tool + `HARNESS_QUORUM_MAX` + `quorum_decided` journaling.
- **5.PR1** blueprint pure helpers: `extractLastJsonBlock` + `parseBlueprintFromText` +
  `normalizeGeneratedBlueprint`.
- **5.PR2** dry-run-only `plan_and_run` tool (`HARNESS_PLAN_RUN` unset ⇒ execution impossible).
- **5.PR3** opt-in execution behind `HARNESS_PLAN_RUN=1`; force `requires_approval` on code nodes.
- *(optional)* **6.PR4** route blueprint `best_of` nodes through quorum; **5.PR4** persist generated
  blueprint for cross-process resume.

---

## Per-idea detail

### Idea 1 — Governor signals (effort M)

**Goal:** turn the blind 200ms-poll semaphore (`core.ts:362-364`,
`while (!hasHeadroom(w)) await sleep(200)`) into an instrumented controller exposing live
load/queue/reservation signals. **The admission *decision* stays byte-for-byte unchanged**; only
observability + an internal reserved-token reconciliation (default-off gate, default-on surface) is added.

**Files:** `core.ts` (WindowGovernor rewrite), `spawn-agent.ts` (admit hooks in runOne),
`observe.ts` (optional: capture into `vm.governor`).

```ts
// core.ts
export interface WindowGovernorOpts {
  maxWeight?: number; windowMs?: number; budgetTokens?: number; // 0 => tracking only
  now?: () => number;       // injectable clock; default () => Date.now()
  reserveGate?: boolean;    // true => reserved tokens count toward the window gate (default false = no change)
}
export interface AdmitHooks {            // lets dep-free core surface events WITHOUT importing the bus
  onQueued?: (info: { queueDepth: number; w: number }) => void;
  onAdmitted?: (info: { waitedMs: number; w: number }) => void;
  reserveTokens?: number;                // approximate pre-admission estimate, reconciled on release
}
class WindowGovernor {
  private waiters: Array<{ w: number; enqueuedAt: number; resolve: () => void }> = [];
  private reserved = 0;
  // hasHeadroom: window check becomes consumed() + (reserveGate ? reserved : 0) >= budgetTokens
  // admit(b, hooks?): fast path if hasHeadroom (no queue, no event); else push waiter + await;
  //   pump() resolves the FRONT waiter that now fits (FIFO head-of-line) and owns its inUse += w.
  async admit(b: AgentBundle, hooks?: AdmitHooks): Promise<() => void>;
  queueDepth(): number; oldestWaitMs(now?: number): number;
  inUseWeight(): number; headroom(): number; reservedTokens(): number;
}
```

**Critical correctness note:** `pump()` does `this.inUse += w` synchronously before `resolve()`; the
queued branch of `admit()` must **not** re-add `inUse` (the classic double-count bug). Locked by a new
`headroom/inUseWeight` occupancy test.

**Wiring (`spawn-agent.ts` runOne, replace `:180`):**
```ts
const reserve = estimateTokens(prompt.length);            // input-only proxy, documented approximate
const release = await gov.admit(b, {
  reserveTokens: reserve,
  onQueued:   (i) => emit({ t: "queued",   queue_depth: i.queueDepth, window_pct: gov.windowPct(), load_pct: gov.loadPct() }),
  onAdmitted: (i) => emit({ t: "admitted", waited_ms: i.waitedMs,     window_pct: gov.windowPct(), load_pct: gov.loadPct() }),
});
// reservation auto-reconciled inside makeRelease() when release() runs in the existing finally (:220-222)
```

**Tests:** existing `core.test.ts:563/584/597/603` pass **unmodified** (the regression guard for
unchanged admission timing); new cases: queue depth + oldest-wait with injected clock, FIFO order,
`waited_ms` measurement, reserve/reconcile (with `reserveGate` on *and* off), headroom occupancy; an
`observe.test.ts` case asserting `queued` does **not** flip `isAnimating`.

**Env:** `HARNESS_WINDOW_RESERVE=1` ⇒ `reserveGate:true` (default off ⇒ reserved surfaced but never
gates). Meaningless when `HARNESS_WINDOW_TOKENS=0` (the safe default).

---

### Idea 2 — Elastic WarmPool (effort M)

**Goal:** make `WarmPool` elastically sizable while preserving exact current semantics when
`min=max=POOL_SIZE`. No controller — the pool becomes **drivable**.

**Files:** `pool.ts` (elastic rewrite), `pool-transport.ts` (band + drivable seams).

```ts
// pool.ts
export interface PoolStats { total: number; idle: number; busy: number;
  min: number; max: number; target: number; waiting: number; } // waiting = acquire-pressure signal
// WarmPool: remove `private size`; add private min/max/target/now + idleSince = new WeakMap<W,number>()
constructor(factory: WorkerFactory<W>,
  opts: { size?: number; min?: number; max?: number; target?: number; now?: () => number } = {});
// back-compat clamp: {size:N} alone => min=max=target=N (byte-identical to today)
setTarget(n: number): void;                                   // clamps to [min,max]; lazy grow, no eager spawn
async reapIdle(now: number, ttlMs: number): Promise<number>;  // destroys idle workers > min, older than ttl; never busy; no-op while draining
```
- `acquire()` grow-gate (`:62`) becomes: `ceiling = waiters.length > 0 ? max : target` — normal
  demand grows toward `target`, acquire pressure escalates to `max`. Collapses to today's behavior
  when `min=max=target`.
- `release()` park-as-idle branch (`:92`) stamps `idleSince.set(w, now())`.
- `reapIdle` body is **fully synchronous** between snapshot and idle-array mutation → JS single-thread
  serializes reap vs acquire; it filters every idle worker by its own `idleSince` (no ordering reliance).

```ts
// pool-transport.ts
const poolBand = (): { min: number; max: number };           // HARNESS_POOL_SIZE / _MIN / _MAX
export function poolStatsAll(): Array<{ name: string } & PoolStats>;
export function reapAllPools(now: number, ttlMs: number): Promise<number[]>;
export function setPoolTarget(name: string, n: number): boolean;
export function reapPool(name: string, maxIdle: number): number;
```

**Tests (extend `pool.test.ts`, reuse FakeWorker/FakeFactory):** behavior-identical with `{size:N}`;
grow-toward-target; acquire-pressure-to-max; reap-above-min-after-ttl; never-reap-busy;
scale-to-zero (`min:0`); ttl respected; no-op while draining. `pool-transport.test.ts`: default-env
identity, env-override parse, registry iteration. **`RpcWorker` and `PooledWorker` stay untouched**
(timestamps live in the pool's WeakMap).

**Env:** `HARNESS_POOL_MIN` (default `HARNESS_POOL_SIZE`; `0` ⇒ scale-to-zero), `HARNESS_POOL_MAX`
(default `HARNESS_POOL_SIZE`).

---

### Idea 3 — FleetController (effort L)

**Goal:** a single in-process control loop that grows/shrinks each bundle's pool to observed demand,
prewarms rising-demand bundles, routes pool-vs-oneshot on live saturation (replacing the hardcoded
`POOL_MIN_BATCH=8` heuristic), and **degrades gracefully** (downshift tier, cap retries, emit
`shedding`) instead of blocking forever in `admit()`. **Observe-only by default.**

**Files:** new `src/fleet-controller.ts`; `spawn-agent.ts` (construct + wire); `pool-transport.ts`
(delegation, no-op if idea 2 shipped it); `observe.ts` (surface `autoscale`).

```ts
// src/fleet-controller.ts — dependency-light; all collaborators injected (offline-testable)
export interface ControllerTick { bundle: string; current: number; target: number;
  action: "grow" | "shrink" | "hold" | "reap" | "prewarm"; reason: string; }
export interface FleetControllerOpts {
  gov: WindowGovernor; registry: Map<string, AgentBundle>;
  actuate?: boolean;        // false = OBSERVE-ONLY (default)
  tickMs?: number;          // 2000
  maxPerBundle?: number;    // hard cap, 16
  cooldownMs?: number;      // anti-thrash, 5000
  idleReapMs?: number;      // 30000
  shedAtPct?: number;       // 90
  signals: (now?: number) => Map<string, DemandLike>;        // idea 1 demand snapshot
  poolStats: () => Array<PoolStatLike>;                       // idea 2 poolStatsAll
  setPoolTarget: (name: string, n: number) => boolean;       // idea 2
  reapPool: (name: string, maxIdle: number) => number;       // idea 2
  prewarm: (b: AgentBundle) => Promise<unknown>;
  onTick: (ticks: ControllerTick[]) => void;                 // log/emit sink
  now?: () => number;
}
export class FleetController {
  start(): void;   // setInterval(tickMs).unref(); idempotent
  stop(): void;
  tick(now?: number): ControllerTick[];        // compute + onTick; actuate only if this.actuate
  routeTransport(agent: string): "oneshot" | "pool";
  shouldShed(b: AgentBundle): ShedDecision;
  onAgentEvent(e: { t: string; agent?: string }): void;      // event-driven scale-up nudge
}
// PURE helpers (top-level, individually tested):
export function computeTarget(d: DemandLike, current: number, max: number): number; // inflight+queued (+1 if rising), clamp [0,max]
export function routeTransport(s: PoolStatLike | null, d: DemandLike | null): "oneshot" | "pool";
export function degradeTier(tier: AgentBundle["model_tier"]): AgentBundle["model_tier"]; // frontier->standard->fast
```

**Anti-thrash:** per-bundle `cooldownMs` gate in `apply()`; `computeTarget` uses occupancy
(`inflight+queued`), not instantaneous rate, so it settles. **Anti-leak:** `.unref()`'d timer;
`fleet.stop()` before `drainAllPools()`; `reapIdle` never touches busy; `setTarget` clamps `>= min`.

**Tests:** new `fleet-controller.test.ts` (fully DI, no pools/subprocess): every pure helper +
observe-only-vs-actuate + hysteresis + cap + shrink-reaps + shouldShed + `start/stop` unref lifecycle.
`observe.test.ts`: `autoscale` event populates `vm.autoscale` without flipping `isAnimating`.

**Env:** `HARNESS_AUTOSCALE=1` (arm, observe-only), `HARNESS_AUTOSCALE_ACT=1` (actuate),
`HARNESS_AUTOSCALE_TICK_MS` (2000), `HARNESS_AUTOSCALE_MAX` (16), `HARNESS_AUTOSCALE_SHED_PCT` (90).

---

### Idea 4 — Scale Dial + TUI spectacle (effort L; S-slice ships first)

**Goal:** one knob to bias the fleet (throughput↔cost) and make scaling **legible in real time**
without breaking jitter invariants. The governor numbers (`window_pct`/`load_pct`) are *already*
emitted at `spawn-agent.ts:181/215` but **dropped** by `observe.ts reduce()` — capturing them is the
free S-slice.

**Files:** `observe.ts` (capture + render), `web-surface.ts` (mirror), `extension/observe.ts`
(`/harness-scale`), `spawn-agent.ts` (knob→params), new `src/scale.ts`.

```ts
// observe.ts
export interface GovernorView { windowPct: number; loadPct: number;
  inUse?: number; maxWeight?: number; queued?: number; }
export interface PoolGaugeView { name: string; total: number; idle: number; busy: number; draining?: boolean; }
// ViewModel gains: governor?: GovernorView; pools?: PoolGaugeView[]; burst?: { sinceFrame: number; count: number };
// new gauge(pct, w): string mini-bar; injected after header rail (:200) BEFORE `if (total===0) return L` (:201)

// src/scale.ts — pure, Pi-free (discriminated string-union, NO enum)
export type ScaleMode = { kind: "auto" } | { kind: "eco" } | { kind: "turbo" } | { kind: "fixed"; band: number };
export function resolveScaleMode(raw?: string): ScaleMode;
export function scaleParams(mode: ScaleMode, base: { maxWeight: number; budgetTokens?: number; poolSize?: number }): FleetParams;
export function scaleLabel(mode: ScaleMode): string;
```
- **Capture** (mutate `spawned`/`done` cases): `vm.governor` reads each field defensively with
  carry-forward so a rename or missing field never blanks the gauge.
- **Summoning fan-out:** when `vm.burst` is active, overlay a tier-colored gradient streak whose
  column is a **pure function of `frame`** (byte-stable). Renders only while an agent is running, so
  the timer is already live — `isAnimating` stays untouched.
- **`/harness-scale`** mirrors the existing `registerCommand` pattern (`/harness-web`, `/harness-drill`);
  it parses `auto|eco|turbo|fixed:N|show`, emits a synthetic `scaling` event, calls `requestRender()`
  once — **no new `setInterval`**.

**Tests:** governor capture + carry-forward, queue depth from `queued`/`admitted`, pool-gauge
populate, **gauge renders with zero agents**, **`isAnimating` unchanged**, **fan-out byte-stable for
identical `(vm, frame)`**, `scale.ts` parse/mapping, web snapshot mirror.

**Env:** `HARNESS_SCALE=auto|eco|turbo|fixed:N` (default `auto` == today), `HARNESS_GAUGE` (kill-switch).

---

### Idea 5 — Auto-Planner `plan_and_run({goal})` (effort M)

**Goal:** synthesize a validated, runnable DAG from a goal and execute it through the
**already-durable** blueprint engine — never writing JSON to disk. `validateBlueprint(bp, registry)`
(`blueprint.ts:109`) and `runBlueprint` (`:226`) already take a **plain object**, so generated DAGs
run through the exact same path. **Ship dry-run-only first.**

**Files:** `blueprint.ts` (pure helpers), `spawn-agent.ts` (the tool).

```ts
// blueprint.ts — pure, dep-free
export function extractLastJsonBlock(text: string): string | null;       // last ```json fence; fallback to last balanced {...} (string-aware)
export function parseBlueprintFromText(text: string): { bp?: Blueprint; error?: string };
export interface NormalizeOpts { maxNodes: number; fanOutCap: number; forceApprovalOnWrite: boolean }
export function normalizeGeneratedBlueprint(bp: Blueprint, opts: NormalizeOpts): { bp: Blueprint; notes: string[] };
// rejects > maxNodes BEFORE validation; clamps every fan_out_limit; forces requires_approval on CODE nodes; deep-clones (never mutates input)

// spawn-agent.ts (after run_blueprint block, :528)
function makePlannerBundle(): AgentBundle;  // frontier, read-only tools, may_spawn:false, contract requires a ```json section, max_attempts:1
async function planAndRun(goal, vars, ctx, dryRun): Promise<{ content; details; isError }>;
// withRetry(2): spawn planner -> parseBlueprintFromText(artifact) -> normalize -> validateBlueprint;
//   on parse/validate failure, feed the validator message back via retryPrompt; fail-closed (never run garbage).
// dry_run: render the validated DAG, ZERO execution. live (HARNESS_PLAN_RUN=1 only):
//   startRun('blueprint', name, { vars, generated:true }) -> executeBlueprint -> renderBlueprint (identical to run_blueprint).
```
The planner bundle is read-only + `may_spawn:false` (passes `validateBundle`, can never delegate);
frontier maps to `MODEL.frontier`. Set `max_attempts:1` so the **outer** `withRetry(2)` owns the
parse/validate retry exclusively (no double retry).

**Tests:** `blueprint.test.ts` — last-fence extraction, balanced-brace fallback (incl. braces inside
quoted strings), parse errors, non-object rejection, node-cap throw, fan_out clamp + no-mutation,
code-node approval forcing, **normalized → validated → `runBlueprint` round-trip** (offline,
`recordingExec`). FAUX-provider suite regression: `dry_run:true` returns the DAG with **no `spawned`
event for real nodes and no `events.jsonl` written**.

**Env:** `HARNESS_PLAN_RUN=1` (enable execution; default ⇒ dry forced true even if caller passes
`dry_run:false`), `HARNESS_PLAN_MAX_NODES` (24), `HARNESS_PLAN_FANOUT_CAP` (20).

**Known v1 limit:** generated DAGs aren't on disk, so cross-process crash-resume (`resumeRun` reloads
by name) is unsupported — within-process `approve_gate` resume works. Persisting generated bp into
`run_started` meta is a documented follow-up (5.PR4).

---

### Idea 6 — Best-of-N / quorum (effort M)

**Goal:** spawn K candidate attempts, **discard the ones that fail deterministic verify/contract**,
pick a winner by objective majority vote when candidates converge, fall back to an LLM judge over the
survivors only when they diverge. The verify+contract pre-filter is *already free*: `finalizeResult`
(`core.ts:520-542`) sets `status==="done"` only when `code===0 && contract.passed`, flipping to
`verify_failed` if a supplied verify fails — so `survivors = results.filter(r => r.status==='done')`.

**Files:** `core.ts` (pure combinator), `spawn-agent.ts` (`spawn_quorum` tool), `blueprint.ts`
(`best_of` field + validation), `session.ts` (`quorum_decided` event).

```ts
// core.ts (insert after runWithReview, :721)
export interface QuorumOutcome {
  winner?: SpawnResult; ranking: SpawnResult[]; survivors: SpawnResult[];
  agreement: "majority" | "judged" | "none"; decidedBy: "vote" | "judge" | "no-survivor";
  groupSize?: number; judge?: SpawnResult;
}
export function candidateKey(r: SpawnResult): string;        // whitespace-collapsed text identity (APPROXIMATE)
export function tallyQuorum(results: SpawnResult[]): { groups: Map<string, SpawnResult[]>; survivors: SpawnResult[] };
export function parseQuorumPick(text: string, n: number): number | undefined; // "## verdict\nAPPROVE candidate 2" -> 2, bounds-checked
export async function runQuorum(
  candidates: Array<() => Promise<SpawnResult>>,
  judge: (survivors: SpawnResult[]) => Promise<SpawnResult>,
  opts?: { maxN?: number },
): Promise<QuorumOutcome>;
// majority = winning identical-output group > survivors/2 (strict) -> vote; else judge over survivors,
//   parse pick, FAIL-SAFE to survivors[0] if unparseable (every survivor already passed verify+contract).
```
- **`spawn_quorum` tool:** `N = min(QUORUM_MAX, max(2, n ?? 3))`; builds `N` `runOne` closures each
  with a `## VARIANT SEED i` divergence nudge (no model seed param exists — documented approximate);
  judge closure runs `reviewer` (or `judge` arg) over `quorumPrompt(survivors)`. **Each candidate is a
  normal `runOne` → flows through the existing `gov.admit`**, so the fleet self-throttles. Journals
  `quorum_decided`.
- **Blueprint:** `best_of?: number` on `BlueprintNode` (`:36`); `validateBlueprint` agent branch
  (`:128-141`) enforces integer `>= 2` and **XOR with `fan_out_from`** (quorum = one prompt K times;
  fan-out = K prompts once). The exec wiring (optional 6.PR4) lives in the extension's `blueprintExec`
  — `runBlueprint` core untouched, so `teams.ts` is unaffected.

**Tests:** `core.test.ts` — 10 cases (unanimous → vote; 2-of-3 → vote; filter failed before vote;
no-majority → judge picks; unparseable verdict → fail-safe to first survivor; all-fail → undefined;
throwing closure captured; `maxN` cap; `parseQuorumPick` bounds; `candidateKey` whitespace).
`blueprint.test.ts` — `best_of<2` rejected, `best_of`+`fan_out_from` rejected, valid `best_of:3`
passes. FAUX suite regression: `QUORUM: majority via vote` (identical outputs) and `via judge` (divergent).

**Env:** `HARNESS_QUORUM_MAX` (3, floored at 2). The pure `runQuorum` takes `maxN` via opts (env-free).

---

## File-conflict map (the hotspots)

| File | Touched by | Guidance |
|------|-----------|----------|
| `core.ts` | 1 (WindowGovernor rewrite `:305-370`), 6 (insert after `runWithReview` `~:721`) | **Disjoint regions.** Either order; idea 6's insert anchor (after `runWithReview`) is stable. Keep core dep-free in both (idea 1 emits via injected hooks, not the bus). |
| `pool.ts` | 2 only | Single owner. Land the "behavior identical" test first. |
| `pool-transport.ts` | 2 (owns the seams), 3 (no-op if 2 shipped) | **Idea 2 owns** `poolStatsAll`/`setPoolTarget`/`reapPool`. Land 2.PR2 first; coordinate exact signatures up front. |
| `spawn-agent.ts` | **1, 3, 4, 5, 6** (hottest) | **Land idea 1's runOne admit-hook (`:180`) + gov ctor (`:43`) FIRST** so 3/4 layer onto established field names. Merge all gov-ctor flags into one `new WindowGovernor({...})`. Ideas 5/6 are **append-only** new `registerTool` blocks (after `:528`/`:326`) — interleave freely. |
| `observe.ts` | 1 (optional), 3 (`autoscale`), 4 (owns rendering) | **Idea 4 owns all rendering + the governor/queue cases; drop idea 1's optional observe PR.** Idea 3 adds only the disjoint `autoscale` case. Every new case: mutate-in-place, return void, no running agent, **don't touch `isAnimating`** — assert it in each test. |
| `blueprint.ts` | 5 (parse helpers after `:65`), 6 (`best_of` + validate `:128-141`) | Different regions, low collision. Idea 5's normalizer runs **before** `validateBlueprint`; idea 6's check runs **inside** it. |
| `web-surface.ts` | 4 only | Additive `governor`/`pools` keys (null when absent); extend the existing snapshot test, don't replace. |
| `session.ts` | 6 only | Append `quorum_decided` to the `RunEventType` union; `deriveState` no-ops unknown types (non-breaking). |

## Global test strategy

1. **Unit (offline, DI)** — `node --experimental-strip-types --test` over `harness/test/*.test.ts`.
   Inject fakes + a mutable closure clock; never spawn subprocesses or hit real timers. The frozen
   regression guards: 4 `WindowGovernor` tests + 7 `WarmPool` tests stay green unmodified.
2. **Suite (faux provider, vitest)** — `test/suite/harness.ts` + the FAUX provider, regressions under
   `test/suite/regressions/`. Used where behavior depends on real extension wiring (idea 5 dry-run +
   approval-gate; idea 6 quorum vote/judge; idea 3 burst grow/reap).
3. **Bench (pool regression)** — re-run the existing `bench/` after idea 2's pool and idea 3's
   `routeTransport` changes to confirm no throughput regression vs the fixed-size baseline (the
   `POOL_MIN_BATCH=8` threshold came from `bench/THRESHOLD-SWEEP`). Record results before flipping any default-on.

**Gate:** every PR runs `npm run check` + the harness unit tests + vitest for any suite test. Keep all
imports top-level (`check:ts-imports`); avoid heavy top-level work in worker-boot paths
(`check:startup-lazy`/`check:worker-boot`). Never edit `models.generated.ts`.

## Rollout & flags

Ship every flag **off**. Enable in order of confidence:

`HARNESS_GAUGE` / `HARNESS_SCALE=auto` (visual only) → `HARNESS_AUTOSCALE=1` (observe-only telemetry)
→ *validate targets + re-run pool bench* → `HARNESS_AUTOSCALE_ACT=1` (actuation) →
`HARNESS_POOL_MIN/MAX` bands → `HARNESS_PLAN_RUN` / `HARNESS_WINDOW_RESERVE` (highest-impact) last,
per-operator. **No flag becomes default-on in this roadmap** — that's a separate decision after bench
+ telemetry sign-off.

| Flag | Default | Effect |
|------|---------|--------|
| `HARNESS_WINDOW_RESERVE` | off | reserved tokens count toward the window gate (else surfaced only) |
| `HARNESS_POOL_MIN` / `HARNESS_POOL_MAX` | `=POOL_SIZE` | elastic band; `MIN=0` ⇒ scale-to-zero |
| `HARNESS_AUTOSCALE` | off | arm FleetController (observe-only) |
| `HARNESS_AUTOSCALE_ACT` | off | enable actuation |
| `HARNESS_AUTOSCALE_TICK_MS` / `_MAX` / `_SHED_PCT` | 2000 / 16 / 90 | controller tuning |
| `HARNESS_SCALE` | `auto` | `auto\|eco\|turbo\|fixed:N` |
| `HARNESS_GAUGE` | on | governor-gauge kill-switch |
| `HARNESS_PLAN_RUN` | off | enable inline DAG execution (else dry-run-only) |
| `HARNESS_PLAN_MAX_NODES` / `_FANOUT_CAP` | 24 / 20 | planner safety caps |
| `HARNESS_QUORUM_MAX` | 3 | candidate cap |

## Risk register (cross-cutting)

- **Oscillation/thrash** → per-bundle `cooldownMs` + occupancy-based `computeTarget` + observe-only default.
- **Subprocess leaks / mid-task reaps** → `.unref()`'d timer, `fleet.stop()` before `drainAllPools()`,
  `reapIdle` never touches busy, `setTarget` clamps `>= min`.
- **Token blow-up** (quorum N×, best_of, planner spawn) → `HARNESS_QUORUM_MAX`, every candidate
  through `gov.admit`, planner is one frontier spawn through the governor.
- **Jitter regression** → `isAnimating` byte-unchanged; all new cases add no running agent; each idea
  ships an explicit "isAnimating stays false" + render byte-stability test.
- **Planner pathological DAGs** → `normalizeGeneratedBlueprint` caps before validation; the existing
  `validateBlueprint` (Kahn acyclicity, XOR, unknown-agent, `may_spawn` rejection, destructive-cmd
  block) is the single gate; execution off by default; code nodes force `requires_approval`.
- **Admission ordering change** (poll → FIFO) → strict fairness improvement; the only existing
  assertions are single-waiter/order-agnostic; `pump()` owns the queued `inUse` increment (no double-count).

## Sequencing notes

**Critical path (serial):** `1.PR1 → 1.PR2 → 3.PR1/3.PR3 → 4.PR4/4.PR5`. Idea 2 (`2.PR1`+`2.PR2`) is
on idea 3's critical path but **independent of idea 1** — so `1.PR1` and `2.PR1` land fully in
parallel (disjoint files). Convergence is `3.PR3`, which needs both idea-1 signals and idea-2 seams live.

**Parallelizable second track:** ideas 5 and 6 depend on nothing in the spine — run them fully
concurrent with M0/M1/M2. They share `spawn-agent.ts` (append-only tools) and `blueprint.ts`
(disjoint regions) with the spine — only import-line/offset merges, no logic collisions.

**Early win:** idea 4's S-slice (`4.PR1-PR3`) has no spine dependency — the governor numbers are
already on the wire — so an operator-visible gauge + scale knob can land **alongside M0**.

**Write-ahead:** `3.PR1` (the pure-DI FleetController file) compiles + unit-tests against fakes the
moment it exists; write/review it in parallel with M0, merge once M0's seams are real.

**Do-first in every spine PR:** land the "behavior identical with defaults" test **before** touching
logic (idea 1: the 4 existing governor tests; idea 2: the 7 frozen pool tests + the
`min=max=target` identity test) so any accidental drift fails immediately.

## Completion status — deferred slices closed (follow-up after `ad289ab6`)

The slices consciously deferred in the first landing are now implemented (all still **off by default**;
no flag flipped on). Each shipped with offline unit tests **plus** a real end-to-end test through the
subprocess boundary.

| Slice | What landed | Seam | Tests |
|-------|-------------|------|-------|
| **A1** load-shed actuation | `runOne` now threads an **effective bundle** `eb` (a tier-downshifted clone) through cache-key, `gov.admit` weight, exec, the `spawned` event, and the ledger when `shouldShed` fires under actuation; emits a `shedding` event and **forces oneshot** (a degraded-tier worker must never poison the name-keyed warm pool) | `extension/spawn-agent.ts` | `spawn-e2e` shedding case + `observe`/`web-surface` visibility |
| **A2** summoning streak | `summonStreak(count, frame)` — a byte-stable, per-running-agent gradient streak on the header rail; pure `f(count,frame)`, painted only while `run>0` so `isAnimating`/jitter invariants hold | `src/observe.ts` | `observe.test.ts` (purity + quiesce) |
| **A3** generated-DAG resume | `RunMeta` carries `generated` + the embedded `blueprint`; `plan_and_run` persists the DAG into `run_started`; `resumeRun` reconstructs from meta instead of `loadBlueprints` for generated runs | `src/runstore.ts`, `extension/spawn-agent.ts` | `runstore.test.ts` round-trip + `spawn-e2e` cross-process resume |
| **A4** e2e suite | scripted `fixtures/fake-cli.mjs` (NDJSON `message_end`; json + rpc modes) as `SUMMON_BIN`; drives the real extension tools through real spawns with no provider/auth | `test/fixtures/`, `test/spawn-e2e.test.ts` | spawn_agent / spawn_quorum / plan_and_run (dry+live) / resume / shedding |
| **A5** web signals | `snapshot()` adds `shed`/`burst`; `renderDashboardHtml` renders governor gauges + a fleet (autoscaler-decisions) table + shed/summoned tallies | `src/web-surface.ts` | `web-surface.test.ts` |
| **A6** arrival signal | new pure `ArrivalTracker` (rolling 1m/5m rates + trend, order-independent counting); `fleetSignals` feeds real `arrivalRate1m`/`arrivalRateTrend` so `computeTarget`'s speculative slot + prewarm-on-rising-demand actually fire | `src/arrivals.ts`, `extension/spawn-agent.ts` | `arrivals.test.ts` |
| **A7** precise shrink + runtime band | `WarmPool.reapToTarget(n)` (exact, TTL-agnostic shrink) + `WarmPool.setBand(min,max)`; transport `reapToTarget`/`setPoolBand` (live override applied to all pools); the controller injection renamed `reapPool(maxIdle)` → **`reapToTarget(target)`** (kills the misleading name); `/harness-scale` retunes the live pool band, single-sourcing the per-bundle ceiling | `src/pool.ts`, `src/pool-transport.ts`, `src/fleet-controller.ts`, `extension/spawn-agent.ts` | `pool.test.ts`, `pool-transport.test.ts`, `fleet-controller.test.ts` |

**OAuth routing (operator note).** Every spawned worker — including the new `spawn_quorum`,
`plan_and_run`, and shed/oneshot paths — funnels through the single `buildWorkerArgs` →
`buildSystemPrompt` (always prefixed with `SYS_HEADER` = *"You are Claude Code, Anthropic's official
CLI for Claude."*) and the fail-closed `assertSpawnAuth`. So $0-Max OAuth routing is **structural and
single-sourced** — a new tool cannot bypass it. Forced-subscription deployments set
`SUMMON_FORCE_OAUTH_ROUTING=1` to eject any `ANTHROPIC_API_KEY` and fail closed if one survives.

### Validation gate — B1 / B2 done, B3 decision (2026-06-22)

The referenced `bench/THRESHOLD-SWEEP` file never existed (cited only in comments). Structural fix: a
committed, repeatable benchmark suite under `packages/coding-agent/bench/` (see its `README.md`) with
two layers — deterministic guards (CI-safe, exit non-zero on regression, wired into `npm run bench` /
`npm test`) and a real `$0`-OAuth wall-clock runner. Recorded results in `bench/results/2026-06-22-*`.

- **B1 (pool regression) — PASS.** `pool-bench.ts`: fixed band creates exactly N workers across waves
  (perfect reuse); `{min:N,max:N,target:N}` is byte-identical to `{size:N}` (collapse identity); at
  batch ≥ 2× working set the pool cuts cold starts 50%/75%/88% at 8/16/32 (the `POOL_MIN_BATCH=8`
  rationale, reproduced); elastic grows toward `max` under pressure but never past it; `reapToTarget`
  precise. Real runner (haiku, `HARNESS_POOL_SIZE=4`): warm pool ≥ oneshot at batch 4 (1.36×) and 8
  (1.14×), 12/12 done — **no throughput regression** vs the fixed-size baseline.
- **B2 (observe-only telemetry) — PASS.** `autoscale-bench.ts`: every target == `clamp(inflight +
  queued + speculative_slot, 0, cap)`, prewarm on cold start, precise shrink+reap on drain, cooldown
  suppresses thrash. Real observe-only run over the live pool: targets tracked actual occupancy
  (busy 8 ⇒ target 8, drained precisely), no oscillation.
- **B3 — defaults stay OFF.** The gate is satisfied, but per the operator directive a single real run
  is a data point, not a mandate; flipping any flag to default-on is a **separate explicit decision**,
  not taken here. Recommended graduation path once an operator signs off: `HARNESS_SCALE=auto` (visual)
  → `HARNESS_AUTOSCALE=1` (observe-only on the operator's real workload) → `HARNESS_AUTOSCALE_ACT=1`.
  Nothing in this change enables any of them by default.
