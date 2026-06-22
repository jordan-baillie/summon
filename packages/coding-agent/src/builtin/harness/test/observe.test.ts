// Phase 3 observability — reducer + render. node --experimental-strip-types --test test/observe.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	counts,
	emptyVM,
	isAnimating,
	reduce,
	renderFooter,
	renderWidget,
	setExpanded,
	summonStreak,
} from "../src/observe.ts";

const feed = (events: any[]) => {
	const vm = emptyVM();
	for (const e of events) reduce(vm, e);
	return vm;
};

test("reducer tracks spawned -> tool -> done with verify", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 },
		{ t: "spawned", id: "b", agent: "builder", model: "standard", ts: 1 },
		{ t: "tool", id: "a", tool: "read", phase: "start", ts: 2 },
		{ t: "done", id: "a", status: "done", verify: true, ts: 5 },
	]);
	assert.equal(vm.agents.size, 2);
	assert.equal(vm.agents.get("a")!.status, "done");
	assert.equal(vm.agents.get("a")!.verify, true);
	assert.equal(vm.agents.get("b")!.status, "running");
	const c = counts(vm);
	assert.deepEqual([c.total, c.run, c.ok, c.bad], [2, 1, 1, 0]);
});

test("verify_failed and failed count as bad", () => {
	const vm = feed([
		{ t: "spawned", id: "x", agent: "builder", model: "standard", ts: 1 },
		{ t: "done", id: "x", status: "verify_failed", ts: 2 },
		{ t: "spawned", id: "y", agent: "scout", model: "fast", ts: 1 },
		{ t: "done", id: "y", status: "failed", ts: 2 },
	]);
	assert.equal(counts(vm).bad, 2);
});

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("renderWidget = SUMMON header + one row per agent", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: Date.now() },
		{ t: "tool", id: "a", tool: "grep", phase: "start", ts: Date.now() },
	]);
	const plain = renderWidget(vm).map(stripAnsi);
	assert.ok(plain[0].includes("SUMMON"), "header has the SUMMON wordmark");
	assert.ok(
		plain.some((l) => l.includes("scout")),
		"shows the agent name",
	);
	assert.ok(
		plain.some((l) => l.includes("‹fast›")),
		"shows the model chip",
	);
	assert.ok(
		plain.some((l) => l.includes("grep")),
		"shows the running agent's current tool",
	);
});

test("malformed events are ignored; footer always renders", () => {
	const vm = emptyVM();
	for (const e of [null, undefined, {}, { t: "tool" }, { t: "spawned" }]) reduce(vm, e);
	assert.equal(vm.agents.size, 0);
	assert.ok(stripAnsi(renderFooter(vm)).includes("▸0"), "footer renders zeroed counts");
});

// ── NEW: timeline, setExpanded, drill-in render (frozen) ────────────────────

test("reduce builds a per-agent tool timeline (open/closed)", () => {
	const vm = emptyVM();
	reduce(vm, { t: "spawned", id: "t", agent: "scout", model: "haiku", ts: 1 });
	reduce(vm, { t: "tool", id: "t", tool: "read", phase: "start", ts: 2 });
	reduce(vm, { t: "tool", id: "t", phase: "end", ts: 3 });
	reduce(vm, { t: "tool", id: "t", tool: "grep", phase: "start", ts: 4 });
	const a = vm.agents.get("t")!;
	assert.equal(a.timeline.length, 2);
	assert.deepEqual(a.timeline[0], { tool: "read", startedAt: 2, endedAt: 3 });
	assert.equal(a.timeline[1].tool, "grep");
	assert.equal(a.timeline[1].endedAt, undefined);
});

test("timeline caps at 12 entries", () => {
	const vm = emptyVM();
	reduce(vm, { t: "spawned", id: "t", agent: "scout", model: "haiku", ts: 0 });
	for (let i = 0; i < 15; i++) {
		reduce(vm, { t: "tool", id: "t", tool: `tool-${i}`, phase: "start", ts: i * 2 });
		reduce(vm, { t: "tool", id: "t", phase: "end", ts: i * 2 + 1 });
	}
	const a = vm.agents.get("t")!;
	assert.equal(a.timeline.length, 12);
	assert.equal(a.timeline[11].tool, "tool-14"); // most recent is kept
});

