// Harness v2 — observability (Phase 3). Pure reducer over the agent-event stream + renderers.
// No Pi deps -> unit-testable offline; the extension (extension/observe.ts) is a thin wrapper that
// pipes pi.events("agent-event") -> reduce() and paints via setWidget/setStatus.

export interface AgentView {
	id: string;
	agent: string;
	model: string;
	status: "running" | "done" | "failed" | "verify_failed" | "timeout" | "contract_violation";
	tool?: string;
	startedAt: number;
	endedAt?: number;
	verify?: boolean;
	// Why a run ended (e.g. the failure error / contract miss), captured defensively off the `done`
	// event when the emitter carries it. Surfaced in the drill-in so a failure says more than its status.
	reason?: string;
	timeline: { tool: string; startedAt: number; endedAt?: number }[];
}
// One autoscaler decision surfaced for the live fleet panel (from the 'autoscale' agent-event).
export interface FleetTick {
	bundle: string;
	current: number;
	target: number;
	action: string;
}
export interface ViewModel {
	agents: Map<string, AgentView>;
	startedAt: number;
	expanded?: string;
	// Governor signals (#1/#4): rolling-window %, weighted load %, and queue depth. Optional + additive
	// so a missing field never blanks a gauge; populated defensively from events that carry them.
	governor?: { windowPct: number; loadPct: number; queued: number };
	// Rolling history of governor measurements for the LOAD/WIN sparklines (btop-style trend). EVENT-
	// sampled (one sample per real load/window measurement) — never wall-clock sampled — so the widget
	// stays a pure function of (vm, frame) and never repaints while idle (jitter invariant preserved).
	govHist?: { load: number[]; win: number[] };
	autoscale?: FleetTick[]; // latest per-bundle controller decisions (#3), when the autoscaler is armed
	// Load-shedding (A1): when the window is hot the autoscaler degrades a spawn one tier. Surfaced so the
	// silent quality trade-off is always VISIBLE (count + the most recent from→to downshift).
	shed?: { count: number; from?: string; to?: string };
	// Summoning fan-out (A2): a running tally of spawns + the last spawn ts, driving the header streak.
	burst?: { count: number; lastAt: number };
	// Latest quorum / best-of VERDICT (Bet 1, fugu transparency invariant): the decision used to reach
	// only the disk journal, never the live dashboard. Additive + optional so a missing field blanks
	// nothing; carries NO running agent, so isAnimating is unaffected (jitter invariant preserved).
	quorum?: {
		agreement: string;
		decidedBy: string;
		survivors: number;
		candidates: number;
		won: boolean;
		groupSize?: number;
		agent?: string;
	};
}

export const emptyVM = (): ViewModel => ({ agents: new Map(), startedAt: Date.now() });

// Defensively fold governor signals off any event that carries them (carry-forward so a missing field
// never zeroes a gauge). Adds NO running agent, so isAnimating is unaffected (jitter invariant).
function captureGov(vm: ViewModel, e: any): void {
	if (typeof e.window_pct !== "number" && typeof e.load_pct !== "number" && typeof e.queue_depth !== "number") return;
	const g = vm.governor ?? { windowPct: 0, loadPct: 0, queued: 0 };
	if (typeof e.window_pct === "number") g.windowPct = e.window_pct;
	if (typeof e.load_pct === "number") g.loadPct = e.load_pct;
	if (typeof e.queue_depth === "number") g.queued = e.queue_depth;
	vm.governor = g;
	// Sample the trend ONLY when a real load/window measurement arrived (not on a queue-only event),
	// so the sparkline tracks governor decisions, not bookkeeping. Capped ring buffer.
	if (typeof e.window_pct === "number" || typeof e.load_pct === "number") {
		const h = vm.govHist ?? { load: [], win: [] };
		h.load.push(g.loadPct);
		h.win.push(g.windowPct);
		if (h.load.length > 32) h.load.shift();
		if (h.win.length > 32) h.win.shift();
		vm.govHist = h;
	}
}

export function reduce(vm: ViewModel, e: any): void {
	if (!e || typeof e.id !== "string") return;
	switch (e.t) {
		case "spawned":
			vm.agents.set(e.id, {
				id: e.id,
				agent: e.agent,
				model: e.model,
				status: "running",
				startedAt: e.ts ?? Date.now(),
				timeline: [],
			});
			vm.burst = { count: (vm.burst?.count ?? 0) + 1, lastAt: e.ts ?? Date.now() };
			captureGov(vm, e);
			break;
		case "shedding":
			vm.shed = {
				count: (vm.shed?.count ?? 0) + 1,
				from: typeof e.from === "string" ? e.from : vm.shed?.from,
				to: typeof e.to === "string" ? e.to : vm.shed?.to,
			};
			captureGov(vm, e);
			break;
		case "queued":
			captureGov(vm, e);
			break;
		case "admitted":
			captureGov(vm, e);
			if (vm.governor) vm.governor.queued = Math.max(0, vm.governor.queued - 1);
			break;
		case "scaling":
			captureGov(vm, e);
			break;
		case "autoscale":
			if (Array.isArray(e.ticks))
				vm.autoscale = e.ticks.map((t: any) => ({
					bundle: String(t.bundle ?? ""),
					current: Number(t.current) || 0,
					target: Number(t.target) || 0,
					action: String(t.action ?? ""),
				}));
			break;
		case "quorum":
			// Record the latest fan-out verdict. No agent mutation ⇒ isAnimating is untouched.
			vm.quorum = {
				agreement: String(e.agreement ?? ""),
				decidedBy: String(e.decidedBy ?? ""),
				survivors: Number(e.survivors) || 0,
				candidates: Number(e.candidates) || 0,
				won: e.won === true,
				groupSize: typeof e.groupSize === "number" ? e.groupSize : undefined,
				agent: typeof e.agent === "string" ? e.agent : undefined,
			};
			break;
		case "tool": {
			const a = vm.agents.get(e.id);
			if (a) {
				if (e.phase === "start") {
					a.tool = e.tool;
					a.timeline.push({ tool: e.tool, startedAt: e.ts ?? Date.now() });
					if (a.timeline.length > 12) a.timeline.shift();
				} else {
					a.tool = undefined;
					const open = [...a.timeline].reverse().find((x) => x.endedAt === undefined);
					if (open) open.endedAt = e.ts ?? Date.now();
				}
			}
			break;
		}
		case "done": {
			const a = vm.agents.get(e.id);
			if (a) {
				a.status = e.status ?? "done";
				a.endedAt = e.ts ?? Date.now();
				a.verify = e.verify;
				a.tool = undefined;
				// Capture a human reason if the emitter carries one (error string / contract miss array).
				const reason = typeof e.error === "string" ? e.error : typeof e.reason === "string" ? e.reason : undefined;
				if (reason) a.reason = reason.replace(/\s+/g, " ").trim();
			}
			captureGov(vm, e);
			break;
		}
	}
}

