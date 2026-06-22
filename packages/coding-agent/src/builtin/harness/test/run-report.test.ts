// run-report — pure builders + GovernorTrace fold. No Pi/subprocess deps → runs offline.
// node --experimental-strip-types --test test/run-report.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BlueprintNode, BlueprintNodeResult, BlueprintOutcome } from "../src/blueprint.ts";
import { estimateTokens, type QuorumOutcome, type SpawnResult } from "../src/core.ts";
import {
	buildBlueprintReport,
	buildQuorumReport,
	GovernorTrace,
	RUN_REPORT_SCHEMA_VERSION,
	writeRunReport,
} from "../src/run-report.ts";

// ── fixtures ────────────────────────────────────────────────────────────────
function mkResult(over: Partial<SpawnResult> = {}): SpawnResult {
	return {
		agent: "a",
		status: "done",
		artifact_excerpt: "out",
		contract: { passed: true, missing: [] },
		meta: { model: "claude-haiku-4-5", tier: "fast", elapsed_s: 1, bytes: 100 },
		...over,
	};
}
function mkNode(over: Partial<BlueprintNodeResult> & { id: string }): BlueprintNodeResult {
	return { kind: "agent", status: "done", output: "", ...over };
}
function bpOf(nodes: BlueprintNodeResult[]): { nodes: BlueprintNode[] } {
	return { nodes: nodes.map((n) => ({ id: n.id, depends_on: n.skipped_by ? undefined : [], agent: n.agent })) };
}
function outcomeOf(nodes: BlueprintNodeResult[], over: Partial<BlueprintOutcome> = {}): BlueprintOutcome {
	return { name: "bp", nodes, ...over };
}
const noGov = { history: [], shed: [] };
const args = (nodes: BlueprintNodeResult[], over: Partial<BlueprintOutcome> = {}) => ({
	runId: "r1",
	name: "bp",
	bp: bpOf(nodes),
	outcome: outcomeOf(nodes, over),
	governor: noGov,
	startedAt: 1000,
	finishedAt: 2000,
});

// ── core projection ───────────────────────────────────────────────────────────
test("buildBlueprintReport: header + status rollup match the executeBlueprint predicate", () => {
	const nodes = [
		mkNode({ id: "a", prompt: "p", result: mkResult() }),
		mkNode({
			id: "b",
			status: "failed",
			prompt: "p",
			result: mkResult({ status: "failed", artifact_excerpt: "boom" }),
		}),
		mkNode({ id: "c", status: "skipped", skipped_by: ["b"] }),
	];
	const rep = buildBlueprintReport(args(nodes));
	assert.equal(rep.schemaVersion, RUN_REPORT_SCHEMA_VERSION);
	assert.equal(rep.kind, "blueprint");
	assert.equal(rep.runId, "r1");
	assert.equal(rep.status, "failed", "any failed/skipped node → failed");
	assert.deepEqual(rep.totals.by_status, { done: 1, failed: 1, skipped: 1 });
	assert.equal(rep.totals.nodes, 3);
	assert.equal(rep.startedAt, 1000);
	assert.equal(rep.finishedAt, 2000);
});

test("buildBlueprintReport: a paused outcome reports status 'paused'", () => {
	const nodes = [mkNode({ id: "a", prompt: "p", result: mkResult() })];
	const rep = buildBlueprintReport(args(nodes, { paused: true }));
	assert.equal(rep.status, "paused");
});

test("buildBlueprintReport: all-done run reports status 'done'", () => {
	const nodes = [mkNode({ id: "a", prompt: "p", result: mkResult() })];
	assert.equal(buildBlueprintReport(args(nodes)).status, "done");
});

test("per-node metas come from the down-cast SpawnResult.meta; tokens_est = estimateTokens(prompt+bytes)", () => {
	const prompt = "a-prompt";
	const nodes = [
		mkNode({
			id: "a",
			prompt,
			result: mkResult({ meta: { model: "m", tier: "standard", elapsed_s: 3, bytes: 240 } }),
		}),
	];
	const n = buildBlueprintReport(args(nodes)).nodes[0];
	assert.equal(n.model, "m");
	assert.equal(n.tier, "standard");
	assert.equal(n.elapsed_s, 3);
	assert.equal(n.bytes, 240);
	assert.equal(n.tokens_est, estimateTokens(prompt.length + 240));
});

