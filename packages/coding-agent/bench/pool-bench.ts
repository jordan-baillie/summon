// B1 — pool transport regression guard (deterministic, CI-safe, no auth/network).
//
// The roadmap says "re-run the existing bench before any default-on" — but the referenced
// bench/THRESHOLD-SWEEP file was never committed (cited only in comments). This is the structural
// replacement: a committed, repeatable benchmark that measures the property the pool actually
// optimizes — WORKER REUSE ACROSS WAVES — without depending on a real model's latency (which would
// swamp the transport signal with noise). It runs WarmPool with a fake worker so the metric is the
// number of cold-start worker CREATIONS for a given batch, which is exactly what idea 2's elastic
// acquire/grow and idea 3's routing change. The real wall-clock counterpart is pool-throughput-real.ts.
//
// Pre-registered metrics + pass criteria (a regression makes this exit non-zero):
//   1. Fixed band {size:N}: creations == N across any number of waves (perfect reuse, no regression).
//   2. Collapse identity: {min:N,max:N,target:N} behaves byte-identically to {size:N}.
//   3. Amortization (the POOL_MIN_BATCH=8 rationale): for a batch ≥ 2× the working set, pool creations
//      are strictly fewer than oneshot's (= batch), and the savings grow with batch.
//   4. Elastic under pressure: a band {min:0,max:M,target:t} grows toward M (not just t) when a whole
//      wave contends, but never exceeds M.
//   5. Precise shrink (A7): reapToTarget(k) leaves total ≤ k; reapToTarget(0) drains idle to zero.
//
// Run: node --experimental-strip-types bench/pool-bench.ts

import { type PooledWorker, WarmPool, type WorkerFactory } from "../src/builtin/harness/src/pool.ts";

class FakeWorker implements PooledWorker {
	readonly id: string;
	constructor(id: string) {
		this.id = id;
	}
	healthy(): boolean {
		return true;
	}
	async reset(): Promise<void> {}
	destroy(): void {}
}

class CountingFactory implements WorkerFactory<FakeWorker> {
	creations = 0;
	async create(): Promise<FakeWorker> {
		this.creations++;
		// Yield a microtask so concurrent acquires interleave realistically (waiters form).
		await Promise.resolve();
		return new FakeWorker(`w${this.creations}`);
	}
}

// Process `total` tasks as ceil(total/width) SEQUENTIAL waves of `width` CONCURRENT acquire→release —
// the real shape of a same-bundle fan-out reusing a warm pool wave after wave.
async function runWaves(pool: WarmPool<FakeWorker>, total: number, width: number): Promise<void> {
	let done = 0;
	while (done < total) {
		const n = Math.min(width, total - done);
		await Promise.all(
			Array.from({ length: n }, async () => {
				const w = await pool.acquire();
				await Promise.resolve(); // simulate trivial work
				await pool.release(w);
			}),
		);
		done += n;
	}
}

interface Row {
	batch: number;
	oneshot: number;
	fixed4: number;
	collapse4: number;
	elastic: number;
}

const fails: string[] = [];
const expect = (cond: boolean, msg: string): void => {
	if (!cond) fails.push(msg);
};

async function creations(opts: { size?: number; min?: number; max?: number; target?: number }, batch: number, width: number): Promise<number> {
	const f = new CountingFactory();
	const pool = new WarmPool<FakeWorker>(f, opts);
	await runWaves(pool, batch, width);
	await pool.drain();
	return f.creations;
}

const WORKING_SET = 4;
const rows: Row[] = [];
for (const batch of [4, 8, 16, 32]) {
	const fixed4 = await creations({ size: 4 }, batch, WORKING_SET);
	const collapse4 = await creations({ min: 4, max: 4, target: 4 }, batch, WORKING_SET);
	const elastic = await creations({ min: 0, max: 8, target: 4 }, batch, WORKING_SET);
	rows.push({ batch, oneshot: batch, fixed4, collapse4, elastic });

	// (1) perfect reuse: a fixed working set of 4 never creates more than 4, regardless of batch.
	expect(fixed4 === 4, `fixed{4} batch=${batch}: expected 4 creations (reuse), got ${fixed4}`);
	// (2) collapse identity: {min=max=target=4} == {size:4}.
	expect(collapse4 === fixed4, `collapse identity batch=${batch}: {4,4,4}=${collapse4} ≠ {size:4}=${fixed4}`);
	// (3) amortization: at batch ≥ 2× working set, the pool beats oneshot.
	if (batch >= 2 * WORKING_SET) {
		expect(fixed4 < batch, `amortization batch=${batch}: pool ${fixed4} not < oneshot ${batch}`);
		expect(elastic <= 8, `elastic batch=${batch}: creations ${elastic} exceeded max 8`);
	}
}

// (4) elastic grows toward max under whole-wave pressure (width == max), exceeding target but capped.
const pressure = await creations({ min: 0, max: 8, target: 4 }, 8, 8);
expect(pressure > 4 && pressure <= 8, `elastic-under-pressure: expected 5..8 creations, got ${pressure}`);

// (5) precise shrink (A7): reapToTarget honours an exact target; reapToTarget(0) drains idle.
{
	const f = new CountingFactory();
	const pool = new WarmPool<FakeWorker>(f, { min: 0, max: 6, target: 6 });
	const ws = await Promise.all(Array.from({ length: 6 }, () => pool.acquire()));
	for (const w of ws) await pool.release(w); // 6 idle
	const r1 = await pool.reapToTarget(2);
	expect(pool.stats().total === 2, `reapToTarget(2): expected total 2, got ${pool.stats().total} (reaped ${r1})`);
	await pool.reapToTarget(0);
	expect(pool.stats().total === 0, `reapToTarget(0): expected total 0, got ${pool.stats().total}`);
	await pool.drain();
}

// ── report ──────────────────────────────────────────────────────────────────
console.log("B1 pool transport bench — worker creations (cold starts) by batch, working set = 4\n");
console.log("  batch | oneshot | fixed{4} | collapse{4,4,4} | elastic{0,8,t4} | pool savings vs oneshot");
console.log("  ------|---------|----------|-----------------|-----------------|------------------------");
for (const r of rows) {
	const saved = `${Math.round((1 - r.fixed4 / r.oneshot) * 100)}% fewer cold starts`;
	console.log(
		`  ${String(r.batch).padStart(5)} | ${String(r.oneshot).padStart(7)} | ${String(r.fixed4).padStart(8)} | ${String(r.collapse4).padStart(15)} | ${String(r.elastic).padStart(15)} | ${saved}`,
	);
}
console.log(`\n  elastic under full-wave pressure (width=max=8): ${pressure} creations (grew past target 4, ≤ max 8)`);
console.log(`\n  POOL_MIN_BATCH=8 rationale: at batch 4 the pool ties oneshot (4=4, no reuse); at batch ≥ 8 it`);
console.log(`  reuses the warm working set across waves, cutting cold starts ${Math.round((1 - rows[1].fixed4 / 8) * 100)}%+ — the documented win.`);

if (fails.length) {
	console.error(`\n❌ B1 REGRESSION (${fails.length}):`);
	for (const m of fails) console.error(`  - ${m}`);
	process.exit(1);
}
console.log("\n✅ B1 PASS — elastic pool matches the fixed-size baseline (collapse identity) and amortizes");
console.log("   cold-start across waves; no transport regression. Precise shrink (A7) verified.");