/**
 * Whether the live widget has anything worth animating RIGHT NOW: at least one agent is actively
 * running. When this is false the widget is fully static, so the animation timer must STOP (not just
 * skip a frame) — an always-on idle shimmer repaints the bottom status rows ~2x/sec forever, which
 * reads as constant screen jutter in tmux and any terminal that doesn't honor synchronized output.
 * Single source of the animate/quiesce decision so the extension and its tests can never drift.
 * Pure + deterministic (depends only on agent state — no boot splash, no wall clock).
 */
export function isAnimating(vm: ViewModel): boolean {
	for (const a of vm.agents.values()) if (a.status === "running") return true;
	return false;
}

// ── summon palette (24-bit truecolor — the pi-dev / summon identity) ──
const PAL = {
	text: "232;235;247",
	muted: "92;100;133",
	border: "40;48;87",
	run: "56;189;248",
	done: "52;211;153",
	fail: "251;113;133",
	verify: "163;230;53",
	son: "96;165;250",
	hai: "45;212;191",
	opus: "192;132;252",
};
const GRAD: number[][] = [
	[182, 156, 255],
	[139, 149, 255],
	[52, 225, 244],
	[62, 240, 212],
	[240, 111, 251],
	[182, 156, 255],
]; // summon ribbon: violet→indigo→cyan→teal→fuchsia→violet (loops for shimmer)
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; // braille spinner for running agents
const fg = (rgb: string, s: string) => `\x1b[38;2;${rgb}m${s}\x1b[0m`;
const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
// Summoning streak (A2): a short gradient trail of › glyphs "flying off" the SUMMON wordmark, one per
// concurrently-running agent (capped). A PURE function of (count, frame) — same inputs ⇒ identical
// bytes — so it can never reintroduce tmux jitter and only moves while agents are actually running
// (renderWidget paints it only when run>0, and isAnimating is already true then).
export function summonStreak(count: number, frame: number): string {
	const len = Math.min(Math.max(0, Math.floor(count)), 6);
	if (len === 0) return "";
	let out = "";
	for (let i = 0; i < len; i++) {
		const t = (((frame + i * 2) % 18) / 18) * (GRAD.length - 1);
		const k = Math.min(GRAD.length - 2, Math.floor(t));
		const [r, g, b] = lerp(GRAD[k], GRAD[k + 1], t - k);
		out += `\x1b[38;2;${r};${g};${b}m›\x1b[0m`;
	}
	return out;
}
// gradient text with an optional moving `phase` (0..1) so the banner can shimmer across frames.
function gradText(s: string, phase = 0): string {
	const n = Math.max(1, s.length);
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const t = ((i / n + phase) % 1) * (GRAD.length - 1);
		const k = Math.min(GRAD.length - 2, Math.floor(t));
		const [r, g, b] = lerp(GRAD[k], GRAD[k + 1], t - k);
		out += `\x1b[1;38;2;${r};${g};${b}m${s[i]}\x1b[0m`;
	}
	return out;
}
const glyph = (s: AgentView["status"]) => (s === "running" ? "▸" : s === "done" ? "✓" : "✗");
const statusCol = (s: AgentView["status"]) => (s === "running" ? PAL.run : s === "done" ? PAL.done : PAL.fail);
// Agent events carry the model_tier name ("fast"/"standard"/"frontier"); older paths may carry a raw
// model id. Colour by tier first, falling back to id substrings, so the chip is always tier-coded.
const modelCol = (m: string) =>
	m.includes("opus") || m === "frontier" ? PAL.opus : m.includes("sonnet") || m === "standard" ? PAL.son : PAL.hai;