test("setExpanded cycles ids then off then wraps", () => {
	const vm = emptyVM();
	reduce(vm, { t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 });
	reduce(vm, { t: "spawned", id: "b", agent: "builder", model: "std", ts: 1 });
	setExpanded(vm, "next");
	assert.equal(vm.expanded, "a");
	setExpanded(vm, "next");
	assert.equal(vm.expanded, "b");
	setExpanded(vm, "next");
	assert.equal(vm.expanded, undefined);
	setExpanded(vm, "next");
	assert.equal(vm.expanded, "a");
});

test("setExpanded explicit id + off + unknown", () => {
	const vm = emptyVM();
	reduce(vm, { t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 });
	reduce(vm, { t: "spawned", id: "b", agent: "builder", model: "std", ts: 1 });
	setExpanded(vm, "b");
	assert.equal(vm.expanded, "b");
	setExpanded(vm, "off");
	assert.equal(vm.expanded, undefined);
	setExpanded(vm, "zzz");
	assert.equal(vm.expanded, undefined);
});

test("renderWidget drill-in: expanded shows the tool timeline, collapsed does not", () => {
	const vm = emptyVM();
	const now = Date.now();
	reduce(vm, { t: "spawned", id: "s", agent: "scout", model: "haiku", ts: now });
	reduce(vm, { t: "tool", id: "s", tool: "read", phase: "start", ts: now + 1 });
	reduce(vm, { t: "tool", id: "s", phase: "end", ts: now + 2 });
	reduce(vm, { t: "tool", id: "s", tool: "grep", phase: "start", ts: now + 3 });

	// collapsed: the COMPLETED tool 'read' (only in the timeline detail) must not appear
	const collapsed = renderWidget(vm).map(stripAnsi).join("\n");
	assert.ok(!collapsed.includes("read"), "collapsed must not show the completed-tool timeline");

	// expanded: the per-agent timeline appears (both tools), with the agent name + detail marker
	setExpanded(vm, "s");
	const expanded = renderWidget(vm).map(stripAnsi).join("\n");
	assert.ok(expanded.includes("read"), "expanded must show 'read'");
	assert.ok(expanded.includes("grep"), "expanded must show 'grep'");
	assert.ok(expanded.includes("▾"), "expanded must show the detail marker");
	assert.ok(expanded.includes("scout"), "expanded must show the agent name");
});

test("isAnimating: animate while an agent runs, quiesce when idle (no idle jutter)", () => {
	const now = 1_000_000;
	const idle = emptyVM();
	// Idle -> MUST be false so the animation timer stops (prevents the ~2Hz idle repaint).
	assert.equal(isAnimating(idle), false, "idle must not animate");
	// A running agent -> animate.
	const running = emptyVM();
	reduce(running, { t: "spawned", id: "a", agent: "builder", model: "sonnet", ts: now });
	assert.equal(isAnimating(running), true, "running agent must animate");
	// Once that agent finishes, idle again -> quiesce.
	reduce(running, { t: "done", id: "a", status: "done", ts: now + 5 });
	assert.equal(isAnimating(running), false, "finished agent must quiesce");
});

test("renderWidget: idle (no agents, no drill-in) renders NOTHING — clean prompt, no idle chrome", () => {
	assert.deepEqual(renderWidget(emptyVM()), []);
});

// ── governor / autoscale surfacing (#1/#3/#4) ───────────────────────────────────

test("reduce captures governor window_pct/load_pct off spawned and done (carry-forward)", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", window_pct: 30, load_pct: 50, ts: 1 },
		{ t: "done", id: "a", status: "done", window_pct: 35, ts: 2 },
	]);
	assert.equal(vm.governor?.windowPct, 35, "windowPct updates");
	assert.equal(vm.governor?.loadPct, 50, "loadPct carries forward when a later event omits it");
});

test("reduce tracks queue depth from queued and decrements on admitted", () => {
	const vm = feed([
		{ t: "queued", id: "q1", agent: "b", queue_depth: 3, load_pct: 90 },
		{ t: "admitted", id: "q1", agent: "b", waited_ms: 120 },
	]);
	assert.equal(vm.governor?.queued, 2, "admitted drops the queue depth by one (floored at 0)");
	assert.equal(vm.governor?.loadPct, 90);
});

