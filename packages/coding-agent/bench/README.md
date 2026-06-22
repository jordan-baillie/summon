# Harness benchmarks (B1 / B2 validation gate)

These are the **committed, repeatable** validation artifacts the autoscaler roadmap (see
`docs/research/autoscaler-orchestration-plan.md`) requires **before any flag becomes default-on**. The
roadmap referenced an `bench/THRESHOLD-SWEEP` file that was never committed (cited only in code
comments); this directory is the structural replacement, so the gate is reproducible rather than
folklore.

Two layers, by design:

| File | Layer | Auth/Network | Role |
|------|-------|--------------|------|
| `pool-bench.ts` | deterministic | none | **B1 regression guard** — worker-reuse / cold-start amortization, elastic-vs-fixed collapse identity, precise shrink. Exits non-zero on regression. |
| `autoscale-bench.ts` | deterministic | none | **B2 decision guard** — controller targets track a scripted demand trace; prewarm on cold start; shrink+reap on drain; cooldown suppresses thrash; bounds. Exits non-zero on regression. |
| `real-runner.ts` | real wall-clock | $0 OAuth | **B1+B2 operator validation** — actual `summon` workers: oneshot-vs-pool wall time + a live observe-only autoscaler over the real pool. Spends (subscription, $0-marginal) tokens; **not** a CI gate. |

## Why deterministic + real

The pool optimizes **worker reuse across waves**; a real model's latency variance would swamp that
transport signal in a single run. So the *authoritative* regression guard is the deterministic
mechanics bench (fake worker, exact cold-start counts), and the real runner is an indicative
wall-clock confirmation. Likewise, the autoscaler's decisions are a **pure function of the demand
signal** (inflight + queued + arrival trend) — independent of what a worker outputs — so a scripted
demand trace is a faithful validation of "are the targets sane", and the live runner confirms the same
against real pool occupancy.

## Pre-registered pass criteria

**B1 (`pool-bench.ts`)** — fixed band `{size:N}` creates exactly `N` workers across any number of
waves (perfect reuse); `{min:N,max:N,target:N}` is byte-identical to `{size:N}` (collapse identity);
for a batch ≥ 2× the working set the pool's cold starts are strictly fewer than oneshot's, and the
savings grow with batch (the `POOL_MIN_BATCH=8` rationale); elastic grows toward `max` (not just
`target`) under whole-wave pressure but never exceeds it; `reapToTarget(k)` leaves total ≤ k.

**B2 (`autoscale-bench.ts`)** — every actuated target `== clamp(inflight + queued + (trend>0?1:0), 0,
cap)`; growth from 0 is a `prewarm`; a second decision inside `cooldownMs` holds; a fall in demand
emits `shrink` and drives `reapToTarget` to the new target; target ∈ `[0, cap]` always.

## Run

```bash
# deterministic guards (CI-safe, no auth) — these are the gate
node --experimental-strip-types bench/pool-bench.ts
node --experimental-strip-types bench/autoscale-bench.ts
npm run bench            # runs both of the above

# real wall-clock (operator validation; needs a $0 OAuth token or ANTHROPIC_API_KEY)
node --experimental-strip-types bench/real-runner.ts
```

`real-runner.ts` resolves a `$0` OAuth token from `ANTHROPIC_OAUTH_TOKEN`, else from
`~/.summon/agent/auth.json` (`anthropic.access`); it prints `SKIPPED` if neither is present.

## Recorded results

See `results/` for dated captures. Latest (2026-06-22): both deterministic guards **PASS**; the real
runner shows the warm pool at least as fast as oneshot at batch 4 (1.36×) and 8 (1.14×) — **no
throughput regression** — and the observe-only autoscaler's targets tracking real occupancy with no
oscillation. **B1 + B2 gate satisfied.** Per the roadmap, graduating any flag to default-on remains a
separate explicit decision (B3).