// Mirror of core.ts WEIGHT — the governor's per-tier concurrency cost. A display-only copy keeps
// observe.ts dependency-free (it must unit-test offline). Drives the in-flight tier-mix bar (idea 8).
const TIER_WEIGHT: Record<string, number> = { fast: 1, standard: 2, frontier: 4 };
const TIER_ORDER = ["frontier", "standard", "fast"] as const;
const tierCol = (t: string) => (t === "frontier" ? PAL.opus : t === "standard" ? PAL.son : PAL.hai);
const dur = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);
// Load ramp: green (slack) → amber → red (saturated). Each gauge/sparkline cell is tinted by what it
// represents, so a meter reads like a btop bar — green at the low end shading to red as it fills. Pure.
const RAMP: number[][] = [
	[52, 211, 153], // green
	[234, 179, 8], // amber
	[251, 113, 133], // red
];
function rampHex(frac: number): string {
	const t = Math.max(0, Math.min(1, frac)) * (RAMP.length - 1);
	const k = Math.min(RAMP.length - 2, Math.floor(t));
	const [r, g, b] = lerp(RAMP[k], RAMP[k + 1], t - k);
	return `${r};${g};${b}`;
}
// A compact mini-bar for a 0..100 percentage. Each filled cell is coloured by its POSITION along the
// bar (low cells green, high cells red) so the gauge gains a btop-style gradient. Visible width = w.
function gauge(pct: number, w = 12): string {
	const p = Math.max(0, Math.min(100, Math.round(pct)));
	const filled = Math.round((p / 100) * w);
	let out = "";
	for (let i = 0; i < filled; i++) out += fg(rampHex((i + 1) / w), "█");
	return out + fg(PAL.border, "░".repeat(Math.max(0, w - filled)));
}
// btop-style sparkline of a 0..100 series using an 8-level block ramp; each cell tinted by its own
// value (a spike reads red). Visible width = min(values.length, maxW). Pure (function of the buffer).
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
function spark(values: number[], maxW: number): string {
	let out = "";
	for (const v of values.slice(-maxW)) {
		const p = Math.max(0, Math.min(100, v));
		const idx = Math.min(SPARK.length - 1, Math.floor((p / 100) * SPARK.length));
		out += fg(rampHex(p / 100), SPARK[idx]);
	}
	return out;
}

export function counts(vm: ViewModel) {
	const a = [...vm.agents.values()];
	return {
		total: a.length,
		run: a.filter((x) => x.status === "running").length,
		ok: a.filter((x) => x.status === "done").length,
		bad: a.filter((x) => x.status !== "running" && x.status !== "done").length,
	};
}

// select/cycle/clear the drilled-in agent. target: an agent id | "next" | "off" | undefined.
export function setExpanded(vm: ViewModel, target?: string): void {
	if (!target || target === "off") {
		vm.expanded = undefined;
		return;
	}
	if (target === "next") {
		const ids = [...vm.agents.keys()];
		if (ids.length === 0) {
			vm.expanded = undefined;
			return;
		}
		const pos = ids.indexOf(vm.expanded as string);
		if (pos < 0) {
			vm.expanded = ids[0]; // currently "off" (or stale) → go to first
		} else if (pos === ids.length - 1) {
			vm.expanded = undefined; // at last id → go to "off"
		} else {
			vm.expanded = ids[pos + 1]; // advance one
		}
		return;
	}
	vm.expanded = vm.agents.has(target) ? target : undefined;
}

// The boot-splash wordmark used to live here. It now lives in the THEME banner (summon.json →
// painted permanently into the startup transcript by interactive-mode), so the live widget no
// longer paints a second, disappearing copy. The widget is the live agent panel ONLY.

// one framed panel row: "│ " + left(colored spans) + gap + right(colored) + " │", fitted to width.
function frameRow(W: number, left: [string, string][], right: string, rightCol: string): string {
	const inner = W - 4;
	const leftPlain = left.reduce((a, [t]) => a + t.length, 0);
	let leftStr: string;
	let used: number;
	if (leftPlain + right.length <= inner) {
		leftStr = left.map(([t, col]) => fg(col, t)).join("");
		used = leftPlain;
	} else {
		// truncate left to fit
		const keep = Math.max(0, inner - right.length - 1);
		leftStr = "";
		used = 0;
		for (const [t, col] of left) {
			if (used >= keep) break;
			const take = trunc(t, keep - used);
			leftStr += fg(col, take);
			used += take.length;
		}
	}
	const gap = Math.max(1, inner - used - right.length);
	return fg(PAL.border, "│ ") + leftStr + " ".repeat(gap) + fg(rightCol, right) + fg(PAL.border, " │");
}

// Live dashboard layouts: renderWidget dispatches to a named render mode so the look is PLUGGABLE.
// "panel" is the original neon agent panel (default, byte-identical to before); "command-bridge" is the
// dense sci-fi ops console. Both are pure functions of (vm, frame) and respect the jitter invariants
// (no isAnimating change; same inputs ⇒ identical bytes). Add a mode = add a renderer + a DASHBOARD_STYLES entry.
export type DashboardStyle = "panel" | "command-bridge";
export const DASHBOARD_STYLES: DashboardStyle[] = ["panel", "command-bridge"];
const ACC = "52;225;244"; // command-bridge cyan accent for [LABEL] cells
const ZONE_MIN = 110; // at/above this width, command-bridge splits into AGENTS | STATUS columns (idea 7)
type Counts = { total: number; run: number; ok: number; bad: number };