test("reduce: governor/queued state does NOT make isAnimating true (jitter invariant)", () => {
	const vm = feed([
		{ t: "queued", id: "q1", agent: "b", queue_depth: 1, load_pct: 10, window_pct: 5 },
		{ t: "autoscale", id: "fleet", ticks: [{ bundle: "b", current: 0, target: 2, action: "grow" }] },
	]);
	assert.equal(isAnimating(vm), false, "no running agent -> the timer must still quiesce");
});

test("reduce: autoscale event populates vm.autoscale for the fleet panel", () => {
	const vm = feed([
		{ t: "autoscale", id: "fleet", ticks: [{ bundle: "builder", current: 1, target: 4, action: "grow" }] },
	]);
	assert.equal(vm.autoscale?.length, 1);
	assert.equal(vm.autoscale?.[0].target, 4);
});

test("renderWidget: governor gauge renders above the agents panel", () => {
	const vm = feed([{ t: "spawned", id: "a", agent: "b", model: "fast", window_pct: 40, load_pct: 75, ts: 1 }]);
	const lines = renderWidget(vm, 72, 0);
	assert.ok(
		lines.some((l) => l.includes("load") && l.includes("win")),
		"governor gauge present above the agents panel",
	);
});

test("renderWidget: byte-stable for identical (vm, frame)", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", window_pct: 20, load_pct: 40, ts: 1 },
		{ t: "done", id: "a", status: "done", ts: 2 }, // settled → per-agent duration is fixed
		{ t: "autoscale", id: "fleet", ticks: [{ bundle: "scout", current: 1, target: 2, action: "grow" }] },
	]);
	assert.deepEqual(renderWidget(vm, 72, 3), renderWidget(vm, 72, 3));
});

// ── load-shedding visibility (A1) ───────────────────────────────────────────────

test("reduce: shedding event tallies count + remembers the from→to downshift", () => {
	const vm = feed([
		{ t: "shedding", id: "x", from: "frontier", to: "standard", reason: "hot", window_pct: 92 },
		{ t: "shedding", id: "y", from: "standard", to: "fast", reason: "hot", window_pct: 95 },
	]);
	assert.equal(vm.shed?.count, 2);
	assert.equal(vm.shed?.from, "standard");
	assert.equal(vm.shed?.to, "fast");
	assert.equal(vm.governor?.windowPct, 95, "shedding carries the window signal too");
});

test("reduce: shedding does NOT make isAnimating true (jitter invariant)", () => {
	const vm = feed([{ t: "shedding", id: "x", from: "frontier", to: "standard", window_pct: 91 }]);
	assert.equal(isAnimating(vm), false, "a shed with no running agent must still quiesce the timer");
});

test("renderWidget: shed indicator appears in the governor line", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "b", model: "standard", window_pct: 92, load_pct: 99, ts: 1 },
		{ t: "shedding", id: "a", from: "frontier", to: "standard", window_pct: 92 },
	]);
	const lines = renderWidget(vm, 72, 0);
	assert.ok(
		lines.some((l) => l.includes("shed") && l.includes("frontier\u2192standard")),
		"shed N↓ from→to is visible on the governor line",
	);
});

// ── summoning fan-out streak (A2) ──────────────────────────────────────────────

test("reduce: spawned increments the burst tally", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "s", model: "fast", ts: 1 },
		{ t: "spawned", id: "b", agent: "s", model: "fast", ts: 2 },
	]);
	assert.equal(vm.burst?.count, 2);
	assert.equal(vm.burst?.lastAt, 2);
});

test("summonStreak: pure function of (count, frame) — byte-stable, length scales with count", () => {
	assert.equal(summonStreak(0, 5), "", "no streak with zero running");
	assert.equal(summonStreak(3, 7), summonStreak(3, 7), "identical inputs ⇒ identical bytes");
	// one › glyph per running agent (capped at 6); count the glyphs irrespective of color codes.
	const glyphs = (s: string) => (s.match(/\u203a/g) ?? []).length;
	assert.equal(glyphs(summonStreak(3, 0)), 3);
	assert.equal(glyphs(summonStreak(99, 0)), 6, "capped at 6");
});

test("renderWidget: streak paints only while agents run (not once settled)", () => {
	const running = feed([{ t: "spawned", id: "a", agent: "s", model: "fast", ts: 1 }]);
	assert.ok(renderWidget(running, 72, 0)[0].includes("\u203a"), "running fan-out shows the streak on the header rail");
	const settled = feed([
		{ t: "spawned", id: "a", agent: "s", model: "fast", ts: 1 },
		{ t: "done", id: "a", status: "done", ts: 2 },
	]);
	assert.ok(!renderWidget(settled, 72, 0)[0].includes("\u203a"), "settled run quiesces the streak");
});