test("by_tier sums per effective tier and excludes cached nodes from tokens_est", () => {
	const prompt = "p";
	const nodes = [
		mkNode({ id: "f", prompt, result: mkResult({ meta: { model: "h", tier: "fast", elapsed_s: 1, bytes: 100 } }) }),
		mkNode({
			id: "g",
			prompt,
			result: mkResult({ meta: { model: "o", tier: "frontier", elapsed_s: 2, bytes: 200 } }),
		}),
		mkNode({
			id: "c",
			prompt,
			result: mkResult({ cached: "cache", meta: { model: "h", tier: "fast", elapsed_s: 0, bytes: 999 } }),
		}),
	];
	const rep = buildBlueprintReport(args(nodes));
	assert.equal(rep.totals.by_tier.fast.nodes, 2, "both fast nodes counted");
	assert.equal(
		rep.totals.by_tier.fast.tokens_est,
		estimateTokens(prompt.length + 100),
		"cached fast node adds 0 tokens",
	);
	assert.equal(rep.totals.by_tier.frontier.tokens_est, estimateTokens(prompt.length + 200));
	assert.equal(rep.totals.by_tier.standard.nodes, 0, "untouched tier stays zeroed (stable shape for Bet 2)");
	const cachedNode = rep.nodes.find((n) => n.id === "c");
	assert.equal(cachedNode?.tokens_est, 0);
	assert.equal(cachedNode?.cached, "cache");
});

test("DAG topology section captures id/depends_on/kind independent of execution records", () => {
	const nodes = [mkNode({ id: "a", prompt: "p", result: mkResult() }), mkNode({ id: "b", run: "echo", kind: "code" })];
	const bp = {
		nodes: [
			{ id: "a", depends_on: [] },
			{ id: "b", depends_on: ["a"], run: "echo" },
		] as BlueprintNode[],
	};
	const rep = buildBlueprintReport({ ...args(nodes), bp });
	assert.deepEqual(rep.blueprint?.nodes, [
		{ id: "a", depends_on: [], kind: "agent" },
		{ id: "b", depends_on: ["a"], kind: "code" },
	]);
	assert.deepEqual(rep.nodes.find((n) => n.id === "b")?.depends_on, ["a"]);
});

// ── reason derivation (recovers what the reason-less done event never had) ──────
test("reason: contract_violation → missing sections", () => {
	const r = mkResult({ status: "contract_violation", contract: { passed: false, missing: ["## plan", "## tests"] } });
	// the node FAILED (a NodeStatus); deriveReason reads the inner SpawnResult.status, not the node status
	const n = buildBlueprintReport(args([mkNode({ id: "a", prompt: "p", status: "failed", result: r })])).nodes[0];
	assert.equal(n.reason, "missing sections: ## plan, ## tests");
});

test("reason: verify_failed → trimmed verify output", () => {
	const r = mkResult({ status: "verify_failed", verify: { cmd: "test", passed: false, output: "  FAIL: 2 tests  " } });
	const n = buildBlueprintReport(args([mkNode({ id: "a", prompt: "p", status: "failed", result: r })])).nodes[0];
	assert.equal(n.reason, "verify failed: FAIL: 2 tests");
});

test("reason: failed → excerpt; timeout → 'timed out'; done → null", () => {
	const failed = mkResult({ status: "failed", artifact_excerpt: "stack trace here" });
	const timeout = mkResult({ status: "timeout" });
	const repF = buildBlueprintReport(args([mkNode({ id: "a", prompt: "p", status: "failed", result: failed })]));
	const repT = buildBlueprintReport(args([mkNode({ id: "a", prompt: "p", status: "failed", result: timeout })]));
	const repD = buildBlueprintReport(args([mkNode({ id: "a", prompt: "p", result: mkResult() })]));
	assert.equal(repF.nodes[0].reason, "failed: stack trace here");
	assert.equal(repT.nodes[0].reason, "timed out");
	assert.equal(repD.nodes[0].reason, null);
});

// ── quorum projection ──────────────────────────────────────────────────────────
function mkQuorum(over: Partial<QuorumOutcome> = {}): QuorumOutcome {
	const win = mkResult({ agent: "w", meta: { model: "o", tier: "frontier", elapsed_s: 5, bytes: 300 } });
	const loser = mkResult({
		agent: "l",
		status: "failed",
		meta: { model: "o", tier: "frontier", elapsed_s: 4, bytes: 50 },
	});
	return {
		winner: win,
		ranking: [win, loser],
		survivors: [win],
		agreement: "majority",
		decidedBy: "vote",
		groupSize: 1,
		...over,
	};
}

test("best_of node projects QuorumOutcome → nodes[].quorum with per-candidate detail", () => {
	const q = mkQuorum();
	const nodes = [mkNode({ id: "q", prompt: "qp", result: q })];
	const n = buildBlueprintReport(args(nodes)).nodes[0];
	assert.ok(n.quorum, "quorum projection present");
	assert.equal(n.quorum?.agreement, "majority");
	assert.equal(n.quorum?.decidedBy, "vote");
	assert.equal(n.quorum?.survivors, 1);
	assert.equal(n.quorum?.candidates, 2);
	assert.equal(n.quorum?.won, true);
	assert.equal(n.quorum?.groupSize, 1);
	assert.equal(n.quorum?.candidates_detail.length, 2);
	assert.equal(n.quorum?.candidates_detail[0].agent, "w");
	// node-level metas come from the winner; tokens_est sums ALL candidates (the real cost of a best_of node)
	assert.equal(n.tier, "frontier");
	assert.equal(n.elapsed_s, 5);
	assert.equal(n.tokens_est, estimateTokens("qp".length + 300) + estimateTokens("qp".length + 50));
});