// A displayed register row: a representative agent + how many identical ones it stands for.
interface AgentRow {
	rep: AgentView;
	count: number;
}
// Collapse the wall-of-duplicates: settled agents that share (name, status) fold into one row with a
// ×N tally (e.g. six failed scouts → "scout contract_violation ×6"), while running agents always stay
// individual (each has its own live tool + spinner). The freshest settled agent represents its group.
function groupAgents(agents: AgentView[]): AgentRow[] {
	const rows: AgentRow[] = [];
	const idx = new Map<string, number>();
	for (const a of agents) {
		if (a.status === "running") {
			rows.push({ rep: a, count: 1 });
			continue;
		}
		const key = `${a.agent} ${a.status}`;
		const at = idx.get(key);
		if (at === undefined) {
			idx.set(key, rows.length);
			rows.push({ rep: a, count: 1 });
		} else {
			rows[at].count++;
			rows[at].rep = a;
		}
	}
	return rows;
}
// A k9s-style "pulse": one status dot per agent so whole-fleet health reads at a glance even when the
// register caps at 8 rows. Pure + static colours (no per-frame change) ⇒ no jitter. Returns the visible
// width separately so the caller can pad the framed row exactly.
function fleetPulse(agents: AgentView[], maxW: number): { vis: number; str: string } {
	const overflow = agents.length > maxW;
	const shown = overflow ? agents.slice(-(maxW - 1)) : agents;
	const lead = overflow ? fg(PAL.muted, "…") : "";
	const str = lead + shown.map((a) => fg(statusCol(a.status), "●")).join("");
	return { vis: (overflow ? 1 : 0) + shown.length, str };
}
// In-flight tier mix (idea 8 / canvas-tui "weighting"): a proportional bar of running WEIGHT by model
// tier — the governor's currency made visible — with a per-tier agent-count legend. Always fits within
// `avail` columns (bar ≤ 12 cells, legend truncated if needed) and returns vis for exact padding.
function tierMix(agents: AgentView[], avail: number): { vis: number; str: string } {
	const wByTier = new Map<string, number>();
	const nByTier = new Map<string, number>();
	let total = 0;
	for (const a of agents) {
		if (a.status !== "running") continue;
		const tier = a.model in TIER_WEIGHT ? a.model : "fast";
		wByTier.set(tier, (wByTier.get(tier) ?? 0) + TIER_WEIGHT[tier]);
		nByTier.set(tier, (nByTier.get(tier) ?? 0) + 1);
		total += TIER_WEIGHT[tier];
	}
	if (total === 0) return { vis: 0, str: "" };
	const tiers = TIER_ORDER.filter((t) => (wByTier.get(t) ?? 0) > 0);
	let legend = tiers.map((t) => `${t} ${nByTier.get(t)}`).join(" ");
	let barW = Math.min(12, avail - 2 - legend.length);
	if (barW < 3) {
		barW = 3;
		legend = trunc(legend, Math.max(0, avail - 2 - barW));
	}
	// largest-remainder apportionment so the coloured cells always sum to exactly barW.
	const raw = tiers.map((t) => ((wByTier.get(t) ?? 0) / total) * barW);
	const cells = raw.map((x) => Math.floor(x));
	let used = cells.reduce((s, x) => s + x, 0);
	const rema = raw.map((x, i) => [x - Math.floor(x), i] as [number, number]).sort((a, b) => b[0] - a[0]);
	for (let k = 0; used < barW && k < rema.length; k++, used++) cells[rema[k][1]]++;
	const bar = tiers.map((t, i) => fg(tierCol(t), "▰".repeat(cells[i]))).join("");
	return { vis: barW + 2 + legend.length, str: `${bar}${fg(PAL.muted, `  ${legend}`)}` };
}

// The latest quorum verdict, rendered as coloured spans (without a label cell). Returns vis so callers
// pad framed rows exactly. e.g. "majority/vote 4/6 ×4 ✓" — green ✓ if a winner was chosen, else red ✗.
function quorumLine(q: NonNullable<ViewModel["quorum"]>): { vis: number; str: string } {
	const verdict = `${q.agreement}/${q.decidedBy}`;
	const tally = ` ${q.survivors}/${q.candidates}`;
	const grp = q.groupSize ? ` ×${q.groupSize}` : "";
	const mark = q.won ? " ✓" : " ✗";
	const str = fg(PAL.muted, verdict) + fg(PAL.text, tally + grp) + fg(q.won ? PAL.done : PAL.fail, mark);
	return { vis: verdict.length + tally.length + grp.length + mark.length, str };
}

// drill-in detail (breadcrumb + failure reason + tool timeline) — shared by every layout.
function drillIn(vm: ViewModel): string[] {
	if (vm.expanded === undefined || !vm.agents.has(vm.expanded)) return [];
	const a = vm.agents.get(vm.expanded)!;
	const bad = a.status !== "running" && a.status !== "done";
	// breadcrumb: SUMMON › <agent> ‹tier› › <timeline | why> (idea 6, k9s-style path).
	const crumb =
		fg(PAL.border, "  ▾ ") +
		fg(PAL.muted, "SUMMON ") +
		fg(PAL.border, "› ") +
		fg(PAL.son, a.agent) +
		fg(modelCol(a.model), ` ‹${a.model}› `) +
		fg(PAL.border, "› ") +
		fg(bad ? PAL.fail : PAL.muted, bad ? "why" : "timeline");
	const L: string[] = [crumb];
	// failure reason: the captured error if the emitter sent one, else the status — so a failure says why.
	if (bad) L.push(fg(PAL.fail, `    ✗ ${trunc(a.reason ?? a.status, 72)}`));
	const tl = a.timeline.slice(-10);
	if (tl.length === 0) {
		if (!bad) L.push(fg(PAL.muted, "    (no tool activity yet)"));
		return L;
	}
	for (const e of tl) {
		const g = e.endedAt !== undefined ? fg(PAL.done, "✓") : fg(PAL.run, "▸");
		L.push(
			`    ${g} ${fg(PAL.text, (e.tool ?? "?").padEnd(16))} ${fg(PAL.muted, dur((e.endedAt ?? Date.now()) - e.startedAt))}`,
		);
	}
	return L;
}

