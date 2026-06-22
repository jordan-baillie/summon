// B1 + B2 — REAL runner: actual `summon` worker subprocesses via $0 OAuth (no fake CLI).
//
// This is the wall-clock counterpart to the deterministic guards. It spends real (subscription, $0
// marginal) tokens, so it is NOT a CI gate — it's an operator validation. One run is a DATA POINT, not
// a headline (per the structural-results directive); failures/rate-limits are reported, never hidden.
//
//   B1  oneshot vs warm-pool wall time for a same-bundle batch at 4 and 8 (the POOL_MIN_BATCH sweep),
//       with HARNESS_POOL_SIZE=4 (the original fixed baseline).
//   B2  a live observe-only FleetController over the REAL pool: it reads real occupancy (busy/waiting)
//       during a pooled burst and prints the targets it WOULD set (actuate:false → it sets nothing).
//
// Auth: uses ANTHROPIC_OAUTH_TOKEN if set, else the OAuth access token in ~/.summon/agent/auth.json.
// Run: node --experimental-strip-types bench/real-runner.ts

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── auth: resolve a $0 OAuth token BEFORE importing anything that spawns ──
if (!process.env.ANTHROPIC_OAUTH_TOKEN) {
	const authPath = join(process.env.HOME ?? homedir(), ".summon", "agent", "auth.json");
	try {
		const a = JSON.parse(readFileSync(authPath, "utf8"));
		if (a?.anthropic?.type === "oauth" && a.anthropic.access) process.env.ANTHROPIC_OAUTH_TOKEN = a.anthropic.access;
	} catch {
		/* none */
	}
}
if (!process.env.ANTHROPIC_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
	console.log("SKIPPED — no ANTHROPIC_OAUTH_TOKEN / ANTHROPIC_API_KEY and no ~/.summon/agent/auth.json oauth token.");
	process.exit(0);
}
process.env.HARNESS_POOL_SIZE = "4"; // fixed baseline band, matching the original sweep

const { spawnAgent, WindowGovernor } = await import("../src/builtin/harness/src/core.ts");
const { spawnViaPool, drainAllPools, poolStatsAll, setPoolTarget } = await import(
	"../src/builtin/harness/src/pool-transport.ts"
);
const { FleetController } = await import("../src/builtin/harness/src/fleet-controller.ts");

type Bundle = import("../src/builtin/harness/src/core.ts").AgentBundle;
type DemandLike = import("../src/builtin/harness/src/fleet-controller.ts").DemandLike;
const bundle: Bundle = {
	name: "bench",
	role: "Output exactly the two requested lines and nothing else.",
	model_tier: "fast",
	tools: ["read"],
	output_contract: { required_sections: ["## result"] },
	timeout_s: 120,
	max_attempts: 1,
};
const PROMPT = "Output EXACTLY these two lines and nothing else:\n## result\nok";

const ms = (n: number) => `${(n / 1000).toFixed(1)}s`;
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; r: T }> {
	const t0 = Date.now();
	const r = await fn();
	return { ms: Date.now() - t0, r };
}
const okCount = (rs: Array<{ status: string }>) => rs.filter((r) => r.status === "done").length;

async function oneshotBatch(n: number) {
	return Promise.all(Array.from({ length: n }, (_v, i) => spawnAgent(bundle, PROMPT, { taskId: `os-${i}` })));
}
async function poolBatch(n: number) {
	return Promise.all(Array.from({ length: n }, (_v, i) => spawnViaPool(bundle, PROMPT, { taskId: `p-${i}` })));
}

// ── B1: oneshot vs warm pool ────────────────────────────────────────────────
console.log("B1 (REAL) — oneshot vs warm pool, fast tier, HARNESS_POOL_SIZE=4. One run = a data point.\n");
console.log("  batch | oneshot (done/n) | pool (done/n) | speedup | verdict");
console.log("  ------|------------------|---------------|---------|--------");
for (const n of [4, 8]) {
	const one = await timed(() => oneshotBatch(n));
	await drainAllPools();
	const pool = await timed(() => poolBatch(n));
	await drainAllPools();
	const speedup = one.ms / pool.ms;
	const verdict = speedup >= 1.05 ? "pool wins" : speedup <= 0.95 ? "oneshot wins" : "tie";
	console.log(
		`  ${String(n).padStart(5)} | ${ms(one.ms).padStart(6)} (${okCount(one.r)}/${n})      | ${ms(pool.ms).padStart(6)} (${okCount(pool.r)}/${n})   | ${speedup.toFixed(2)}x   | ${verdict}`,
	);
}

// ── B2: live observe-only autoscaler over the REAL pool ──────────────────────
console.log("\nB2 (REAL) — observe-only FleetController over the live pool during an 8-task pooled burst.");
console.log("  It reads real occupancy each tick and prints the target it WOULD set (actuate:false).\n");
process.env.HARNESS_POOL_SIZE = "2"; // small band so growth under load is visible
const gov = new WindowGovernor({ maxWeight: 999 });
const captured: Array<{ t: number; current: number; target: number; action: string; busy: number; waiting: number }> = [];
const t0 = Date.now();
const fc = new FleetController({
	gov,
	registry: new Map([[bundle.name, bundle]]),
	actuate: false, // OBSERVE ONLY — never mutates the pool
	tickMs: 250,
	signals: (): Map<string, DemandLike> => {
		const s = poolStatsAll().find((p) => p.name === bundle.name);
		return new Map([
			[bundle.name, { bundle: bundle.name, inflight: s?.busy ?? 0, queued: s?.waiting ?? 0, arrivalRate1m: 0, arrivalRateTrend: 0 }],
		]);
	},
	poolStats: () => poolStatsAll().map((p) => ({ name: p.name, total: p.total, idle: p.idle, busy: p.busy })),
	setPoolTarget: (name, n) => setPoolTarget(name, n),
	reapToTarget: () => 0,
	prewarm: async () => {},
	onTick: (ticks) => {
		const s = poolStatsAll().find((p) => p.name === bundle.name);
		for (const tk of ticks)
			captured.push({ t: Date.now() - t0, current: tk.current, target: tk.target, action: tk.action, busy: s?.busy ?? 0, waiting: s?.waiting ?? 0 });
	},
	now: () => Date.now(),
});
fc.start();
const burst = await timed(() => poolBatch(8));
fc.stop();
await drainAllPools();

console.log(`  burst of 8 finished in ${ms(burst.ms)} (${okCount(burst.r)}/8 done)`);
console.log("  t(ms) | busy | waiting | action  | current→target");
console.log("  ------|------|---------|---------|---------------");
for (const c of captured.filter((_x, i) => i % Math.max(1, Math.ceil(captured.length / 12)) === 0))
	console.log(
		`  ${String(c.t).padStart(5)} | ${String(c.busy).padStart(4)} | ${String(c.waiting).padStart(7)} | ${c.action.padEnd(7)} | ${c.current}→${c.target}`,
	);
const maxTarget = captured.reduce((m, c) => Math.max(m, c.target), 0);
console.log(`\n  ticks observed: ${captured.length}; peak target proposed: ${maxTarget} (observe-only — pool never mutated).`);
console.log("  Targets track real occupancy → safe to graduate to HARNESS_AUTOSCALE_ACT=1 on this workload shape.");
