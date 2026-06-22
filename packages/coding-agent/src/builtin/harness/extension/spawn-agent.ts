// Harness v2 — Pi extension: registers `spawn_agent` (one task) and `spawn_agents` (parallel fan-out)
// so an orchestrator summon session can delegate to specialised sub-agents. Project-aware (GLOBAL +
// <project>/.summon/agents, .harness.json protected paths). Wraps src/core.ts (single-sourced).

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../index.ts";
import { ArrivalTracker } from "../src/arrivals.ts";
import {
	type Blueprint,
	type BlueprintExec,
	type BlueprintNode,
	type BlueprintOutcome,
	loadBlueprints,
	type NodeRun,
	normalizeGeneratedBlueprint,
	parseBlueprintFromText,
	runBlueprint,
	validateBlueprint,
} from "../src/blueprint.ts";
import { cacheKey, isCacheable, ResultCache } from "../src/cache.ts";
import {
	type AgentBundle,
	buildSystemPrompt,
	estimateTokens,
	isDestructiveCmd,
	loadRegistries,
	registryDigest,
	retryPrompt,
	runQuorum,
	runWithReview,
	spawnAgent,
	WindowGovernor,
	withRetry,
	writeRegistryIndex,
} from "../src/core.ts";
import { aggregateFleet, appendFleetEntry, auditPrompt, fleetDigest, readFleet } from "../src/fleet.ts";
import { type DemandLike, FleetController, type ShedDecision } from "../src/fleet-controller.ts";
import { FLEET_LEDGER, FLEET_SUMMARY, REGISTRY_INDEX, RUNS_DIR } from "../src/paths.ts";
import {
	drainAllPools,
	isPrewarmed,
	pickTransport,
	poolStatsAll,
	prewarm,
	reapToTarget,
	setPoolBand,
	setPoolTarget,
	spawnViaPool,
} from "../src/pool-transport.ts";
import { buildBlueprintReport, buildQuorumReport, GovernorTrace, writeRunReport } from "../src/run-report.ts";
import { blueprintResume, listResumableRuns, makeRunId, runEventsPath, runMeta } from "../src/runstore.ts";
import { resolveScaleMode, scaleLabel, scaleParams } from "../src/scale.ts";
import { deriveState, RunSession, readEvents } from "../src/session.ts";
import { loadTeams, runTeam } from "../src/teams.ts";