// The live dashboard widget (above the editor). `frame` advances on a timer so running agents animate.
// Pluggable: pass a DashboardStyle to switch layout; default "panel" reproduces the original look exactly.
export function renderWidget(vm: ViewModel, width: number = 72, frame = 0, style: DashboardStyle = "panel"): string[] {
	const c = counts(vm);
	// Idle (nothing delegated): render NOTHING so the widget takes zero space and the prompt stays clean.
	if (c.total === 0 && vm.expanded === undefined) return [];
	const W = Math.max(46, Math.min(typeof width === "number" && width > 0 ? width : 72, 120));
	if (style === "command-bridge") {
		return W >= ZONE_MIN ? renderCommandBridgeZoned(vm, W, frame, c) : renderCommandBridge(vm, W, frame, c);
	}
	return renderPanel(vm, W, frame, c);
}

// ── layout "panel": the original neon agent panel (24-bit colour) ─────────────
function renderPanel(vm: ViewModel, W: number, frame: number, c: Counts): string[] {
	const { total, run, ok, bad } = c;
	const elapsed = dur(Date.now() - vm.startedAt);
	const L: string[] = [];
	// header rail: ⬢ SUMMON (shimmering gradient) + coloured counts + elapsed + summoning streak (A2)
	const mark = fg(PAL.muted, "⬢ ") + gradText("SUMMON", (frame % 60) / 60);
	const stat = `${fg(PAL.run, `▸${run}`)} ${fg(PAL.done, `✓${ok}`)} ${fg(PAL.fail, `✗${bad}`)}`;
	const streak = run > 0 ? `  ${summonStreak(run, frame)}` : "";
	L.push(`${mark}  ${stat}  ${fg(PAL.border, "·")}  ${fg(PAL.muted, `⏱ ${elapsed}`)}${streak}`);
	// Governor gauge (#1/#4): weighted load + rolling-window budget + queue depth + load-shedding (A1).
	if (vm.governor) {
		const g = vm.governor;
		let line =
			fg(PAL.muted, "load ") +
			gauge(g.loadPct) +
			fg(PAL.muted, ` ${g.loadPct}%`) +
			fg(PAL.muted, "   win ") +
			gauge(g.windowPct) +
			fg(PAL.muted, ` ${g.windowPct}%`);
		if (g.queued > 0) line += fg(PAL.muted, "   queue ") + fg(PAL.run, String(g.queued));
		if (vm.shed && vm.shed.count > 0) {
			const tag = vm.shed.from && vm.shed.to ? `${vm.shed.from}→${vm.shed.to}` : "tier";
			line += fg(PAL.muted, "   shed ") + fg(PAL.fail, `${vm.shed.count}↓ ${tag}`);
		}
		L.push(line);
	}
	if (vm.quorum) {
		const q = quorumLine(vm.quorum);
		L.push(fg(PAL.muted, "vote ") + q.str);
	}
	if (total === 0) return L; // drill-in pinned but no agents yet: header (+ gauge) only
	const title = "agents";
	L.push(
		fg(PAL.border, "╭─ ") +
			fg(PAL.muted, title) +
			" " +
			fg(PAL.border, `${"─".repeat(Math.max(0, W - title.length - 5))}╮`),
	);
	for (const { rep: a, count } of groupAgents([...vm.agents.values()]).slice(-8)) {
		const bad2 = a.status !== "running" && a.status !== "done";
		let act = a.status === "running" ? (a.tool ?? "working…") : a.status === "done" ? "done" : a.status;
		if (count > 1) act = `${act} ×${count}`;
		const actCol = bad2 ? PAL.fail : a.status === "running" ? PAL.text : PAL.muted;
		const gl = a.status === "running" ? SPIN[frame % SPIN.length] : glyph(a.status);
		const left: [string, string][] = [
			[`${gl} `, statusCol(a.status)],
			[a.agent.padEnd(9), PAL.text],
			[`‹${a.model}›`, modelCol(a.model)],
			[`  ${act}`, actCol],
		];
		const verified = a.status === "done" && a.verify === true;
		const right = (verified ? "✓ " : "") + dur((a.endedAt ?? Date.now()) - a.startedAt);
		L.push(frameRow(W, left, right, verified ? PAL.verify : PAL.muted));
	}
	L.push(fg(PAL.border, `╰${"─".repeat(W - 2)}╯`));
	// Fleet panel (#3/#4): per-bundle pool size current→target as the autoscaler resizes it.
	if (vm.autoscale?.length) {
		const ft = "fleet";
		L.push(
			fg(PAL.border, "╭─ ") +
				fg(PAL.muted, ft) +
				" " +
				fg(PAL.border, `${"─".repeat(Math.max(0, W - ft.length - 5))}╮`),
		);
		for (const t of vm.autoscale.slice(-6)) {
			const grow = t.target > t.current;
			const arrow = grow ? "↑" : t.target < t.current ? "↓" : "·";
			const left: [string, string][] = [
				[t.bundle.padEnd(12), PAL.text],
				[`pool ${t.current}→${t.target} ${arrow}`, grow ? PAL.run : PAL.muted],
				[`  ${t.action}`, PAL.muted],
			];
			L.push(frameRow(W, left, "", PAL.muted));
		}
		L.push(fg(PAL.border, `╰${"─".repeat(W - 2)}╯`));
	}
	L.push(...drillIn(vm));
	return L;
}

