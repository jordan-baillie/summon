// Harness v2 — run-report: a persisted, self-describing decision trace for one durable run.
//
// The live dashboard ViewModel (extension/observe.ts) is private to that closure and its governor
// history is a 32-sample ring buffer — so it is the WRONG source for a durable artifact. This module
// instead assembles the report from the STRUCTURED run-end state that already exists: BlueprintOutcome
// .nodes (each node's `.result` down-cast to SpawnResult / QuorumOutcome) plus a GovernorTrace that taps
// the agent-event bus for the run's lifetime. The builders are PURE (no fs/subprocess) → unit-testable
// offline; only writeRunReport touches disk, best-effort. tokens_est is an ESTIMATE (no provider usage
// is available off the subprocess) — named so consumers never mistake it for billed tokens.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlueprintNode, BlueprintNodeResult, BlueprintOutcome, NodeKind, NodeStatus } from "./blueprint.ts";
import { nodeKind } from "./blueprint.ts";
import { type AgentBundle, estimateTokens, type QuorumOutcome, type SpawnResult } from "./core.ts";
import type { RunKind } from "./runstore.ts";

// Bump on any breaking field change so the Fugu replay loader / a future HTML renderer can detect drift.
export const RUN_REPORT_SCHEMA_VERSION = 1;

export type Tier = AgentBundle["model_tier"];

export interface GovernorSample {
	ts: number;
	load_pct: number;
	window_pct: number;
	queue_depth: number;
}
export interface ShedEvent {
	node: string;
	from: string;
	to: string;
	reason: string;
}
export interface GovernorSnapshot {
	history: GovernorSample[];
	shed: ShedEvent[];
}

export interface QuorumCandidate {
	agent: string;
	status: string;
	tier: Tier | null;
	model: string;
	elapsed_s: number;
	bytes: number;
	tokens_est: number;
}
export interface QuorumProjection {
	agreement: string;
	decidedBy: string;
	survivors: number;
	candidates: number;
	groupSize: number | null;
	won: boolean;
	candidates_detail: QuorumCandidate[];
}

export interface RunReportNode {
	id: string;
	kind: NodeKind;
	status: NodeStatus;
	agent: string | null;
	depends_on: string[];
	tier: Tier | null; // EFFECTIVE tier (winner for a quorum node) — captured at spawn, correct under shed + model override
	model: string | null;
	elapsed_s: number | null;
	bytes: number | null;
	tokens_est: number | null; // node total; for a quorum node, the sum across all candidates (cached → 0)
	cached: "cache" | "inflight" | null;
	contract: { passed: boolean; missing: string[] } | null;
	verify: { cmd: string; passed: boolean; output: string } | null;
	reason: string | null; // DERIVED from the structured result, not the (reason-less) done event
	skipped_by: string[] | null;
	quorum: QuorumProjection | null;
}

export interface TierRollup {
	nodes: number;
	tokens_est: number;
	elapsed_s: number;
}
export interface RunReportTotals {
	nodes: number;
	by_status: Record<string, number>;
	elapsed_s: number;
	tokens_est: number;
	by_tier: Record<Tier, TierRollup>; // THE Bet 2 cost surface: spend split fast/standard/frontier
}

export interface RunReport {
	schemaVersion: number;
	runId: string;
	kind: RunKind;
	name: string;
	status: "done" | "failed" | "paused";
	startedAt: number;
	finishedAt: number;
	blueprint: { nodes: { id: string; depends_on: string[]; kind: NodeKind }[] } | null; // DAG topology (null for non-blueprint kinds)
	nodes: RunReportNode[];
	governor: GovernorSnapshot;
	totals: RunReportTotals;
}

// ── GovernorTrace ─────────────────────────────────────────────────────────────
// The ONLY part of the report that needs a live subscription. Mirrors observe.ts captureGov's field
// reads (window_pct/load_pct/queue_depth) but APPENDS full samples for the run's lifetime instead of
// ring-buffering, and retains shedding.reason (which the dashboard reducer drops). One run is bounded;
// SAMPLE_CAP is only a runaway backstop. The bus handle (EventBus.on returns an unsubscribe fn) is held
// so the caller can stop() in a finally and never leak a listener across runs.
const SAMPLE_CAP = 4096;
type EventLike = { on(channel: string, handler: (data: unknown) => void): () => void };

export class GovernorTrace {
	private samples: GovernorSample[] = [];
	private sheds: ShedEvent[] = [];
	private unsub: (() => void) | null = null;

	subscribe(bus: EventLike | undefined): void {
		if (!bus?.on || this.unsub) return;
		this.unsub = bus.on("agent-event", (data) => this.record(data));
	}