// \u2500\u2500 pluggable layout switch + command-bridge (#layout) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

test("renderWidget default style is 'panel' and byte-identical to explicit panel", () => {
	const vm = feed([{ t: "spawned", id: "a", agent: "scout", model: "fast", load_pct: 63, window_pct: 0, ts: 1 }]);
	assert.deepEqual(renderWidget(vm, 72, 0), renderWidget(vm, 72, 0, "panel"));
});

test("renderWidget command-bridge: renders the ops console cells, different from panel", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", load_pct: 63, window_pct: 0, ts: 1 },
		{ t: "autoscale", id: "fleet", ticks: [{ bundle: "scout", current: 1, target: 0, action: "shrink" }] },
	]);
	const joined = renderWidget(vm, 72, 0, "command-bridge").map(stripAnsi).join("\n");
	assert.ok(joined.includes("[SUMMON]"), "SUMMON cell");
	assert.ok(joined.includes("[GOV]"), "governor cell");
	assert.ok(joined.includes("[AGENTS]"), "agents register");
	assert.ok(joined.includes("[FLEET HUD]"), "pinned fleet HUD when autoscaling");
	assert.ok(joined.includes("scout"), "shows the contact");
	assert.notEqual(
		joined,
		renderWidget(vm, 72, 0, "panel").map(stripAnsi).join("\n"),
		"command-bridge is a distinct layout",
	);
});

test("renderWidget command-bridge: every framed row is exactly W columns (clean rectangle)", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", load_pct: 63, window_pct: 0, ts: 1 },
		{ t: "done", id: "a", status: "done", ts: 2 },
		{ t: "spawned", id: "b", agent: "builder", model: "standard", ts: 3 },
		{ t: "autoscale", id: "fleet", ticks: [{ bundle: "scout", current: 1, target: 0, action: "shrink" }] },
	]);
	const framed = renderWidget(vm, 72, 0, "command-bridge")
		.map(stripAnsi)
		.filter((l) => /^[\u250c\u2502\u251c\u255e\u2514]/.test(l));
	const widths = new Set(framed.map((l) => [...l].length));
	assert.equal(widths.size, 1, `all framed rows must share one width; got ${[...widths].join(",")}`);
	assert.equal([...widths][0], 72, "rows fill the full width W");
});

test("renderWidget command-bridge: jitter-safe \u2014 isAnimating unchanged + byte-stable per (vm,frame)", () => {
	const vm = feed([{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 }]);
	assert.equal(isAnimating(vm), true, "a running agent still animates under command-bridge");
	assert.deepEqual(renderWidget(vm, 72, 2, "command-bridge"), renderWidget(vm, 72, 2, "command-bridge"));
	const idle = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 },
		{ t: "done", id: "a", status: "done", ts: 2 },
	]);
	assert.equal(isAnimating(idle), false, "command-bridge does not keep a settled run animating");
});

// ── TUI iteration: sparklines / row-collapse / pulse / hint bar / gradient (ideas 1–5) ──────────

test("idea1: reduce buffers a governor trend, only on real load/window measurements", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", load_pct: 20, window_pct: 10, ts: 1 },
		{ t: "queued", id: "q", queue_depth: 2 }, // queue-only event MUST NOT add a trend sample
		{ t: "scaling", id: "a", load_pct: 60, window_pct: 30 },
	]);
	assert.deepEqual(vm.govHist?.load, [20, 60], "one sample per measurement; queue-only ignored");
	assert.deepEqual(vm.govHist?.win, [10, 30]);
});

test("idea1: trend sampling does NOT make isAnimating true (jitter invariant)", () => {
	const vm = feed([
		{ t: "scaling", id: "x", load_pct: 10, window_pct: 5 },
		{ t: "scaling", id: "x", load_pct: 20, window_pct: 9 },
	]);
	assert.equal(vm.govHist?.load.length, 2);
	assert.equal(isAnimating(vm), false, "trend sampling with no running agent must still quiesce");
});