// ── layout "command-bridge": a dense sci-fi ops console ───────────────────────
// Every framed row is computed to EXACTLY W visible columns (widths summed on plain text, not ANSI
// bytes) so the console renders as a clean rectangle at any width.
function renderCommandBridge(vm: ViewModel, W: number, frame: number, c: Counts): string[] {
	const BR = PAL.border;
	const inner = W - 4; // visible chars between "│ " and " │"
	const L: string[] = [];
	const elapsed = dur(Date.now() - vm.startedAt);
	// a horizontal rule with leading [LABEL] cells, filled to W with `fill`, capped by `close`.
	const rule = (segs: [string, string][], close: string, fill: string): string => {
		let plain = 0;
		let out = "";
		for (const [t, col] of segs) {
			out += fg(col, t);
			plain += t.length;
		}
		return out + fg(BR, fill.repeat(Math.max(0, W - 1 - plain)) + close);
	};
	const body = (vis: number, content: string): string =>
		fg(BR, "│ ") + content + " ".repeat(Math.max(1, inner - vis)) + fg(BR, " │");
	const bodyLR = (lvis: number, lc: string, rvis: number, rc: string): string =>
		fg(BR, "│ ") + lc + " ".repeat(Math.max(1, inner - lvis - rvis)) + rc + fg(BR, " │");

	// top rail: ┌─[SUMMON]─[ ▸r ✓o ✗b · Ts ]──────┐
	L.push(
		rule(
			[
				["┌─", BR],
				["[SUMMON]", ACC],
				["─", BR],
				["[ ", PAL.muted],
				[`▸${c.run}`, PAL.run],
				[` ✓${c.ok}`, PAL.done],
				[` ✗${c.bad}`, PAL.fail],
				[` · ${elapsed} ]`, PAL.muted],
			],
			"┐",
			"─",
		),
	);
	// fleet pulse (k9s): one status dot per agent — whole-fleet health at a glance, even past the cap.
	if (c.total > 0) {
		const p = fleetPulse([...vm.agents.values()], inner - 1); // -1 so the row always keeps a pad column
		L.push(body(p.vis, p.str));
	}
	// [GOV] segmented load/window bars
	const g = vm.governor ?? { windowPct: 0, loadPct: 0, queued: 0 };
	const lp = ` ${g.loadPct}%`;
	const wp = ` ${g.windowPct}%`;
	L.push(
		body(
			6 + 5 + 8 + lp.length + 6 + 8 + wp.length,
			`${fg(ACC, "[GOV] ")}${fg(PAL.muted, "LOAD ")}${gauge(g.loadPct, 8)}${fg(PAL.text, lp)}${fg(PAL.muted, "  WIN ")}${gauge(g.windowPct, 8)}${fg(PAL.text, wp)}`,
		),
	);
	// LOAD/WIN trend (btop sparkline) — only once there are ≥2 real measurements to plot. Width-fit so
	// the row never breaks the rectangle on a narrow terminal.
	if (vm.govHist && vm.govHist.load.length >= 2) {
		const sw = Math.min(12, Math.floor((inner - 17) / 2));
		if (sw >= 4) {
			// spark() emits min(history, sw) cells — size the row to the ACTUAL count so the pad is exact.
			const n = Math.min(vm.govHist.load.length, sw);
			L.push(
				body(
					17 + 2 * n,
					`${fg(PAL.muted, "      load ")}${spark(vm.govHist.load, sw)}${fg(PAL.muted, "  win ")}${spark(vm.govHist.win, sw)}`,
				),
			);
		}
	}
	// queue depth + load-shedding (A1) — only when present
	{
		let content = "";
		let vis = 0;
		if (g.queued > 0) {
			content += fg(PAL.muted, "QUEUE ") + fg(PAL.run, String(g.queued));
			vis += 6 + String(g.queued).length;
		}
		if (vm.shed && vm.shed.count > 0) {
			const tag = vm.shed.from && vm.shed.to ? `${vm.shed.from}→${vm.shed.to}` : "tier";
			const pre = vis > 0 ? "   " : "";
			const s = `${vm.shed.count}↓ ${tag}`;
			content += fg(PAL.muted, `${pre}SHED `) + fg(PAL.fail, s);
			vis += pre.length + 5 + s.length;
		}
		if (vis > 0) L.push(body(vis, content));
	}
	// [MIX] in-flight tier weighting (idea 8) — only while agents run and there's room for a real bar.
	if (c.run > 0 && inner - 7 >= 10) {
		const mix = tierMix([...vm.agents.values()], inner - 7);
		if (mix.vis > 0) L.push(body(6 + mix.vis, `${fg(ACC, "[MIX] ")}${mix.str}`));
	}
	// [VOTE] latest quorum / best-of verdict (Bet 1) — the decision that previously reached only the
	// disk journal, now on the live board.
	if (vm.quorum) {
		const q = quorumLine(vm.quorum);
		if (7 + q.vis <= inner - 1) L.push(body(7 + q.vis, `${fg(ACC, "[VOTE] ")}${q.str}`));
	}
	// [AGENTS] register
	L.push(
		rule(
			[
				["├", BR],
				["[AGENTS]", ACC],
			],
			"┤",
			"═",
		),
	);
	if (c.total === 0) {
		L.push(body(13, fg(PAL.muted, "(no contacts) ")));
	} else {
		for (const { rep: a, count } of groupAgents([...vm.agents.values()]).slice(-8)) {
			const running = a.status === "running";
			const okk = a.status === "done";
			const gl = running ? SPIN[frame % SPIN.length] : glyph(a.status);
			const model = `‹${a.model.slice(0, 5)}›`;
			const right = `${running ? "RUN" : okk ? "DONE" : "FAIL"} ${dur((a.endedAt ?? Date.now()) - a.startedAt)}`;
			const name = a.agent.slice(0, 8).padEnd(8);
			const leftFixed = 12 + model.length; // "gl "(2) + name+" "(9) + model+" "(model.length+1)
			const room = Math.max(3, inner - leftFixed - (right.length + 1));
			// done rows show nothing in the act column (the STATE cell already says DONE); failed rows keep
			// the failure status (e.g. contract_violation); running rows show the live tool. A collapsed
			// group appends a ×N tally so the count survives the fold.
			let act = running ? (a.tool ?? "weaving") : okk ? "" : a.status;
			if (count > 1) act = act ? `${act} ×${count}` : `×${count}`;
			if (act.length > room) act = trunc(act, room);
			const actCol = running ? PAL.text : okk ? PAL.muted : PAL.fail;
			const lc = `${fg(statusCol(a.status), `${gl} `)}${fg(PAL.text, `${name} `)}${fg(modelCol(a.model), `${model} `)}${fg(actCol, act)}`;
			const rcol = running ? PAL.run : okk ? PAL.done : PAL.fail;
			L.push(bodyLR(leftFixed + act.length, lc, right.length, fg(rcol, right)));
		}
	}
	// [FLEET HUD] pinned strip — only when the autoscaler is armed
	if (vm.autoscale?.length) {
		L.push(
			rule(
				[
					["╞", BR],
					["[FLEET HUD]", ACC],
				],
				"╡",
				"═",
			),
		);
		const parts = vm.autoscale.slice(0, 4).map((t) => {
			const ar = t.target > t.current ? "▲" : t.target < t.current ? "▼" : "·";
			return `${t.bundle} ${t.current}▶${t.target}${ar}`;
		});
		let txt = parts.join("   ");
		if (txt.length > inner) txt = trunc(txt, inner);
		L.push(body(txt.length, fg(PAL.run, txt)));
	}
	// hotkey hint bar (k9s `?` / lazygit footer): surface the live commands. Falls back to the nominal
	// strip when the terminal is too narrow to fit the full hint without breaking the rectangle.
	const hintFull = "‹ /harness-drill · /harness-layout · /harness-scale ›";
	const hint = hintFull.length <= W - 5 ? hintFull : "‹ board nominal ›";
	L.push(
		rule(
			[
				["└─ ", BR],
				[hint, PAL.muted],
				[" ", BR],
			],
			"┘",
			"─",
		),
	);
	L.push(...drillIn(vm));
	return L;
}