	// Fold one agent-event. Exported behaviour, but pure over its argument — unit-tested directly.
	record(data: unknown): void {
		if (!data || typeof data !== "object") return;
		const e = data as Record<string, unknown>;
		if (e.t === "shedding") {
			this.sheds.push({ node: str(e.id), from: str(e.from), to: str(e.to), reason: str(e.reason) });
		}
		// Sample whenever a carrier event reports either gauge (queued/admitted carry both; done carries window).
		if (typeof e.window_pct === "number" || typeof e.load_pct === "number") {
			this.samples.push({
				ts: typeof e.ts === "number" ? e.ts : 0,
				load_pct: num(e.load_pct),
				window_pct: num(e.window_pct),
				queue_depth: num(e.queue_depth),
			});
			if (this.samples.length > SAMPLE_CAP) this.samples.shift();
		}
	}

	snapshot(): GovernorSnapshot {
		return { history: [...this.samples], shed: [...this.sheds] };
	}

	stop(): void {
		if (this.unsub) {
			this.unsub();
			this.unsub = null;
		}
	}
}

// ── builders (pure) ───────────────────────────────────────────────────────────

export function buildBlueprintReport(args: {
	runId: string;
	name: string;
	bp: { nodes: BlueprintNode[] };
	outcome: BlueprintOutcome;
	governor: GovernorSnapshot;
	startedAt: number;
	finishedAt: number;
}): RunReport {
	const { runId, name, bp, outcome, governor, startedAt, finishedAt } = args;
	const depsById = new Map(bp.nodes.map((n) => [n.id, n.depends_on ?? []]));
	const contribs: Contrib[] = [];
	const nodes = outcome.nodes.map((nr) => {
		const deps = depsById.get(nr.id) ?? [];
		const q = asQuorumOutcome(nr.result);
		if (q) {
			collectQuorum(q, nr.prompt?.length ?? 0, contribs);
			return quorumNode(nr, deps, q);
		}
		const r = asSpawnResult(nr.result);
		if (r) collect(r, nr.prompt?.length ?? 0, contribs);
		return spawnNode(nr, deps, r);
	});
	// Same predicate executeBlueprint uses for run_finished, so report.status never disagrees with the journal.
	const failed = outcome.nodes.some((n) => n.status === "failed" || n.status === "skipped");
	const status = outcome.paused ? "paused" : failed ? "failed" : "done";
	return {
		schemaVersion: RUN_REPORT_SCHEMA_VERSION,
		runId,
		kind: "blueprint",
		name,
		status,
		startedAt,
		finishedAt,
		blueprint: { nodes: bp.nodes.map((n) => ({ id: n.id, depends_on: n.depends_on ?? [], kind: nodeKind(n) })) },
		nodes,
		governor,
		totals: rollupTotals(nodes, contribs),
	};
}

export function buildQuorumReport(args: {
	runId: string;
	name: string;
	agent: string;
	prompt: string; // the base quorum prompt — drives tokens_est (each candidate adds it + a small variant seed)
	outcome: QuorumOutcome;
	governor: GovernorSnapshot;
	startedAt: number;
	finishedAt: number;
}): RunReport {
	const { runId, name, agent, prompt, outcome, governor, startedAt, finishedAt } = args;
	const contribs: Contrib[] = [];
	collectQuorum(outcome, prompt.length, contribs);
	const nr: BlueprintNodeResult = {
		id: agent,
		kind: "agent",
		status: outcome.winner ? "done" : "failed",
		agent,
		prompt,
		output: "",
	};
	const node = quorumNode(nr, [], outcome);
	return {
		schemaVersion: RUN_REPORT_SCHEMA_VERSION,
		runId,
		kind: "fanout",
		name,
		status: outcome.winner ? "done" : "failed",
		startedAt,
		finishedAt,
		blueprint: null,
		nodes: [node],
		governor,
		totals: rollupTotals([node], contribs),
	};
}

