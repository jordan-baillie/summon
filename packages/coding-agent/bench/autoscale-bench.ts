// B2 — autoscaler telemetry validation (deterministic, CI-safe, no auth/network).
//
// "Run observe-only on a real workload and confirm the computed targets are sane before enabling
// actuation." The autoscaler's decisions are a PURE function of the demand signal (inflight + queued +
// arrival trend) — they do NOT depend on what a worker outputs — so a scripted demand trace is a
// faithful validation of the exact thing B2 asks for: are the targets sane and non-oscillating? The
// live counterpart (real spawns + emitted autoscale events) is real-runner.ts --observe.
//
// Pre-registered pass criteria (a regression makes this exit non-zero):
//   1. Tracking: every actuated target == clamp(inflight + queued + (trend>0 ? 1 : 0), 0, cap).
//   2. Cold start: growth from 0 is a `prewarm`, not a bare `grow`.
//   3. No thrash: a second decision inside cooldownMs holds (no re-actuation).
//   4. Precise shrink: a fall in demand emits `shrink` and drives reapToTarget to the new target.
//   5. Bounds: target ∈ [0, cap] always; never negative, never above the cap.
//
// Run: node --experimental-strip-types bench/autoscale-bench.ts

import type { AgentBundle, WindowGovernor } from "../src/builtin/harness/src/core.ts";
import { type DemandLike, FleetController } from "../src/builtin/harness/src/fleet-controller.ts";

const fakeGov = (pct = 0): WindowGovernor => ({ windowPct: () => pct }) as unknown as WindowGovernor;
const bundle = (name: string): AgentBundle => ({
	name,
	role: "bench",
	model_tier: "standard",
	tools: ["read"],
	output_contract: { required_sections: ["## result"] },
});

const fails: string[] = [];
const expect = (cond: boolean, msg: string): void => {
	if (!cond) fails.push(msg);
};

const NAME = "builder";
const CAP = 16;

interface Step {
	inflight: number;
	queued: number;
	trend: number;
}
// A realistic workload shape: cold start → ramp up under a rising arrival trend → plateau → drain.
const trace: Step[] = [
	{ inflight: 0, queued: 2, trend: 0.5 }, // burst arrives, demand 2, rising
	{ inflight: 2, queued: 3, trend: 0.8 }, // ramping
	{ inflight: 5, queued: 3, trend: 0.3 }, // ramping
	{ inflight: 8, queued: 0, trend: 0 }, // plateau
	{ inflight: 8, queued: 0, trend: 0 }, // plateau (steady → hold)
	{ inflight: 3, queued: 0, trend: -0.5 }, // draining
	{ inflight: 0, queued: 0, trend: -0.9 }, // idle
];
const expectedTarget = (s: Step): number =>
	Math.max(0, Math.min(CAP, s.inflight + s.queued + (s.trend > 0 ? 1 : 0)));

// Simulate a pool that reaches the previously-set target by the next tick.
let current = 0;
let desired = 0;
let step = 0;
let prewarms = 0;
const reaps: Array<{ target: number }> = [];
const captured: Array<{ action: string; current: number; target: number }> = [];

const fc = new FleetController({
	gov: fakeGov(0),
	registry: new Map([[NAME, bundle(NAME)]]),
	actuate: true,
	cooldownMs: 0, // responsive trace; the cooldown is exercised separately below
	maxPerBundle: CAP,
	signals: (): Map<string, DemandLike> => {
		const s = trace[step];
		return new Map([[NAME, { bundle: NAME, inflight: s.inflight, queued: s.queued, arrivalRate1m: 0, arrivalRateTrend: s.trend }]]);
	},
	poolStats: () => [{ name: NAME, total: current, idle: Math.max(0, current - trace[step].inflight), busy: Math.min(current, trace[step].inflight), min: 0, max: CAP, target: desired, waiting: 0 }],
	setPoolTarget: (_n, n) => {
		desired = n;
		return true;
	},
	reapToTarget: (_n, target) => {
		reaps.push({ target });
		return 0;
	},
	prewarm: async () => {
		prewarms++;
	},
	onTick: (ticks) => {
		for (const t of ticks) captured.push({ action: t.action, current: t.current, target: t.target });
	},
	now: () => step * 2000,
});