// One fully-padded agent register cell, EXACTLY `width` visible columns (zoned layout's left column).
function agentCell(a: AgentView, count: number, frame: number, width: number): string {
	const running = a.status === "running";
	const okk = a.status === "done";
	const gl = running ? SPIN[frame % SPIN.length] : glyph(a.status);
	const model = `‹${a.model.slice(0, 5)}›`;
	const right = `${running ? "RUN" : okk ? "DONE" : "FAIL"} ${dur((a.endedAt ?? Date.now()) - a.startedAt)}`;
	const name = a.agent.slice(0, 8).padEnd(8);
	const leftFixed = 12 + model.length;
	const room = Math.max(3, width - leftFixed - (right.length + 1));
	let act = running ? (a.tool ?? "weaving") : okk ? "" : a.status;
	if (count > 1) act = act ? `${act} ×${count}` : `×${count}`;
	if (act.length > room) act = trunc(act, room);
	const gap = Math.max(1, width - leftFixed - act.length - right.length);
	const actCol = running ? PAL.text : okk ? PAL.muted : PAL.fail;
	const rcol = running ? PAL.run : okk ? PAL.done : PAL.fail;
	return (
		fg(statusCol(a.status), `${gl} `) +
		fg(PAL.text, `${name} `) +
		fg(modelCol(a.model), `${model} `) +
		fg(actCol, act) +
		" ".repeat(gap) +
		fg(rcol, right)
	);
}