export default function harness(summon: ExtensionAPI) {
	const { reg: registry, maxWeight, protectedList, root } = loadRegistries(process.cwd()); // fail-closed validation at load
	// Window-aware governor: weighted concurrency cap + rolling-window token tracking.
	// HARNESS_WINDOW_TOKENS>0 turns on a hard window gate; 0 (default) tracks + surfaces only (no hang).
	// Scale dial (#4): HARNESS_SCALE=auto|eco|turbo|fixed:N maps the fleet's params at boot. Default
	// 'auto' == today's behaviour (base maxWeight + the existing window budget), so unset is a no-op.
	const scaleMode = resolveScaleMode(process.env.HARNESS_SCALE);
	const scaled = scaleParams(scaleMode, { maxWeight, budgetTokens: Number(process.env.HARNESS_WINDOW_TOKENS ?? 0) });
	const gov = new WindowGovernor({
		maxWeight: scaled.maxWeight,
		budgetTokens: scaled.budgetTokens,
		// HARNESS_WINDOW_RESERVE=1 makes in-flight reserved (approximate, pre-admission) tokens count
		// toward the window gate so a burst can't over-commit; default off = admission unchanged.
		reserveGate: process.env.HARNESS_WINDOW_RESERVE === "1",
	});
	let activeScale = scaleMode; // runtime scale dial state (mutated by /harness-scale)
	const names = [...registry.keys()].filter((n) => n !== "orchestrator").join(", ");
	// AUTHORITATIVE registry awareness: a compact roster injected into every spawn tool description so the
	// orchestrator always knows each specialist's tier/tools/contract (never depends on reading a file).
	const digest = registryDigest(registry, { exclude: ["orchestrator"] });
	// Within-run result cache + in-flight dedup (#5): identical READ-ONLY sub-tasks collapse to one
	// execution. Disabled with HARNESS_NO_CACHE=1. Write-capable agents are never cached (safety in cache.ts).
	const cache = process.env.HARNESS_NO_CACHE ? null : new ResultCache();
	// Boot-time prompt audit (#8 skill-bloat): render each worker's system prompt once and flag any that
	// exceed the byte threshold — context that costs tokens every spawn without earning it.
	const bootAudits = [...registry.values()].map((b) => auditPrompt(b.name, buildSystemPrompt(b)));
	summon.events?.emit?.("agent-event", {
		id: "boot",
		agent: "harness",
		ts: Date.now(),
		t: "boot-audit",
		audits: bootAudits,
		bloated: bootAudits.filter((a) => a.over).map((a) => a.name),
	});
	// Durable run sessions (Phase 2/3): journal every blueprint/team/fan-out run to an append-only log so
	// a crashed or human-paused run is discoverable + resumable. HARNESS_DURABLE=0 opts out (journaling off).
	const DURABLE = process.env.HARNESS_DURABLE !== "0";
	// Per-run decision-trace artifact (report.json beside the run's events.jsonl). Opt-in, default OFF;
	// additive — the trace subscription and report write are skipped entirely when unset, so the run hot
	// path is byte-identical. Rides the durable run identity, so it is a no-op when DURABLE is off.
	const RUN_REPORT = process.env.HARNESS_RUN_REPORT === "1";
	// Best-of-N cap (#6) and auto-planner caps (#5). All optional; safe defaults.
	const QUORUM_MAX = Math.max(2, Number(process.env.HARNESS_QUORUM_MAX ?? 3));
	const PLAN_MAX_NODES = Math.max(1, Number(process.env.HARNESS_PLAN_MAX_NODES ?? 24));
	const PLAN_FANOUT_CAP = Math.max(1, Number(process.env.HARNESS_PLAN_FANOUT_CAP ?? 20));
	const PLAN_RUN_ENABLED = process.env.HARNESS_PLAN_RUN === "1"; // default: dry-run only (no execution)
	// Crash recovery: at boot, surface any run that didn't finish (crashed) or is paused on an approval gate.
	if (DURABLE) {
		try {
			const resumable = listResumableRuns(RUNS_DIR);
			if (resumable.length)
				summon.events?.emit?.("agent-event", {
					id: "boot",
					agent: "harness",
					ts: Date.now(),
					t: "resumable-runs",
					runs: resumable.map((r) => ({
						runId: r.runId,
						kind: r.kind,
						name: r.name,
						status: r.status,
						awaiting: r.awaiting.length,
					})),
				});
		} catch {
			/* best-effort discovery */
		}
	}
	// One place that records a finished spawn: rolling-window tokens + the cross-run fleet ledger (#8).
	const logSpawn = (b: { name: string; model_tier: string }, r: any, spentTokens: number): void => {
		gov.record(spentTokens);
		try {
			appendFleetEntry(FLEET_LEDGER, {
				ts: Date.now(),
				agent: b.name,
				model: r.meta?.model ?? "",
				status: r.status,
				elapsed_s: r.meta?.elapsed_s ?? 0,
				bytes: r.meta?.bytes ?? 0,
				est_tokens: spentTokens,
				cached: r.cached ?? null,
				verify: r.verify?.passed ?? null,
			});
		} catch {
			/* best-effort */
		}
	};
	// Best-effort machine-readable index for humans/tooling (the digest is the source of truth at runtime).
	let indexPath = REGISTRY_INDEX;
	try {
		indexPath = writeRegistryIndex(registry, REGISTRY_INDEX).path;
	} catch {
		/* read-only install: the tool-description digest still carries the roster */
	}
	// Opt-in pre-warm (HARNESS_PREWARM=scout,builder): stand up idle rpc workers so first spawns are
	// instant. Fire-and-forget so it never blocks startup; drained on shutdown.
	const prewarmNames = (process.env.HARNESS_PREWARM ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((n) => n && n !== "orchestrator" && registry.has(n));
	if (prewarmNames.length) {
		const bundles = prewarmNames.map((n) => registry.get(n)!);
		void prewarm(bundles, { root, protected: protectedList })
			.then((summary) =>
				summon.events?.emit?.("agent-event", {
					id: "prewarm",
					agent: "harness",
					ts: Date.now(),
					t: "prewarm",
					summary,
				}),
			)
			.catch(() => {});
	}
	// ── autoscaler (#3): a demand-driven control loop over the governor + warm pools. Both layers are
	//    ON BY DEFAULT (B3 graduation, 2026-06-22; validated by bench/). OBSERVE (HARNESS_AUTOSCALE!=0)
	//    emits fleet telemetry + powers the dashboard. ACTUATION (HARNESS_AUTOSCALE_ACT!=0) additionally
	//    resizes warm pools to demand (grow/prewarm/shrink, bounded by maxPerBundle + the governor) and
	//    routes concurrent spawns to the warm pool. Load-shedding (tier-downshift) is part of actuation but
	//    stays INERT unless a window budget is configured (HARNESS_WINDOW_TOKENS>0 → windowPct can reach
	//    shedAtPct); with the default budget 0, windowPct()==0 < 90 so actuation never degrades a tier.
	//    Opt out per layer: HARNESS_AUTOSCALE=0 (all off) or HARNESS_AUTOSCALE_ACT=0 (observe-only).
	const AUTOSCALE = process.env.HARNESS_AUTOSCALE !== "0";
	const AUTOSCALE_ACT = process.env.HARNESS_AUTOSCALE_ACT !== "0";
	// Live per-bundle demand for the controller: inflight = admitted & running; waiting = queued on the
	// governor; arrival rate/trend = a real rolling-window signal (A6) so computeTarget's speculative slot
	// and prewarm-on-rising-demand actually fire instead of seeing a hardcoded 0.
	const inflightByBundle = new Map<string, number>();
	const waitingByBundle = new Map<string, number>();
	const arrivals = new ArrivalTracker();
	const bump = (m: Map<string, number>, k: string, d: number) => m.set(k, Math.max(0, (m.get(k) ?? 0) + d));
	const fleetSignals = (now: number = Date.now()): Map<string, DemandLike> => {
		const out = new Map<string, DemandLike>();
		for (const n of new Set([...inflightByBundle.keys(), ...waitingByBundle.keys(), ...arrivals.bundles()])) {
			const rates = arrivals.rates(n, now);
			out.set(n, {
				bundle: n,
				inflight: inflightByBundle.get(n) ?? 0,
				queued: waitingByBundle.get(n) ?? 0,
				arrivalRate1m: rates.rate1m,
				arrivalRateTrend: rates.trend,
			});
		}
		return out;
	};
	const fleet = AUTOSCALE
		? new FleetController({
				gov,
				registry,
				actuate: AUTOSCALE_ACT,
				tickMs: Number(process.env.HARNESS_AUTOSCALE_TICK_MS ?? 2000),
				maxPerBundle: Number(process.env.HARNESS_AUTOSCALE_MAX ?? Math.max(scaled.poolSize, 16)),
				shedAtPct: Number(process.env.HARNESS_AUTOSCALE_SHED_PCT ?? 90),
				signals: fleetSignals,
				poolStats: () => poolStatsAll().map((p) => ({ name: p.name, total: p.total, idle: p.idle, busy: p.busy })),
				setPoolTarget: (name, n) => setPoolTarget(name, n),
				// Shrink PRECISELY: reap idle workers down to exactly the controller's target (not all the way
				// to min). FleetController ignores the return; the async reap is fire-and-forget.
				reapToTarget: (name, target) => {
					void reapToTarget(name, target);
					return 0;
				},
				prewarm: (b) => prewarm([b], { root, protected: protectedList }),
				// Surface only MEANINGFUL fleet activity. Observe-only (the default) ticks every few seconds;
				// emitting idle/no-op ticks would repaint the TUI every tick and reintroduce the idle jitter the
				// observe extension is engineered to avoid. Dropping all-hold/all-zero ticks keeps idle byte-silent
				// (no emit ⇒ no repaint); only real scaling/demand reaches the dashboard.
				onTick: (ticks) => {
					const active = ticks.filter((t) => t.current > 0 || t.target > 0 || t.action !== "hold");
					if (active.length)
						summon.events?.emit?.("agent-event", {
							id: "fleet",
							agent: "harness",
							ts: Date.now(),
							t: "autoscale",
							ticks: active,
						});
				},
			})
		: null;
	fleet?.start();

	const runDir = (ctx: any) => join(tmpdir(), "harness-runs", ctx?.sessionId ?? "session");

	// Start a durable run session (or null when DURABLE is off). The run_started event is self-describing
	// (kind/name/vars/tasks) so resume needs nothing but the log. Returns the session + its run id.
	function startRun(
		kind: "blueprint" | "team" | "fanout" | "spawn",
		name: string,
		meta: Record<string, unknown>,
		ctx: any,
	): { session: RunSession | null; runId: string | null } {
		if (!DURABLE) return { session: null, runId: null };
		try {
			const runId = makeRunId(kind, name, ctx?.sessionId ?? "session");
			const session = RunSession.create(runEventsPath(RUNS_DIR, runId));
			session.append("run_started", { kind, name, ...meta });
			return { session, runId };
		} catch {
			return { session: null, runId: null }; // durability is best-effort; never block a run
		}
	}
	const journalOf = (session: RunSession | null) =>
		session ? (e: { type: string; [k: string]: unknown }) => session.append(e.type as never, e) : undefined;

	async function runOne(
		agent: string,
		prompt: string,
		task_id: string,
		ctx: any,
		verify?: string,
		transport?: "oneshot" | "pool",
	): Promise<any> {
		const b = registry.get(agent);
		if (!b) return { agent, status: "failed", error: `no such agent '${agent}'. have: ${names}` };
		const emit = (e: any) => summon.events?.emit?.("agent-event", { id: task_id, agent, ts: Date.now(), ...e });
		arrivals.record(agent); // a fresh task = an arrival (feeds the autoscaler's arrival-rate/trend signal)
		// Load-shedding (A1): when ACTUATING and the rolling window is hot, degrade THIS spawn one tier so a
		// budget-saturated burst keeps progressing on a cheaper model instead of stalling at the governor. `eb`
		// is the EFFECTIVE bundle (a tier-downshifted clone) threaded through everything that depends on the
		// tier — admit weight, cache key, exec, the spawned event, and the ledger — so they stay consistent.
		let eb = b;
		let shed: ShedDecision | null = null;
		if (fleet && AUTOSCALE_ACT) {
			const dec = fleet.shouldShed(b);
			if (dec.shed && dec.tier && dec.tier !== b.model_tier) {
				eb = { ...b, model_tier: dec.tier };
				shed = dec;
			}
		}
		// Resolve transport: a shed spawn forces oneshot — the warm pool is keyed by bundle NAME, so reusing it
		// with a downshifted tier would poison later full-tier spawns of the same name. Otherwise: explicit
		// wins; when ACTUATING route from live saturation; else a pre-warmed bundle uses its hot pool, else
		// oneshot (observe-only keeps this byte-identical).
		const t = shed
			? "oneshot"
			: (transport ?? (fleet && AUTOSCALE_ACT ? fleet.routeTransport(b) : isPrewarmed(agent) ? "pool" : "oneshot"));
		const cacheable = !!cache && isCacheable(eb);
		const key = cacheable ? cacheKey(eb, prompt, verify) : "";
		// Fast path: a stored cache hit returns instantly — no governor slot, no spawn, zero token spend.
		if (cacheable) {
			const hit = cache!.peek(key);
			if (hit) {
				emit({ t: "done", status: hit.status, verify: hit.verify?.passed, cached: "cache" });
				logSpawn(eb, hit, 0);
				return hit;
			}
		}
		// Reserve an APPROXIMATE pre-admission token estimate (input-only; output bytes unknown until the
		// spawn completes) — reconciled when release() runs in the finally. The admit hooks surface the
		// queue/admit transitions on the same agent-event bus the dashboard + autoscaler consume.
		if (shed)
			emit({
				t: "shedding",
				from: b.model_tier,
				to: eb.model_tier,
				reason: shed.reason,
				window_pct: gov.windowPct(),
			});
		const reserve = estimateTokens(prompt.length);
		bump(waitingByBundle, agent, 1); // queued on the governor (autoscaler demand signal)
		const release = await gov.admit(eb, {
			reserveTokens: reserve,
			onQueued: (info) =>
				emit({ t: "queued", queue_depth: info.queueDepth, window_pct: gov.windowPct(), load_pct: gov.loadPct() }),
			onAdmitted: (info) =>
				emit({ t: "admitted", waited_ms: info.waitedMs, window_pct: gov.windowPct(), load_pct: gov.loadPct() }),
		});
		bump(waitingByBundle, agent, -1);
		bump(inflightByBundle, agent, 1); // admitted & running
		emit({ t: "spawned", model: eb.model_tier, window_pct: gov.windowPct(), load_pct: gov.loadPct() }); // -> the observability dashboard
		fleet?.onAgentEvent({ t: "spawned" }); // event-driven scale nudge so a burst doesn't wait a full tick
		try {
			const exec = () =>
				t === "pool"
					? spawnViaPool(eb, prompt, {
							runDir: runDir(ctx),
							taskId: task_id,
							verify,
							protected: protectedList,
							root,
						})
					: spawnAgent(eb, prompt, {
							runDir: runDir(ctx),
							taskId: task_id,
							verify,
							protected: protectedList,
							root,
							onEvent: (ev) => {
								if (ev?.type === "tool_execution_start") emit({ t: "tool", tool: ev.toolName, phase: "start" });
								else if (ev?.type === "tool_execution_end") emit({ t: "tool", phase: "end" });
							},
						});
			let r: any;
			let source = "miss";
			if (cacheable) {
				const out = await cache!.run(key, exec);
				r = out.result;
				source = out.source;
			} else {
				r = await exec();
			}
			// Only a real execution (a cache MISS) spends window tokens; hits/dedups cost nothing.
			const spent = source === "miss" ? estimateTokens(prompt.length + (r.meta?.bytes ?? 0)) : 0;
			logSpawn(eb, r, spent);
			emit({ t: "done", status: r.status, verify: r.verify?.passed, window_pct: gov.windowPct(), cached: r.cached });
			return r;
		} catch (err) {
			emit({ t: "done", status: "failed" });
			throw err;
		} finally {
			bump(inflightByBundle, agent, -1);
			release();
		}
	}
	const fmt = (r: any) =>
		r.error
			? `[${r.agent} → failed] ${r.error}`
			: `[${r.agent} → ${r.status} · contract ${r.contract.passed ? "PASS" : `FAIL:${r.contract.missing.join(",")}`}` +
				`${r.verify ? ` · verify ${r.verify.passed ? "PASS" : "FAIL"}` : ""} · ${r.meta.model} ${r.meta.elapsed_s.toFixed(0)}s]` +
				`${r.verify && !r.verify.passed ? `\nverify output: ${r.verify.output.slice(-300)}` : ""}\n\n${r.artifact_excerpt}`;

	// Build a structured reviewer metaprompt embedding the original task, builder summary, and diff.
	function reviewerPrompt(task: string, summary: string, diff: string): string {
		return [
			'ROLE: You are a code reviewer (the "reviewer" specialist) verifying a builder\'s work.',
			"",
			"TASK: Verify that the git diff below correctly implements the task, introduces no regressions, and meets all acceptance criteria.",
			"",
			"## Original task",
			task,
			"",
			"## Builder change-summary",
			summary,
			"",
			"## Git diff",
			"```diff",
			diff.slice(0, 12000),
			"```",
			"",
			"ACCEPTANCE: End your reply with exactly:",
			"## verdict",
			"APPROVE or REJECT with a one-line reason.",
			"## claims",
			"List each claim you verified.",
			"## could-not-verify",
			"List anything you could not check from the diff alone.",
		].join("\n");
	}

	// Judge metaprompt for best-of-N: number each surviving candidate so parseQuorumPick can read the pick.
	function quorumPrompt(task: string, survivors: { artifact_excerpt?: string }[]): string {
		const cands = survivors
			.map((s, i) => `## candidate ${i}\n${String(s.artifact_excerpt ?? "").slice(0, 4000)}`)
			.join("\n\n");
		return [
			"ROLE: You are a judge selecting the single best of several independent candidate solutions.",
			"",
			"## Original task",
			task,
			"",
			cands,
			"",
			"ACCEPTANCE: End your reply with exactly:",
			"## verdict",
			"APPROVE candidate <N> — one-line reason (N is the candidate number above).",
		].join("\n");
	}

	summon.registerTool({
		name: "spawn_agent",
		label: "Spawn specialised sub-agent",
		description: `Delegate ONE task to a specialised sub-agent; returns its result + output-contract verdict. You write the metaprompt (ROLE/TASK/SCOPE/INPUTS/TOOLS/ACCEPTANCE/TERMINAL/DO-NOT).\nRegistry (name[tier; tools; ->contract]): ${digest}\nFull index: ${indexPath}`,
		parameters: Type.Object({
			agent: Type.String({ description: `one of: ${names}` }),
			prompt: Type.String({ description: "the metaprompt for the sub-agent" }),
			task_id: Type.Optional(Type.String()),
			verify: Type.Optional(
				Type.String({
					description:
						"a shell ACCEPTANCE command the HARNESS runs itself (deterministic; overrides the agent's claim). e.g. 'pytest tests/test_x.py'",
				}),
			),
			review: Type.Optional(
				Type.Boolean({
					description:
						"after a write-capable build completes 'done', auto-run the reviewer over the git diff; result fails unless the reviewer APPROVEs",
				}),
			),
			transport: Type.Optional(
				Type.Union([Type.Literal("oneshot"), Type.Literal("pool")], {
					description:
						"execution transport: 'oneshot' (default, cold summon -p) or 'pool' (warm summon --mode rpc worker, reused across tasks)",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const task_id = p.task_id ?? p.agent;
			const transport: "oneshot" | "pool" | undefined = p.transport;
			const bundle = registry.get(p.agent);
			const isWriteCapable = bundle
				? bundle.tools.some((t: string) => ["write", "edit", "bash"].includes(t))
				: false;
			const reviewerBundle = registry.get("reviewer");

			if (p.review && isWriteCapable && reviewerBundle) {
				const outcome = await runWithReview(
					() => runOne(p.agent, p.prompt, task_id, ctx, p.verify, transport),
					async (b) => {
						let diff = "";
						try {
							diff = execSync(`git -C ${JSON.stringify(root)} diff`, {
								encoding: "utf8",
								maxBuffer: 10 * 1024 * 1024,
							});
						} catch {
							diff = "";
						}
						const rp = reviewerPrompt(p.prompt, b.artifact_excerpt, diff);
						return runOne("reviewer", rp, `${task_id}-review`, ctx);
					},
				);
				const verdict = outcome.approved ? "APPROVED" : `REJECTED — ${outcome.reason}`;
				const text =
					fmt(outcome.build) +
					"\n\n=== REVIEW: " +
					verdict +
					" ===\n\n" +
					(outcome.review ? fmt(outcome.review) : "");
				return { content: [{ type: "text", text }], details: outcome, isError: !outcome.approved };
			}

			// Default path — transport threaded; oneshot behaviour byte-for-byte unchanged
			const r = await runOne(p.agent, p.prompt, task_id, ctx, p.verify, transport);
			return { content: [{ type: "text", text: fmt(r) }], details: r, isError: r.status === "failed" };
		},
	});

	summon.registerTool({
		name: "spawn_quorum",
		label: "Best-of-N: spawn K candidates, verify-filter, judge the winner",
		description: `Run ONE agent N times in parallel, KEEP only candidates that pass deterministic verify+contract, then pick a winner by majority vote (an LLM judge breaks ties). Turns more attempts into more certainty for high-stakes tasks. N is capped at ${QUORUM_MAX}.\nRegistry: ${digest}`,
		parameters: Type.Object({
			agent: Type.String({ description: `one of: ${names}` }),
			prompt: Type.String({
				description: "the metaprompt; each candidate additionally gets an independent variant seed",
			}),
			n: Type.Optional(
				Type.Integer({ minimum: 2, description: `candidates to spawn (default 3, capped at ${QUORUM_MAX})` }),
			),
			verify: Type.Optional(Type.String({ description: "shell ACCEPTANCE command the harness runs per candidate" })),
			task_id: Type.Optional(Type.String()),
			judge: Type.Optional(
				Type.String({ description: "agent to break ties when candidates diverge (default 'reviewer')" }),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			if (!registry.has(p.agent))
				return {
					content: [{ type: "text", text: `no such agent '${p.agent}'. have: ${names}` }],
					isError: true,
					details: undefined,
				};
			const taskId = p.task_id ?? `${p.agent}-quorum`;
			const N = Math.min(QUORUM_MAX, Math.max(2, p.n ?? 3));
			const judgeAgent = p.judge ?? "reviewer";
			const { session, runId } = startRun("fanout", "spawn_quorum", { agent: p.agent, n: N }, ctx);
			const trace = RUN_REPORT && session && runId ? new GovernorTrace() : null;
			const startedAt = Date.now();
			trace?.subscribe(summon.events);
			try {
				const candidates = Array.from(
					{ length: N },
					(_v, i) => () =>
						runOne(
							p.agent,
							`${p.prompt}\n\n## VARIANT SEED ${i}\nExplore an independent approach; do not assume other attempts exist.`,
							`${taskId}#${i}`,
							ctx,
							p.verify,
						),
				);
				const judge = async (survivors: { artifact_excerpt?: string }[]) => {
					if (!registry.has(judgeAgent))
						return {
							agent: judgeAgent,
							status: "failed" as const,
							artifact_excerpt: "",
							contract: { passed: false, missing: [] },
							meta: { model: "", elapsed_s: 0, bytes: 0 },
						};
					return runOne(judgeAgent, quorumPrompt(p.prompt, survivors), `${taskId}-judge`, ctx);
				};
				const outcome = await runQuorum(candidates, judge, { maxN: N });
				// Surface the verdict on the live dashboard bus (Bet 1) — not only the durable journal below.
				summon.events?.emit?.("agent-event", {
					t: "quorum",
					id: taskId,
					agent: p.agent,
					agreement: outcome.agreement,
					decidedBy: outcome.decidedBy,
					groupSize: outcome.groupSize,
					survivors: outcome.survivors.length,
					candidates: N,
					won: !!outcome.winner,
					ts: Date.now(),
				});
				if (session) {
					session.append("quorum_decided", {
						node: taskId,
						agreement: outcome.agreement,
						decidedBy: outcome.decidedBy,
						survivors: outcome.survivors.length,
						candidates: N,
						groupSize: outcome.groupSize ?? null,
					});
					session.append("run_finished", { status: outcome.winner ? "done" : "failed" });
				}
				if (trace && runId) {
					try {
						const report = buildQuorumReport({
							runId,
							name: "spawn_quorum",
							agent: p.agent,
							prompt: p.prompt,
							outcome,
							governor: trace.snapshot(),
							startedAt,
							finishedAt: Date.now(),
						});
						writeRunReport(RUNS_DIR, runId, report);
					} catch {
						/* report is observability-only — never fail the run */
					}
				}
				const text = outcome.winner
					? `${fmt(outcome.winner)}\n\n=== QUORUM: ${outcome.agreement} via ${outcome.decidedBy} (${outcome.survivors.length}/${N} survived) ===`
					: `quorum failed — 0/${N} candidates passed verify+contract`;
				return { content: [{ type: "text", text }], details: { ...outcome, runId }, isError: !outcome.winner };
			} finally {
				trace?.stop();
			}
		},
	});

	summon.registerTool({
		name: "run_team",
		label: "Run a named team (sequential stages, parallel steps)",
		description: `Run a named team recipe — stages run sequentially, steps within a stage run in parallel. Available teams are loaded from global + project-local .summon/teams/ directories.`,
		parameters: Type.Object({
			team: Type.String({ description: 'name of the team to run (e.g. "build-review")' }),
			vars: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "template variables to fill {{placeholders}} in step prompts",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const teams = loadTeams(registry, process.cwd());
			const team = teams.get(p.team);
			if (!team) {
				const available = [...teams.keys()].join(", ") || "(none loaded)";
				return {
					content: [{ type: "text", text: `team '${p.team}' not found. available: ${available}` }],
					isError: true,
					details: undefined,
				};
			}
			try {
				// Durable session: journal each step so a crashed team run is discoverable + resumable.
				const { session, runId } = startRun("team", p.team, { vars: p.vars ?? {} }, ctx);
				const outcome = await runTeam(
					team,
					p.vars ?? {},
					(agent, prompt) => runOne(agent, prompt, `${p.team}:${agent}`, ctx),
					{ journal: journalOf(session) },
				);
				if (session) session.append("run_finished", { status: "done" });
				const text = runId ? `${renderTeam(outcome)}\n\n(durable run: ${runId})` : renderTeam(outcome);
				return { content: [{ type: "text", text }], details: { ...outcome, runId } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `run_team failed: ${msg}` }], isError: true, details: undefined };
			}
		},
	});

	// Deterministic CODE-node executor: the HARNESS runs the shell command itself (the agent never
	// touches it). Validated non-destructive at load; re-guarded here at run time (defence in depth).
	function runCodeNode(cmd: string): NodeRun {
		if (isDestructiveCmd(cmd)) return { ok: false, output: "blocked: destructive command" };
		try {
			const out = execSync(cmd, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 180000 });
			return { ok: true, output: out.slice(-2000) };
		} catch (e: unknown) {
			const ex = e as { stdout?: string; stderr?: string; message?: string };
			return {
				ok: false,
				output: ((ex.stdout ?? "") + (ex.stderr ?? "") || ex.message || "command failed").slice(-2000),
			};
		}
	}

	// ── durable run helpers (Phase 2/3): journal + resume + approval. The pure DAG/team logic lives in
	//    blueprint.ts/teams.ts (unit-tested); these are the thin wiring shared by run_blueprint /
	//    resume_run / approve_gate. ──
	function blueprintExec(ctx: any): BlueprintExec {
		return {
			runAgent: async (agent, prompt, node) => {
				// best_of (#6): run the node as a quorum — K candidates, verify-filter, judge the winner.
				if (node.best_of && node.best_of >= 2) {
					const N = Math.min(QUORUM_MAX, node.best_of);
					const candidates = Array.from(
						{ length: N },
						(_v, i) => () =>
							runOne(
								agent,
								`${prompt}\n\n## VARIANT SEED ${i}\nExplore an independent approach; do not assume other attempts exist.`,
								`${node.id}#${i}`,
								ctx,
								node.verify,
							),
					);
					const judge = (survivors: { artifact_excerpt?: string }[]) =>
						runOne("reviewer", quorumPrompt(prompt, survivors), `${node.id}-judge`, ctx);
					const outcome = await runQuorum(candidates, judge, { maxN: N });
					// Best-of verdict onto the live dashboard bus (Bet 1), mirroring spawn_quorum.
					summon.events?.emit?.("agent-event", {
						t: "quorum",
						id: node.id,
						agent,
						agreement: outcome.agreement,
						decidedBy: outcome.decidedBy,
						groupSize: outcome.groupSize,
						survivors: outcome.survivors.length,
						candidates: N,
						won: !!outcome.winner,
						ts: Date.now(),
					});
					return { ok: !!outcome.winner, output: outcome.winner?.artifact_excerpt ?? "", result: outcome };
				}
				const r = await runOne(agent, prompt, node.id, ctx, node.verify);
				return { ok: r.status === "done", output: r.artifact_excerpt ?? "", result: r };
			},
			runCode: async (cmd) => runCodeNode(cmd),
		};
	}

	async function executeBlueprint(
		bp: Blueprint,
		vars: Record<string, string>,
		ctx: any,
		session: RunSession | null,
		resume?: ReturnType<typeof blueprintResume>,
		runId?: string | null,
	): Promise<BlueprintOutcome> {
		// Capture the governor time-series for the whole run when the report is on. Subscribe BEFORE the run
		// so no event is missed; the bus handle is held and stopped in the finally so a listener never leaks.
		const trace = RUN_REPORT && session && runId ? new GovernorTrace() : null;
		const startedAt = Date.now();
		trace?.subscribe(summon.events);
		try {
			const outcome = await runBlueprint(bp, vars, blueprintExec(ctx), {
				journal: journalOf(session),
				resume: resume
					? { done: resume.done, failedOrSkipped: resume.failedOrSkipped, output: resume.output }
					: undefined,
				isApproved: resume ? (n: BlueprintNode) => resume.approved.has(n.id) : undefined,
			});
			// runBlueprint journals run_finished:paused itself; the caller owns the terminal done/failed mark.
			if (session && !outcome.paused) {
				const failed = outcome.nodes.some((n) => n.status === "failed" || n.status === "skipped");
				session.append("run_finished", { status: failed ? "failed" : "done" });
			}
			// Assemble + flush the report at the terminal seam (skip a paused run — it emits on the resume's
			// terminal mark). Best-effort: a write failure must never propagate into the run result.
			if (trace && runId && !outcome.paused) {
				try {
					const report = buildBlueprintReport({
						runId,
						name: bp.name,
						bp,
						outcome,
						governor: trace.snapshot(),
						startedAt,
						finishedAt: Date.now(),
					});
					writeRunReport(RUNS_DIR, runId, report);
				} catch {
					/* report is observability-only — never fail the run */
				}
			}
			return outcome;
		} finally {
			trace?.stop();
		}
	}

	function renderBlueprint(outcome: BlueprintOutcome, runId: string | null): string {
		const body = outcome.nodes
			.map((n) => {
				const head = `=== ${n.id} [${n.kind}${n.agent ? `:${n.agent}` : ""}] -> ${n.status} ===`;
				if (n.status === "skipped")
					return `${head}\nskipped (upstream not done: ${(n.skipped_by ?? []).join(", ")})`;
				if (n.status === "awaiting_approval") return `${head}\n\u23f8 awaiting approval`;
				return `${head}\n${n.output.slice(0, 1200)}`;
			})
			.join("\n\n");
		if (outcome.paused)
			return (
				`${body}\n\n\u23f8 PAUSED — awaiting approval on: ${(outcome.awaiting ?? []).join(", ")}` +
				(runId ? `\nApprove + resume:  approve_gate({ run_id: "${runId}", gate: "<node>", approved: true })` : "")
			);
		return runId ? `${body}\n\n(durable run: ${runId})` : body;
	}

	function renderTeam(outcome: { stages: any[][] }): string {
		return outcome.stages
			.map((stage, i) => {
				const stepTexts = stage
					.map((step: any) => (step.resumed ? `[${step.agent} → resumed (done in prior run)]` : fmt(step.result)))
					.join("\n\n---\n\n");
				return `=== Stage ${i + 1} ===\n\n${stepTexts}`;
			})
			.join("\n\n");
	}

	// Resume any durable run from its log: blueprint = full DAG resume (skip done nodes, release granted
	// gates); team = skip-done re-run. Returns rendered text + the outcome.
	async function resumeRun(runId: string, ctx: any): Promise<{ text: string; outcome?: unknown; isError: boolean }> {
		const path = runEventsPath(RUNS_DIR, runId);
		if (!existsSync(path)) return { text: `run '${runId}' not found`, isError: true };
		const events = readEvents(path);
		const meta = runMeta(events);
		if (!meta) return { text: `run '${runId}' has no run_started — cannot resume`, isError: true };
		const session = RunSession.resume(path);
		if (meta.kind === "blueprint") {
			// A3: a GENERATED DAG is reconstructed from the embedded meta (it was never written to disk); a
			// named blueprint is still loaded from disk by name.
			const bp =
				meta.generated && meta.blueprint ? meta.blueprint : loadBlueprints(registry, process.cwd()).get(meta.name);
			if (!bp) return { text: `blueprint '${meta.name}' no longer exists`, isError: true };
			const outcome = await executeBlueprint(bp, meta.vars ?? {}, ctx, session, blueprintResume(events), runId);
			const failed = outcome.nodes.some((n) => n.status === "failed" || n.status === "skipped");
			return { text: renderBlueprint(outcome, runId), outcome, isError: failed && !outcome.paused };
		}
		if (meta.kind === "team") {
			const team = loadTeams(registry, process.cwd()).get(meta.name);
			if (!team) return { text: `team '${meta.name}' no longer exists`, isError: true };
			const st = deriveState(events);
			const done = new Set([...st.nodes].filter(([, o]) => o === "done").map(([id]) => id));
			const recorded = new Map([...st.outputs].map(([k, v]) => [k, { status: "done", artifact_excerpt: v }]));
			const outcome = await runTeam(team, meta.vars ?? {}, (a, p) => runOne(a, p, `${team.name}:${a}`, ctx), {
				journal: journalOf(session),
				skipDone: done,
				recorded,
			});
			session.append("run_finished", { status: "done" });
			return { text: renderTeam(outcome), outcome, isError: false };
		}
		return { text: `resume not supported for run kind '${meta.kind}' (ledger only)`, isError: true };
	}

	summon.registerTool({
		name: "run_blueprint",
		label: "Run a code-defined DAG (deterministic code + scoped agent nodes)",
		description:
			"Run a named blueprint: a DAG of CODE nodes (the harness runs shell deterministically) and AGENT nodes " +
			"(scoped specialists). Nodes run as soon as their depends_on are done (wide parallelism); a failed node " +
			"fail-closes its dependents. Upstream output is available downstream via {{node.<id>}}.",
		parameters: Type.Object({
			blueprint: Type.String({ description: "name of the blueprint to run" }),
			vars: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "template variables to fill {{placeholders}} in node prompts/commands",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const blueprints = loadBlueprints(registry, process.cwd());
			const bp: Blueprint | undefined = blueprints.get(p.blueprint);
			if (!bp) {
				const available = [...blueprints.keys()].join(", ") || "(none loaded)";
				return {
					content: [{ type: "text", text: `blueprint '${p.blueprint}' not found. available: ${available}` }],
					isError: true,
					details: undefined,
				};
			}
			try {
				// Durable session: journal the run so a crash or approval-pause is discoverable + resumable.
				const { session, runId } = startRun("blueprint", p.blueprint, { vars: p.vars ?? {} }, ctx);
				const outcome = await executeBlueprint(bp, p.vars ?? {}, ctx, session, undefined, runId);
				const failed = outcome.nodes.some((n) => n.status === "failed" || n.status === "skipped");
				return {
					content: [{ type: "text", text: renderBlueprint(outcome, runId) }],
					details: { ...outcome, runId },
					isError: failed && !outcome.paused, // a paused run is not an error — it awaits approval
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `run_blueprint failed: ${msg}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	// ── auto-planner (#5): synthesize a validated, runnable blueprint DAG from a goal ────────────────
	// A frontier, read-only, no-delegation planner that can never write JSON to disk or spawn workers.
	function makePlannerBundle(): AgentBundle {
		return {
			name: "auto-planner",
			role: "decompose a goal into a validated blueprint DAG",
			model_tier: "frontier",
			tools: ["read", "grep", "find", "ls"],
			output_contract: { required_sections: ["```json"] },
			max_attempts: 1, // the OUTER withRetry owns the parse/validate retry
			timeout_s: 600,
		};
	}
	function planPrompt(goal: string, vars: Record<string, string> | undefined, prev?: any): string {
		const base = [
			"ROLE: You are an orchestration planner. Decompose the GOAL into a blueprint DAG of CODE nodes",
			"(deterministic shell the harness runs itself) and AGENT nodes (scoped specialists).",
			"",
			`## Goal\n${goal}`,
			vars && Object.keys(vars).length ? `\n## Vars\n${JSON.stringify(vars)}` : "",
			"",
			`## Available specialist agents (use ONLY these as a node's "agent")\n${digest}`,
			"",
			"## Output contract",
			"Emit ONLY the blueprint as the LAST fenced ```json block, with nothing after it. Schema:",
			'{ "name": string, "description"?: string, "nodes": [ { "id": string, "depends_on"?: string[],',
			'  EITHER "run": string (a non-destructive shell command) OR "agent": string + "prompt": string,',
			'  "verify"?: string, "fan_out_from"?: string, "fan_out_limit"?: number } ] }',
			`Rules: unique ids; acyclic; at most ${PLAN_MAX_NODES} nodes; each node is EITHER code OR agent (never both);`,
			"agent ids must be in the roster above and never a delegation agent; reference upstream output only via",
			"{{node.<id>}} for a declared depends_on.",
		].join("\n");
		return prev ? retryPrompt(base, prev) : base;
	}
	function renderGeneratedPlan(bp: Blueprint, notes: string[]): string {
		const lines = bp.nodes.map((n) => {
			const kind = n.run !== undefined ? "code" : `agent:${n.agent}`;
			const deps = (n.depends_on ?? []).length ? ` depends_on=[${(n.depends_on ?? []).join(",")}]` : "";
			const gate = n.requires_approval ? " [approval]" : "";
			return `  - ${n.id} [${kind}]${deps}${gate}`;
		});
		return [
			`PLAN: ${bp.name} (${bp.nodes.length} nodes, dry run)`,
			...lines,
			...(notes.length ? ["", "notes:", ...notes.map((x) => `  - ${x}`)] : []),
		].join("\n");
	}
	async function planAndRun(
		goal: string,
		vars: Record<string, string> | undefined,
		ctx: any,
		dryRun: boolean,
	): Promise<{ content: { type: "text"; text: string }[]; details: unknown; isError: boolean }> {
		const planner = makePlannerBundle();
		// Holder (not a closure-mutated `let`) so the validated DAG narrows cleanly after withRetry.
		const holder: { bp: Blueprint | null; notes: string[] } = { bp: null, notes: [] };
		// OUTER retry: spawn the planner, parse + normalize + validate; feed the validator error back on a miss.
		const result = await withRetry(2, async (_attempt, prev) => {
			const r = await spawnAgent(planner, planPrompt(goal, vars, prev), {
				runDir: runDir(ctx),
				taskId: "auto-planner",
				protected: protectedList,
				root,
			});
			const parsed = parseBlueprintFromText(r.artifact_excerpt ?? "");
			if (parsed.error)
				return { ...r, status: "contract_violation", contract: { passed: false, missing: [parsed.error] } };
			try {
				const norm = normalizeGeneratedBlueprint(parsed.bp!, {
					maxNodes: PLAN_MAX_NODES,
					fanOutCap: PLAN_FANOUT_CAP,
					forceApprovalOnWrite: true, // every CODE node must be approved before it can run
				});
				validateBlueprint(norm.bp, registry); // the EXISTING fail-closed gate
				holder.bp = norm.bp;
				holder.notes = norm.notes;
			} catch (e) {
				return {
					...r,
					status: "contract_violation",
					contract: { passed: false, missing: [e instanceof Error ? e.message : String(e)] },
				};
			}
			return { ...r, status: "done" };
		});
		const bp = holder.bp;
		if (!bp)
			return {
				content: [
					{
						type: "text" as const,
						text: `plan_and_run: planner did not produce a valid blueprint\n\n${(result.artifact_excerpt ?? "").slice(0, 1500)}`,
					},
				],
				details: result,
				isError: true,
			};
		if (dryRun)
			return {
				content: [{ type: "text" as const, text: renderGeneratedPlan(bp, holder.notes) }],
				details: { blueprint: bp, notes: holder.notes },
				isError: false,
			};
		// Embed the generated DAG in the run meta (A3): a synthesized blueprint isn't on disk, so a
		// cross-process resume after a crash reconstructs it from the log instead of loadBlueprints.
		const { session, runId } = startRun(
			"blueprint",
			bp.name,
			{ vars: vars ?? {}, generated: true, blueprint: bp },
			ctx,
		);
		const outcome = await executeBlueprint(bp, vars ?? {}, ctx, session, undefined, runId);
		const failed = outcome.nodes.some((n) => n.status === "failed" || n.status === "skipped");
		return {
			content: [{ type: "text" as const, text: renderBlueprint(outcome, runId) }],
			details: { ...outcome, runId },
			isError: failed && !outcome.paused,
		};
	}

	summon.registerTool({
		name: "plan_and_run",
		label: "Plan a DAG from a goal and (optionally) run it",
		description: `Synthesise a structurally-validated blueprint DAG from a natural-language GOAL using the frontier planner, then ${PLAN_RUN_ENABLED ? "run it inline" : "return the plan (execution disabled — set HARNESS_PLAN_RUN=1)"}. dry_run:true always returns the validated DAG without executing.\nRegistry: ${digest}`,
		parameters: Type.Object({
			goal: Type.String({ description: "the goal to decompose into a DAG" }),
			vars: Type.Optional(Type.Record(Type.String(), Type.String())),
			dry_run: Type.Optional(
				Type.Boolean({
					description: "return the validated DAG without executing (forced true unless HARNESS_PLAN_RUN=1)",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const dry = p.dry_run === true || !PLAN_RUN_ENABLED;
			try {
				return await planAndRun(p.goal, p.vars, ctx, dry);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `plan_and_run failed: ${msg}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	summon.registerTool({
		name: "resume_run",
		label: "Resume a durable run (crashed or approval-paused)",
		description:
			"Resume a durable blueprint/team run from its append-only event log: completed nodes are NOT " +
			"re-run, granted approval gates are released. Run ids appear in the boot 'resumable-runs' event.",
		parameters: Type.Object({ run_id: Type.String({ description: "the durable run id to resume" }) }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const r = await resumeRun(p.run_id, ctx);
			return { content: [{ type: "text", text: r.text }], details: r.outcome, isError: r.isError };
		},
	});

	summon.registerTool({
		name: "approve_gate",
		label: "Approve or deny a paused run's gate (human-in-the-loop)",
		description:
			"Decide a human-approval gate on a paused durable run. approved:true releases the gate and " +
			"auto-resumes the run from where it paused; approved:false halts it. The gate id is the paused node's id.",
		parameters: Type.Object({
			run_id: Type.String(),
			gate: Type.String({ description: "the gate id (the paused node's id)" }),
			approved: Type.Boolean(),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const path = runEventsPath(RUNS_DIR, p.run_id);
			if (!existsSync(path))
				return {
					content: [{ type: "text", text: `run '${p.run_id}' not found` }],
					isError: true,
					details: undefined,
				};
			const session = RunSession.resume(path);
			session.append("approval_decided", { gate: p.gate, approved: !!p.approved });
			if (!p.approved) {
				session.append("run_finished", { status: "failed" });
				return {
					content: [{ type: "text", text: `gate '${p.gate}' DENIED — run ${p.run_id} halted` }],
					isError: false,
					details: undefined,
				};
			}
			const r = await resumeRun(p.run_id, ctx); // auto-resume now that the gate is granted
			return {
				content: [{ type: "text", text: `gate '${p.gate}' APPROVED — resuming…\n\n${r.text}` }],
				details: r.outcome,
				isError: r.isError,
			};
		},
	});

	summon.registerTool({
		name: "spawn_agents",
		label: "Spawn sub-agents in parallel",
		description: `Run MULTIPLE specialised sub-agents CONCURRENTLY (wide fan-out) — use for independent tasks. Independent tasks run concurrently; a pre-warmed agent always uses its hot pool, and same-agent batches of ≥8 auto-use the warm worker pool (≈30-47% faster), else cold one-shot. Override with transport.\nRegistry: ${digest}`,
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					agent: Type.String(),
					prompt: Type.String(),
					task_id: Type.Optional(Type.String()),
					verify: Type.Optional(Type.String({ description: "shell ACCEPTANCE command the harness runs itself" })),
				}),
				{ description: "independent tasks to run at once" },
			),
			transport: Type.Optional(
				Type.Union([Type.Literal("oneshot"), Type.Literal("pool")], {
					description:
						"force a transport for the whole batch; default is adaptive (pool only for ≥8 same-agent tasks)",
				}),
			),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const counts = new Map<string, number>();
			for (const t of p.tasks) counts.set(t.agent, (counts.get(t.agent) ?? 0) + 1);
			// Durable ledger: journal each task (node_started/node_done) so a crashed fan-out is discoverable.
			const { session, runId } = startRun("fanout", "spawn_agents", {}, ctx);
			const journal = journalOf(session);
			const results = await Promise.all(
				p.tasks.map(async (t: any, i: number) => {
					const taskId = t.task_id ?? `${t.agent}-${i}`;
					journal?.({ type: "node_started", node: taskId, agent: t.agent });
					const r = await runOne(
						t.agent,
						t.prompt,
						taskId,
						ctx,
						t.verify,
						pickTransport(counts.get(t.agent) ?? 0, p.transport, isPrewarmed(t.agent)),
					);
					journal?.({
						type: "node_done",
						node: taskId,
						status: r.status === "done" ? "done" : "failed",
						output_excerpt: String(r.artifact_excerpt ?? "").slice(0, 1500),
					});
					return r;
				}),
			);
			if (session) session.append("run_finished", { status: "done" });
			return {
				content: [{ type: "text", text: results.map(fmt).join("\n\n---\n\n") }],
				details: { results, runId },
			};
		},
	});

	// Scale dial (#4): retune the live concurrency cap (and the autoscaler's per-bundle ceiling) at runtime.
	summon.registerCommand?.("harness-scale", {
		description:
			"Scale dial: show | auto | eco | turbo | fixed:N — retune the live concurrency cap + autoscaler ceiling.",
		handler: async (args: string, ctx: any) => {
			const a = (args ?? "").trim();
			if (!a || a === "show") {
				ctx?.ui?.notify?.(`harness scale: ${scaleLabel(activeScale)} — maxWeight ${gov.maxWeightCap()}`, "info");
				return;
			}
			activeScale = resolveScaleMode(a);
			const params = scaleParams(activeScale, {
				maxWeight,
				budgetTokens: Number(process.env.HARNESS_WINDOW_TOKENS ?? 0),
			});
			gov.setMaxWeight(params.maxWeight);
			// Single-source the per-bundle ceiling across the governor's autoscaler dial AND the live pool band,
			// so a runtime scale change resizes existing pools immediately (A7) — not only pools created later.
			const cap = Math.max(params.poolSize, params.maxWeight);
			fleet?.setMaxPerBundle(cap);
			setPoolBand(0, cap);
			summon.events?.emit?.("agent-event", {
				id: "fleet",
				agent: "harness",
				ts: Date.now(),
				t: "scaling",
				window_pct: gov.windowPct(),
				load_pct: gov.loadPct(),
			});
			ctx?.ui?.notify?.(`harness scale → ${scaleLabel(activeScale)} (maxWeight ${gov.maxWeightCap()})`, "info");
		},
	});

	// On shutdown: drain warm pools (no orphaned rpc procs) and write the cross-run fleet digest (#8).
	summon.on?.("session_shutdown", async () => {
		fleet?.stop();
		await drainAllPools();
		try {
			writeFileSync(FLEET_SUMMARY, fleetDigest(aggregateFleet(readFleet(FLEET_LEDGER))));
		} catch {
			/* best-effort */
		}
	});
}