test("idea1: command-bridge renders the LOAD/WIN sparkline once ≥2 measurements exist", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", load_pct: 20, window_pct: 10, ts: 1 },
		{ t: "scaling", id: "a", load_pct: 60, window_pct: 30 },
	]);
	const lines = renderWidget(vm, 72, 0, "command-bridge").map(stripAnsi);
	// the gauge row is upper-case LOAD/WIN; the trend row is lower-case load/win.
	assert.ok(
		lines.some((l) => l.includes("load ") && !l.includes("LOAD")),
		"a lower-case sparkline trend row is present",
	);
});

test("idea2: duplicate settled agents collapse into a single ×N register row", () => {
	const evs: any[] = [];
	for (let i = 0; i < 6; i++) {
		evs.push({ t: "spawned", id: `s${i}`, agent: "scout", model: "fast", ts: i });
		evs.push({ t: "done", id: `s${i}`, status: "contract_violation", ts: i + 1 });
	}
	const vm = feed(evs);
	const lines = renderWidget(vm, 72, 0, "command-bridge").map(stripAnsi);
	const dupRows = lines.filter((l) => l.includes("contract_violation"));
	assert.equal(dupRows.length, 1, "the wall-of-duplicates folds to one row");
	assert.ok(dupRows[0].includes("contract_violation ×6"), "the fold carries a ×6 tally");
});

test("idea2: running agents are never collapsed (each keeps its live row)", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 },
		{ t: "spawned", id: "b", agent: "scout", model: "fast", ts: 1 },
	]);
	const rows = renderWidget(vm, 72, 0, "command-bridge")
		.map(stripAnsi)
		.filter((l) => /\bscout\b/.test(l) && l.includes("RUN"));
	assert.equal(rows.length, 2, "two running scouts stay as two rows");
});

test("idea3: fleet pulse shows one status dot per agent", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 },
		{ t: "spawned", id: "b", agent: "scout", model: "fast", ts: 1 },
		{ t: "done", id: "b", status: "done", ts: 2 },
	]);
	const pulse = renderWidget(vm, 72, 0, "command-bridge")
		.map(stripAnsi)
		.find((l) => l.includes("●"));
	assert.ok(pulse, "a pulse row of status dots is present");
	assert.equal((pulse!.match(/●/g) ?? []).length, 2, "one dot per agent");
});

test("idea4: footer hint bar surfaces the live harness commands (wide enough)", () => {
	const vm = feed([{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 }]);
	const joined = renderWidget(vm, 90, 0, "command-bridge").map(stripAnsi).join("\n");
	assert.ok(joined.includes("/harness-drill"), "drill hint visible");
	assert.ok(joined.includes("/harness-layout"), "layout hint visible");
	assert.ok(joined.includes("/harness-scale"), "scale hint visible");
});

test("idea1-5: the rectangle stays exactly W with pulse + sparkline + collapsed rows", () => {
	const evs: any[] = [
		{ t: "spawned", id: "r", agent: "builder", model: "standard", load_pct: 30, window_pct: 12, ts: 1 },
		{ t: "scaling", id: "r", load_pct: 70, window_pct: 40 },
	];
	for (let i = 0; i < 5; i++) {
		evs.push({ t: "spawned", id: `f${i}`, agent: "scout", model: "fast", ts: i });
		evs.push({ t: "done", id: `f${i}`, status: "failed", ts: i + 1 });
	}
	const vm = feed(evs);
	for (const W of [46, 60, 72, 100]) {
		const framed = renderWidget(vm, W, 0, "command-bridge")
			.map(stripAnsi)
			.filter((l) => /^[┌│├╞└]/.test(l));
		const widths = new Set(framed.map((l) => [...l].length));
		assert.equal(widths.size, 1, `W=${W}: all framed rows share one width; got ${[...widths].join(",")}`);
		assert.equal([...widths][0], W, `W=${W}: rows fill the width`);
	}
});

// ── TUI iteration II: breadcrumb + reason / tier-mix / zoned wide layout (ideas 6–8) ────────────

test("idea6: reduce captures a failure reason off the done event (whitespace-collapsed)", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 },
		{ t: "done", id: "a", status: "failed", error: "boom: it   broke\n  badly", ts: 2 },
	]);
	assert.equal(vm.agents.get("a")?.reason, "boom: it broke badly");
});

test("idea6: drill-in shows the SUMMON breadcrumb and surfaces the failure reason", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 },
		{ t: "done", id: "a", status: "contract_violation", error: "missing: plan", ts: 2 },
	]);
	setExpanded(vm, "a");
	const out = renderWidget(vm, 72, 0, "command-bridge").map(stripAnsi).join("\n");
	assert.ok(out.includes("SUMMON › scout"), "breadcrumb path present");
	assert.ok(out.includes("missing: plan"), "captured reason surfaced");
});