// ── layout "command-bridge", ZONED (idea 7) ───────────────────────────────────
// At wide widths the console splits into two columns — AGENTS on the left, STATUS (gov / trend / mix /
// fleet) on the right — like a btop preset / k9s split. Full-width rows (top rail, pulse, footer) span
// both; the ┬/┴ junctions align with the body divider at column lw+3. Every row is EXACTLY W columns.
function renderCommandBridgeZoned(vm: ViewModel, W: number, frame: number, c: Counts): string[] {
	const BR = PAL.border;
	const lw = Math.floor((W - 7) * 0.6); // AGENTS column width
	const rw = W - 7 - lw; // STATUS column width
	const L: string[] = [];
	const elapsed = dur(Date.now() - vm.startedAt);
	const pad = (str: string, vis: number, w: number) => str + " ".repeat(Math.max(0, w - vis));
	const rule = (segs: [string, string][], close: string, fill: string): string => {
		let plain = 0;
		let out = "";
		for (const [t, col] of segs) {
			out += fg(col, t);
			plain += t.length;
		}
		return out + fg(BR, fill.repeat(Math.max(0, W - 1 - plain)) + close);
	};

	// top rail (full width)
	L.push(
		rule(
			[
				["┌─", BR],
				["[SUMMON]", ACC],
				["─", BR],
				["[ ", PAL.muted],
				[`▸${c.run}`, PAL.run],
				[` ✓${c.ok}`, PAL.done],
				[` ✗${c.bad}`, PAL.fail],
				[` · ${elapsed} ]`, PAL.muted],
			],
			"┐",
			"─",
		),
	);
	// pulse (full width)
	if (c.total > 0) {
		const p = fleetPulse([...vm.agents.values()], W - 5);
		L.push(fg(BR, "│ ") + p.str + " ".repeat(Math.max(1, W - 4 - p.vis)) + fg(BR, " │"));
	}
	// split header: ├[AGENTS]══┬[STATUS]══┤  (┬ aligned with the body divider at column lw+3)
	L.push(
		fg(BR, "├") +
			fg(ACC, "[AGENTS]") +
			fg(BR, `${"═".repeat(Math.max(0, lw - 6))}┬`) +
			fg(ACC, "[STATUS]") +
			fg(BR, `${"═".repeat(Math.max(0, rw - 6))}┤`),
	);

	// ── left column: agent register ──
	const leftCells: string[] = [];
	if (c.total === 0) leftCells.push(pad(fg(PAL.muted, "(no contacts)"), 13, lw));
	else
		for (const { rep: a, count } of groupAgents([...vm.agents.values()]).slice(-14))
			leftCells.push(agentCell(a, count, frame, lw));

	// ── right column: status stack ──
	const rightCells: string[] = [];
	const g = vm.governor ?? { windowPct: 0, loadPct: 0, queued: 0 };
	{
		const lpv = ` ${g.loadPct}%`;
		const wpv = ` ${g.windowPct}%`;
		rightCells.push(
			pad(
				`${fg(PAL.muted, "LOAD ")}${gauge(g.loadPct, 8)}${fg(PAL.text, lpv)}${fg(PAL.muted, "  WIN ")}${gauge(g.windowPct, 8)}${fg(PAL.text, wpv)}`,
				5 + 8 + lpv.length + 6 + 8 + wpv.length,
				rw,
			),
		);
	}
	if (vm.govHist && vm.govHist.load.length >= 2) {
		const sw = Math.min(12, Math.floor((rw - 11) / 2));
		if (sw >= 4) {
			const n = Math.min(vm.govHist.load.length, sw);
			rightCells.push(
				pad(
					`${fg(PAL.muted, "load ")}${spark(vm.govHist.load, sw)}${fg(PAL.muted, "  win ")}${spark(vm.govHist.win, sw)}`,
					11 + 2 * n,
					rw,
				),
			);
		}
	}
	if (c.run > 0) {
		const mix = tierMix([...vm.agents.values()], rw);
		if (mix.vis > 0) rightCells.push(pad(mix.str, mix.vis, rw));
	}
	if (vm.quorum) {
		const q = quorumLine(vm.quorum);
		if (7 + q.vis <= rw) rightCells.push(pad(`${fg(ACC, "[VOTE] ")}${q.str}`, 7 + q.vis, rw));
	}
	if (g.queued > 0 || (vm.shed && vm.shed.count > 0)) {
		let s = "";
		let vis = 0;
		if (g.queued > 0) {
			s += fg(PAL.muted, "QUEUE ") + fg(PAL.run, String(g.queued));
			vis += 6 + String(g.queued).length;
		}
		if (vm.shed && vm.shed.count > 0) {
			const tag = vm.shed.from && vm.shed.to ? `${vm.shed.from}→${vm.shed.to}` : "tier";
			const pre = vis > 0 ? "  " : "";
			const t = `${vm.shed.count}↓ ${tag}`;
			s += fg(PAL.muted, `${pre}SHED `) + fg(PAL.fail, t);
			vis += pre.length + 5 + t.length;
		}
		if (vis <= rw) rightCells.push(pad(s, vis, rw));
	}
	if (vm.autoscale?.length) {
		rightCells.push(pad(fg(ACC, "FLEET"), 5, rw));
		for (const t of vm.autoscale.slice(0, 4)) {
			const ar = t.target > t.current ? "▲" : t.target < t.current ? "▼" : "·";
			const txt = trunc(`${t.bundle} ${t.current}▶${t.target}${ar}`, rw);
			rightCells.push(pad(fg(PAL.run, txt), txt.length, rw));
		}
	}

	// ── compose the two columns row by row ──
	const rows = Math.max(leftCells.length, rightCells.length);
	for (let i = 0; i < rows; i++) {
		const lc = leftCells[i] ?? " ".repeat(lw);
		const rc = rightCells[i] ?? " ".repeat(rw);
		L.push(fg(BR, "│ ") + lc + fg(BR, " │ ") + rc + fg(BR, " │"));
	}

	// footer with ┴ aligned at column lw+3
	const hintFull = "‹ /harness-drill · /harness-layout · /harness-scale ›";
	const hint = hintFull.length <= lw ? hintFull : "‹ board nominal ›";
	L.push(
		fg(BR, "└─ ") +
			fg(PAL.muted, hint) +
			fg(BR, `${"─".repeat(Math.max(0, lw - hint.length))}┴${"─".repeat(rw + 2)}┘`),
	);
	L.push(...drillIn(vm));
	return L;
}

// Compact footer/status chip — coloured.
export function renderFooter(vm: ViewModel): string {
	const { run, ok, bad } = counts(vm);
	return (
		fg(PAL.run, `▸${run}`) +
		" " +
		fg(PAL.done, `✓${ok}`) +
		" " +
		fg(PAL.fail, `✗${bad}`) +
		" " +
		fg(PAL.muted, `· ${dur(Date.now() - vm.startedAt)}`)
	);
}