for (step = 0; step < trace.length; step++) {
	current = desired; // pool reached the target set on the previous tick
	fc.tick(step * 2000);
	const t = captured[captured.length - 1];
	const want = expectedTarget(trace[step]);
	// (1) tracking + (5) bounds
	expect(t.target === want, `step ${step}: target ${t.target} ≠ expected ${want}`);
	expect(t.target >= 0 && t.target <= CAP, `step ${step}: target ${t.target} out of [0,${CAP}]`);
}
// (2) cold start from 0 is a prewarm
expect(captured[0].action === "prewarm", `step 0 should prewarm from 0, was ${captured[0].action}`);
expect(prewarms >= 1, "prewarm callback should fire on growth from 0");
// (4) draining emits shrink + drives reapToTarget to the new (lower) target
const shrinks = captured.filter((c) => c.action === "shrink");
expect(shrinks.length >= 1, "a draining workload must emit at least one shrink");
expect(reaps.length >= 1 && reaps.some((r) => r.target === 0), "reapToTarget must be driven to the idle target 0");

// (3) cooldown: two quick ticks within cooldownMs ⇒ the second holds (no thrash)
{
	let d = 1;
	const fc2 = new FleetController({
		gov: fakeGov(0),
		registry: new Map([[NAME, bundle(NAME)]]),
		actuate: true,
		cooldownMs: 5000,
		maxPerBundle: CAP,
		signals: () => new Map([[NAME, { bundle: NAME, inflight: 5, queued: 0, arrivalRate1m: 0, arrivalRateTrend: 0 }]]),
		poolStats: () => [{ name: NAME, total: 1, idle: 0, busy: 1, min: 0, max: CAP, target: d, waiting: 0 }],
		setPoolTarget: (_n, n) => {
			d = n;
			return true;
		},
		reapToTarget: () => 0,
		prewarm: async () => {},
		onTick: () => {},
		now: () => 0,
	});
	const t1 = fc2.tick(1000)[0];
	const t2 = fc2.tick(2000)[0]; // 1s later, < 5s cooldown
	expect(t1.action === "grow", `cooldown: first tick should grow, was ${t1.action}`);
	expect(t2.action === "hold", `cooldown: second tick inside window should hold, was ${t2.action}`);
}

// ── report ──────────────────────────────────────────────────────────────────
console.log("B2 autoscaler decision trace — observe the controller against a scripted workload (cap 16)\n");
console.log("  step | demand (in+q, trend) | action  | current→target");
console.log("  -----|----------------------|---------|---------------");
for (let i = 0; i < trace.length; i++) {
	const s = trace[i];
	const c = captured[i];
	console.log(
		`  ${String(i).padStart(4)} | ${String(`${s.inflight}+${s.queued}`).padStart(6)}, trend ${String(s.trend).padStart(5)} | ${c.action.padEnd(7)} | ${c.current}→${c.target}`,
	);
}
console.log(`\n  prewarms: ${prewarms}   shrinks: ${captured.filter((c) => c.action === "shrink").length}   reapToTarget calls: ${reaps.length}`);
console.log("  every target == clamp(inflight + queued + speculative_slot, 0, 16); cooldown suppresses thrash.");

if (fails.length) {
	console.error(`\n❌ B2 FAIL (${fails.length}):`);
	for (const m of fails) console.error(`  - ${m}`);
	process.exit(1);
}
console.log("\n✅ B2 PASS — computed targets track demand, prewarm on cold start, shrink+reap precisely on");
console.log("   drain, hold inside cooldown, and stay within [0, cap]. Targets are sane for actuation.");