test("idea6: drill-in reason falls back to the status when none was emitted", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 },
		{ t: "done", id: "a", status: "timeout", ts: 2 },
	]);
	setExpanded(vm, "a");
	const out = renderWidget(vm, 72, 0, "command-bridge").map(stripAnsi).join("\n");
	assert.ok(out.includes("✗ timeout"), "status used as the reason when no detail");
});

test("idea8: [MIX] tier-weighting row appears for running agents of mixed tiers", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 },
		{ t: "spawned", id: "b", agent: "builder", model: "frontier", ts: 1 },
	]);
	const mix = renderWidget(vm, 72, 0, "command-bridge")
		.map(stripAnsi)
		.find((l) => l.includes("[MIX]"));
	assert.ok(mix, "[MIX] row present while agents run");
	assert.ok(mix!.includes("fast 1") && mix!.includes("frontier 1"), "per-tier count legend");
	assert.ok(mix!.includes("▰"), "proportional weight bar");
});

test("idea8: [MIX] row disappears once nothing is running", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 },
		{ t: "done", id: "a", status: "done", ts: 2 },
	]);
	assert.ok(
		!renderWidget(vm, 72, 0, "command-bridge")
			.map(stripAnsi)
			.some((l) => l.includes("[MIX]")),
		"MIX hidden when idle",
	);
});

test("idea7: wide width (≥110) splits command-bridge into AGENTS | STATUS columns", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", load_pct: 40, window_pct: 20, ts: 1 },
		{ t: "spawned", id: "b", agent: "builder", model: "frontier", load_pct: 60, window_pct: 30, ts: 1 },
	]);
	const joined = renderWidget(vm, 120, 0, "command-bridge").map(stripAnsi).join("\n");
	assert.ok(joined.includes("[AGENTS]") && joined.includes("[STATUS]"), "two-column split header");
	assert.ok(joined.includes("scout") && joined.includes("LOAD"), "agents left, gov right");
});

test("idea7: at <110 command-bridge stays single-column (no STATUS split)", () => {
	const vm = feed([{ t: "spawned", id: "a", agent: "scout", model: "fast", ts: 1 }]);
	const joined = renderWidget(vm, 100, 0, "command-bridge").map(stripAnsi).join("\n");
	assert.ok(!joined.includes("[STATUS]"), "stacked layout at 100 cols");
});

test("idea7: zoned rows are exactly W columns across wide widths", () => {
	const evs: any[] = [
		{ t: "spawned", id: "r", agent: "builder", model: "frontier", load_pct: 50, window_pct: 25, ts: 1 },
		{ t: "scaling", id: "r", load_pct: 80, window_pct: 60 },
		{ t: "spawned", id: "s", agent: "scout", model: "fast", ts: 2 },
		{ t: "autoscale", id: "fleet", ticks: [{ bundle: "scout", current: 1, target: 3, action: "grow" }] },
	];
	for (let i = 0; i < 4; i++) {
		evs.push({ t: "spawned", id: `f${i}`, agent: "probe", model: "standard", ts: i });
		evs.push({ t: "done", id: `f${i}`, status: "failed", ts: i + 1 });
	}
	const vm = feed(evs);
	for (const W of [110, 115, 120]) {
		const framed = renderWidget(vm, W, 0, "command-bridge")
			.map(stripAnsi)
			.filter((l) => /^[┌│├└]/.test(l));
		const widths = new Set(framed.map((l) => [...l].length));
		assert.equal(widths.size, 1, `W=${W}: zoned rows share one width; got ${[...widths].join(",")}`);
		assert.equal([...widths][0], W, `W=${W}: zoned rows fill the width`);
	}
});

test("idea7: zoned layout is jitter-safe — byte-stable per (vm, frame)", () => {
	const vm = feed([
		{ t: "spawned", id: "a", agent: "scout", model: "fast", load_pct: 40, window_pct: 20, ts: 1 },
		{ t: "scaling", id: "a", load_pct: 70, window_pct: 50 },
	]);
	assert.deepEqual(renderWidget(vm, 120, 2, "command-bridge"), renderWidget(vm, 120, 2, "command-bridge"));
});