test("a quorum with no winner reports a failure reason", () => {
	const q = mkQuorum({ winner: undefined, survivors: [], agreement: "none", decidedBy: "no-survivor" });
	const n = buildBlueprintReport(args([mkNode({ id: "q", prompt: "qp", status: "failed", result: q })])).nodes[0];
	assert.equal(n.quorum?.won, false);
	assert.match(n.reason ?? "", /quorum failed/);
});

test("buildQuorumReport (spawn_quorum seam): single synthetic node, fanout kind, no DAG", () => {
	const rep = buildQuorumReport({
		runId: "q1",
		name: "spawn_quorum",
		agent: "writer",
		prompt: "qp",
		outcome: mkQuorum(),
		governor: noGov,
		startedAt: 0,
		finishedAt: 10,
	});
	assert.equal(rep.kind, "fanout");
	assert.equal(rep.blueprint, null);
	assert.equal(rep.status, "done");
	assert.equal(rep.nodes.length, 1);
	assert.equal(rep.nodes[0].agent, "writer");
	assert.equal(rep.nodes[0].quorum?.candidates, 2);
	assert.equal(rep.totals.by_tier.frontier.nodes, 2, "both candidates attributed to frontier");
	// tokens_est is keyed off the real prompt length (300 + 50 byte candidates), not the output excerpt
	assert.equal(rep.totals.tokens_est, estimateTokens("qp".length + 300) + estimateTokens("qp".length + 50));
});

// ── GovernorTrace fold ─────────────────────────────────────────────────────────
test("GovernorTrace: append-only history (NOT a 32-sample ring buffer) + retains shed reason", () => {
	const t = new GovernorTrace();
	for (let i = 0; i < 50; i++) t.record({ t: "queued", ts: i, window_pct: i, load_pct: i, queue_depth: i % 3 });
	t.record({ t: "shedding", id: "node-x", from: "frontier", to: "standard", reason: "window hot" });
	const snap = t.snapshot();
	assert.equal(snap.history.length, 50, "all 50 samples retained — proves no 32-cap ring buffer");
	assert.deepEqual(snap.history[49], { ts: 49, load_pct: 49, window_pct: 49, queue_depth: 49 % 3 });
	assert.deepEqual(snap.shed, [{ node: "node-x", from: "frontier", to: "standard", reason: "window hot" }]);
});

test("GovernorTrace: only carrier events with a gauge produce a sample; junk is ignored", () => {
	const t = new GovernorTrace();
	t.record({ t: "tool", phase: "start", tool: "bash" }); // no gauge → no sample
	t.record(null);
	t.record("nonsense");
	t.record({ t: "done", status: "done", window_pct: 42 }); // window only → samples (load defaults 0)
	const snap = t.snapshot();
	assert.equal(snap.history.length, 1);
	assert.deepEqual(snap.history[0], { ts: 0, load_pct: 0, window_pct: 42, queue_depth: 0 });
});

// ── graceful degradation ───────────────────────────────────────────────────────
test("code/skipped nodes with no result emit null metas and never throw", () => {
	const nodes = [
		mkNode({ id: "code", kind: "code", run: "echo", result: undefined }),
		mkNode({ id: "skip", status: "skipped" }),
	];
	const rep = buildBlueprintReport(args(nodes));
	const code = rep.nodes.find((n) => n.id === "code");
	assert.equal(code?.model, null);
	assert.equal(code?.tier, null);
	assert.equal(code?.tokens_est, null);
	assert.equal(code?.reason, null);
	assert.equal(rep.totals.tokens_est, 0);
});

test("writeRunReport: round-trips JSON; an un-writable dir returns false without throwing", () => {
	const dir = mkdtempSync(join(tmpdir(), "runrep-"));
	const rep = buildBlueprintReport(args([mkNode({ id: "a", prompt: "p", result: mkResult() })]));
	assert.equal(writeRunReport(dir, "r1", rep), true);
	const round = JSON.parse(readFileSync(join(dir, "r1", "report.json"), "utf8"));
	assert.equal(round.runId, "r1");
	assert.equal(round.nodes[0].id, "a");
	// a file standing in for the runs dir makes mkdir fail → best-effort returns false, no throw
	const asFile = join(dir, "not-a-dir");
	writeFileSync(asFile, "x");
	assert.doesNotThrow(() => assert.equal(writeRunReport(asFile, "r2", rep), false));
});