// Best-effort write of report.json as a sibling of the run's events.jsonl. Never throws — a durable
// artifact must never be able to crash a run.
export function writeRunReport(runsDir: string, runId: string, report: RunReport): boolean {
	try {
		const dir = join(runsDir, runId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
		return true;
	} catch {
		return false;
	}
}

// ── internals ─────────────────────────────────────────────────────────────────

interface Contrib {
	tier: Tier;
	tokens: number;
	elapsed: number;
}

function spawnNode(nr: BlueprintNodeResult, deps: string[], r: SpawnResult | undefined): RunReportNode {
	const promptLen = nr.prompt?.length ?? 0;
	return {
		id: nr.id,
		kind: nr.kind,
		status: nr.status,
		agent: nr.agent ?? null,
		depends_on: deps,
		tier: r?.meta.tier ?? null,
		model: r?.meta.model ?? null,
		elapsed_s: r?.meta.elapsed_s ?? null,
		bytes: r?.meta.bytes ?? null,
		tokens_est: r ? nodeTokens(promptLen, r) : null,
		cached: r?.cached ?? null,
		contract: r?.contract ?? null,
		verify: r?.verify ?? null,
		reason: r ? deriveReason(r) : null,
		skipped_by: nr.skipped_by ?? null,
		quorum: null,
	};
}

function quorumNode(nr: BlueprintNodeResult, deps: string[], q: QuorumOutcome): RunReportNode {
	const primary = q.winner ?? q.ranking[0];
	const promptLen = nr.prompt?.length ?? 0;
	const tokens_est = q.ranking.reduce((s, c) => s + nodeTokens(promptLen, c), 0);
	return {
		id: nr.id,
		kind: nr.kind,
		status: nr.status,
		agent: nr.agent ?? null,
		depends_on: deps,
		tier: primary?.meta.tier ?? null,
		model: primary?.meta.model ?? null,
		elapsed_s: primary?.meta.elapsed_s ?? null,
		bytes: primary?.meta.bytes ?? null,
		tokens_est,
		cached: primary?.cached ?? null,
		contract: primary?.contract ?? null,
		verify: primary?.verify ?? null,
		reason: q.winner ? null : "quorum failed — no candidate passed verify+contract",
		skipped_by: nr.skipped_by ?? null,
		quorum: projectQuorum(q, promptLen),
	};
}

function projectQuorum(q: QuorumOutcome, promptLen: number): QuorumProjection {
	return {
		agreement: q.agreement,
		decidedBy: q.decidedBy,
		survivors: q.survivors.length,
		candidates: q.ranking.length,
		groupSize: q.groupSize ?? null,
		won: !!q.winner,
		candidates_detail: q.ranking.map((c) => ({
			agent: c.agent,
			status: c.status,
			tier: c.meta.tier ?? null,
			model: c.meta.model,
			elapsed_s: c.meta.elapsed_s,
			bytes: c.meta.bytes,
			tokens_est: nodeTokens(promptLen, c),
		})),
	};
}

// A cache/inflight hit spent no window tokens (mirrors spawn-agent.ts: spent=0 on a non-miss).
function nodeTokens(promptLen: number, r: SpawnResult): number {
	return r.cached ? 0 : estimateTokens(promptLen + r.meta.bytes);
}

function collect(r: SpawnResult, promptLen: number, out: Contrib[]): void {
	if (r.meta.tier) out.push({ tier: r.meta.tier, tokens: nodeTokens(promptLen, r), elapsed: r.meta.elapsed_s });
}
function collectQuorum(q: QuorumOutcome, promptLen: number, out: Contrib[]): void {
	for (const c of q.ranking) collect(c, promptLen, out);
}

function rollupTotals(nodes: RunReportNode[], contribs: Contrib[]): RunReportTotals {
	const by_status: Record<string, number> = {};
	let elapsed_s = 0;
	let tokens_est = 0;
	for (const n of nodes) {
		by_status[n.status] = (by_status[n.status] ?? 0) + 1;
		if (n.elapsed_s !== null) elapsed_s += n.elapsed_s;
		if (n.tokens_est !== null) tokens_est += n.tokens_est;
	}
	const by_tier = emptyByTier();
	for (const c of contribs) {
		const b = by_tier[c.tier];
		b.nodes += 1;
		b.tokens_est += c.tokens;
		b.elapsed_s = round(b.elapsed_s + c.elapsed);
	}
	return { nodes: nodes.length, by_status, elapsed_s: round(elapsed_s), tokens_est, by_tier };
}

function emptyByTier(): Record<Tier, TierRollup> {
	return {
		fast: { nodes: 0, tokens_est: 0, elapsed_s: 0 },
		standard: { nodes: 0, tokens_est: 0, elapsed_s: 0 },
		frontier: { nodes: 0, tokens_est: 0, elapsed_s: 0 },
	};
}

function deriveReason(r: SpawnResult): string | null {
	switch (r.status) {
		case "contract_violation":
			return r.contract.missing.length
				? `missing sections: ${r.contract.missing.join(", ")}`
				: "output contract failed";
		case "verify_failed":
			return r.verify ? `verify failed: ${trunc(r.verify.output.trim(), 240)}` : "verify failed";
		case "timeout":
			return "timed out";
		case "failed":
			return r.artifact_excerpt.trim() ? `failed: ${trunc(r.artifact_excerpt.trim(), 240)}` : "failed";
		default:
			return null; // done
	}
}

// Down-cast BlueprintNodeResult.result (typed unknown). Narrow structurally — no cast-through-any — so it
// stays clean under erasableSyntaxOnly + noImplicitAny. Order matters: a QuorumOutcome also lacks `meta`,
// so test for `ranking` first / `meta` second to disambiguate the two.
function asQuorumOutcome(x: unknown): QuorumOutcome | undefined {
	return isObj(x) && "ranking" in x && "survivors" in x && "agreement" in x
		? (x as unknown as QuorumOutcome)
		: undefined;
}
function asSpawnResult(x: unknown): SpawnResult | undefined {
	return isObj(x) && "meta" in x && "contract" in x && "status" in x && !("ranking" in x)
		? (x as unknown as SpawnResult)
		: undefined;
}
function isObj(x: unknown): x is Record<string, unknown> {
	return !!x && typeof x === "object";
}

function num(x: unknown): number {
	return typeof x === "number" && Number.isFinite(x) ? x : 0;
}
function str(x: unknown): string {
	return typeof x === "string" ? x : "";
}
function trunc(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}
function round(x: number): number {
	return Math.round(x * 1000) / 1000;
}
