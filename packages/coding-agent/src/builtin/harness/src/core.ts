// Harness v2 — core (registry · validator · contract · spawn). No pi/typebox deps so it runs
// standalone under `node --experimental-strip-types`. The Pi extension wraps this; single-sourced.

import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentSpawnCommand, AGENTS_DIR as GLOBAL_AGENTS } from "./paths.ts"; // derived from install location, env-overridable

export interface OutputContract {
	required_sections: string[];
	forbidden?: string[];
	max_tokens?: number;
}
export interface AgentBundle {
	name: string;
	role: string;
	model_tier: "fast" | "standard" | "frontier";
	tools: string[];
	skills?: string[];
	context_globs?: string[];
	output_contract: OutputContract;
	max_attempts?: number;
	timeout_s?: number;
	may_spawn?: boolean;
	expertise?: boolean; // opt into a self-maintained expertise.md (read at boot, appended on success)
	_dir?: string;
}

export const MODEL: Record<AgentBundle["model_tier"], string> = {
	fast: "claude-haiku-4-5",
	standard: "claude-sonnet-4-6",
	frontier: "claude-opus-4-8",
};
// Default system-prompt header for spawned workers. A non-empty system prompt is required (see
// assertSpawnAuth) so Anthropic calls never fall through to pay-per-token "extra usage" routing.
export const SYS_HEADER = "You are Claude Code, Anthropic's official CLI for Claude.";
const WRITE_TOOLS = new Set(["edit", "write", "bash"]);
export const DELEGATION_TOOLS = new Set(["spawn_agent", "spawn_agents", "run_team", "run_blueprint"]);
// Generic, project-AGNOSTIC defaults. Per-project additions come from `.harness.json` { protected: [...] }.
export const DEFAULT_PROTECTED = [".env", "/.git/", "secrets", "credentials", ".pem", ".key", "id_rsa", "id_ed25519"];

export interface HarnessConfig {
	protected?: string[];
	agents_dir?: string;
	max_weight?: number;
}

// Find the project root (nearest ancestor with .harness.json or .git) + its config.
export function resolveProject(cwd: string): { root: string; cfg: HarnessConfig } {
	let dir = resolve(cwd);
	for (;;) {
		const cfgPath = join(dir, ".harness.json");
		if (existsSync(cfgPath)) {
			try {
				return { root: dir, cfg: JSON.parse(readFileSync(cfgPath, "utf8")) };
			} catch {
				/* ignore */
			}
		}
		if (existsSync(join(dir, ".git"))) return { root: dir, cfg: {} };
		const parent = dirname(dir);
		if (parent === dir) return { root: resolve(cwd), cfg: {} };
		dir = parent;
	}
}

// Effective registry for a project = GLOBAL specialists + project-local overrides, validated against
// DEFAULT_PROTECTED + the project's own protected paths.
export function loadRegistries(cwd = process.cwd()): {
	reg: Map<string, AgentBundle>;
	protectedList: string[];
	root: string;
	maxWeight: number;
} {
	const { root, cfg } = resolveProject(cwd);
	const protectedList = [...DEFAULT_PROTECTED, ...(cfg.protected ?? [])];
	const reg = new Map<string, AgentBundle>();
	const localDir = join(root, cfg.agents_dir ?? ".summon/agents");
	for (const d of [GLOBAL_AGENTS, localDir]) {
		// local overrides global by name
		if (!existsSync(d)) continue;
		for (const [name, b] of loadRegistry(d, protectedList)) reg.set(name, b);
	}
	return { reg, protectedList, root, maxWeight: cfg.max_weight ?? 8 };
}

// ── registry ────────────────────────────────────────────────────────────────
export function loadRegistry(dir: string, protectedList: string[] = DEFAULT_PROTECTED): Map<string, AgentBundle> {
	const reg = new Map<string, AgentBundle>();
	for (const name of readdirSync(dir)) {
		const f = join(dir, name, "agent.json");
		if (!existsSync(f)) continue;
		const b = JSON.parse(readFileSync(f, "utf8")) as AgentBundle;
		b._dir = join(dir, name);
		validateBundle(b, protectedList); // fail-closed: throws => bundle does not load
		reg.set(b.name, b);
	}
	return reg;
}

// ── validator (the sentinel-style guard) ─────────────────────────────────────
export function validateBundle(b: AgentBundle, protectedList: string[] = DEFAULT_PROTECTED): void {
	const err = (m: string) => {
		throw new Error(`agent '${b.name ?? "?"}': ${m}`);
	};
	if (!b.name || !b.role || !b.model_tier || !Array.isArray(b.tools)) err("missing required fields");
	if (!(b.model_tier in MODEL)) err(`bad model_tier '${b.model_tier}'`);
	if (b.may_spawn && b.tools.some((t) => WRITE_TOOLS.has(t)))
		err("orchestrator (may_spawn) must NOT have write/edit/bash — it delegates, never executes");
	if (!b.may_spawn && b.tools.some((t) => DELEGATION_TOOLS.has(t)))
		err("only the orchestrator (may_spawn) bundle may have delegation tools (spawn_agent/spawn_agents/run_team)");
	if (
		b.tools.some((t) => WRITE_TOOLS.has(t)) &&
		(b.context_globs ?? []).some((g) => protectedList.some((p) => g.includes(p)))
	)
		err("write-capable bundle may not scope into a protected path");
	if (!b.output_contract?.required_sections?.length) err("output_contract.required_sections required");
}

// ── registry view (single-sourced projection for CLI display + JSON output) ────
export interface RegistryRow {
	name: string;
	model_tier: string;
	tools: string[];
	contract_sections: string[];
	may_spawn: boolean;
}
export function registryView(reg: Map<string, AgentBundle>): RegistryRow[] {
	return [...reg.values()]
		.map((b) => ({
			name: b.name,
			model_tier: b.model_tier,
			tools: b.tools,
			contract_sections: b.output_contract.required_sections,
			may_spawn: b.may_spawn ?? false,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ── registry index (the orchestrator's machine-readable roster) ───────────────────────
// Single-sourced from registryView + each bundle's role. `hash` is a content hash over the agent
// rows (NOT generated_at) so it is stable across loads while the bundles are unchanged — enabling
// idempotent writes + drift detection.
export interface RegistryIndexEntry extends RegistryRow {
	role: string;
}
export interface RegistryIndex {
	generated_at: string;
	hash: string;
	count: number;
	agents: RegistryIndexEntry[];
}
export function registryIndex(reg: Map<string, AgentBundle>): RegistryIndex {
	const byName = new Map([...reg.values()].map((b) => [b.name, b.role] as const));
	const agents: RegistryIndexEntry[] = registryView(reg).map((r) => ({ ...r, role: byName.get(r.name) ?? "" }));
	const hash = createHash("sha256").update(JSON.stringify(agents)).digest("hex").slice(0, 16);
	return { generated_at: new Date().toISOString(), hash, count: agents.length, agents };
}

// Compact one-line-per-agent roster for tool descriptions — the AUTHORITATIVE registry awareness
// (always injected into the orchestrator's prompt; never stale, no file dependency).
export function registryDigest(reg: Map<string, AgentBundle>, opts: { exclude?: string[] } = {}): string {
	const ex = new Set(opts.exclude ?? []);
	return registryView(reg)
		.filter((r) => !ex.has(r.name))
		.map((r) => `${r.name}[${r.model_tier}; tools:${r.tools.join("/")}; ->${r.contract_sections.join("+")}]`)
		.join(" \u00b7 ");
}

// Idempotent write of the registry index to `path`. Skips the write when the on-disk hash already
// matches (no mtime churn); creates parent dirs. Returns whether it wrote. Best-effort callers may
// ignore throws (a read-only install still has the authoritative tool-description digest).
export function writeRegistryIndex(
	reg: Map<string, AgentBundle>,
	path: string,
): { path: string; hash: string; written: boolean } {
	const idx = registryIndex(reg);
	try {
		const existing = JSON.parse(readFileSync(path, "utf8")) as { hash?: string };
		if (existing?.hash === idx.hash) return { path, hash: idx.hash, written: false };
	} catch {
		/* missing or unparseable → (re)write */
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(idx, null, 2)}\n`);
	return { path, hash: idx.hash, written: true };
}

// ── template fill (shared by teams + blueprints; fail-closed on a missing var) ─────────
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
	return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k) => {
		if (!(k in vars)) throw new Error(`template references undefined var '${k}'`);
		return vars[k];
	});
}

// ── output contract (L3 / agent-native verification) ─────────────────────────
export function checkContract(text: string, c: OutputContract): { passed: boolean; missing: string[] } {
	const missing = c.required_sections.filter((s) => !text.includes(s));
	const forbidden = (c.forbidden ?? []).filter((f) => text.includes(f)).map((f) => `forbidden:${f}`);
	return { passed: missing.length === 0 && forbidden.length === 0, missing: [...missing, ...forbidden] };
}

// ── Phase 4 hardening primitives (pure + testable) ────────────────────────
const DESTRUCTIVE: RegExp[] = [
	/\brm\s+-[a-z]*[rf]/i,
	/\brm\s+(?:-\S+\s+)*['"]?\//,
	/\brmdir\b/i,
	/\bmkfs\b/i,
	/\bdd\s+if=/i,
	/:\(\)\s*\{.*\|/,
	/\bshutdown\b/i,
	/\breboot\b/i,
	/\bchmod\s+-R\b/i,
	/\bchown\s+-R\b/i,
	/>\s*\/(?:etc|sys|bin|usr|boot)\b/, // clobbering system dirs — dangerous
	/>\s*\/dev\/(?!null\b|zero\b|stdout\b|stderr\b|tty\b|random\b|urandom\b|fd\/)\S/, // /dev/<real device> — dangerous; safe pseudo-devices excluded
	/\btruncate\s+-/i,
	/\bgit\s+(?:push\b|reset\s+--hard|clean\s+-\S*f)/i,
];
export function isDestructiveCmd(cmd: string): boolean {
	return DESTRUCTIVE.some((re) => re.test(cmd));
}
export function hitsProtected(s: string, protectedList: string[]): boolean {
	return protectedList.some((p) => p && s.includes(p));
}
export function escapesRoot(target: string, root: string): boolean {
	// Separator-agnostic so it is correct on Windows (backslash) and POSIX. `relative` yields a path that
	// starts with ".." (or is absolute / on another drive) exactly when `target` lands outside `root` —
	// and is sibling-prefix safe (/work/repo vs /work/repo-x → "../repo-x", flagged).
	const r = resolve(root);
	const abs = resolve(r, target);
	if (abs === r) return false;
	const rel = relative(r, abs);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
// Resolve to the built .js in a dist install, else the .ts source in dev (node --experimental-strip-types).
const _guardBase = join(import.meta.dirname, "..", "extension", "guard");
export const GUARD_EXT = existsSync(`${_guardBase}.js`) ? `${_guardBase}.js` : `${_guardBase}.ts`;

// Run a deterministic verify command cross-platform. Prefers `bash -c` (POSIX semantics — pipes, &&,
// quoting — and the same shell the engine's bash tool uses, Git Bash on Windows); falls back to the
// native command processor only if bash is not installed, so a stock Windows box still runs simple
// verify commands like `npm test`.
function runVerifyShell(cmd: string, cwd: string): { status: number | null; stdout: string; stderr: string } {
	const attempts: Array<[string, string[]]> =
		process.platform === "win32"
			? [
					["bash", ["-c", cmd]],
					[process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", cmd]],
				]
			: [["bash", ["-c", cmd]]];
	let last: SpawnSyncReturns<string> | undefined;
	for (const [shell, args] of attempts) {
		const v = spawnSync(shell, args, { cwd, encoding: "utf8", timeout: 180000 });
		const enoent = v.error && (v.error as NodeJS.ErrnoException).code === "ENOENT";
		if (!enoent) return { status: v.status, stdout: v.stdout ?? "", stderr: v.stderr ?? "" };
		last = v;
	}
	return { status: last?.status ?? 1, stdout: last?.stdout ?? "", stderr: last?.stderr ?? "bash not found" };
}

// ── spawn auth policy ───────────────────────────────────────────────────────────
// By default summon uses BYO-provider auth: a spawned worker resolves its own credentials (API key
// from auth.json / env, or whatever provider the operator configured) exactly like an interactive
// session. Every spawn path (oneshot `summon -p` + pooled `summon --mode rpc`) constructs its env via
// spawnEnv() and MUST pass through assertSpawnAuth() before exec, so the policy is tool-layer-enforced.
//
// Optional opt-in (self-hosted operators only): set SUMMON_FORCE_OAUTH_ROUTING=1 to require
// subscription/OAuth routing — when enabled, spawnEnv() ejects ANTHROPIC_API_KEY so a worker can
// never silently fall back to a billed key, and assertSpawnAuth() fails closed if one is still
// present. This is OFF by default; the shipped product does not assume a Claude subscription.
export function forceOAuthRouting(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.SUMMON_FORCE_OAUTH_ROUTING ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}
export function spawnEnv(root?: string, protectedList?: string[]): NodeJS.ProcessEnv {
	const env = { ...process.env };
	if (forceOAuthRouting(env)) {
		delete (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY; // opt-in: force $0 OAuth — never bill a key
	}
	env.HARNESS_ROOT = root ?? process.cwd();
	// JSON-encoded (not ":"-joined) so protected entries containing a colon — e.g. an absolute Windows
	// path like "C:\\repo\\secrets" — survive the round-trip to the worker-side guard intact.
	env.HARNESS_PROTECTED = JSON.stringify(protectedList ?? DEFAULT_PROTECTED);
	return env;
}
// Extensions that supply provider CREDENTIALS (e.g. Claude subscription OAuth). The worker seal
// (--no-extensions) deliberately strips project + auto-discovered extensions for isolation, but a
// credential provider is infrastructure the worker MUST carry to authenticate. buildWorkerArgs
// injects each via explicit -e (which survives the seal, exactly like GUARD_EXT), so ONLY declared
// auth paths cross the seal — never ambient project context, and the two spawn transports can't
// drift. Declared out-of-band via SUMMON_AUTH_EXTENSIONS: a JSON array (recommended — robust to
// path separators) or a path.delimiter/comma-separated list. Missing paths are dropped (loud, via
// warn) so a stale entry can't wedge spawning; assertSpawnAuth() fails closed when forced-OAuth is
// on and NONE resolve, turning the old silent "No API key" 0-byte failure into an actionable error.
export function authExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = (env.SUMMON_AUTH_EXTENSIONS ?? "").trim();
	if (!raw) return [];
	let candidates: string[];
	if (raw.startsWith("[")) {
		try {
			const parsed = JSON.parse(raw);
			candidates = Array.isArray(parsed) ? parsed.map(String) : [];
		} catch {
			candidates = [];
		}
	} else {
		candidates = raw.split(new RegExp(`[${delimiter},]`));
	}
	const out: string[] = [];
	for (const c of candidates) {
		const p = c.trim();
		if (!p) continue;
		if (!existsSync(p)) {
			console.error(`[harness] SUMMON_AUTH_EXTENSIONS: skipping missing auth extension: ${p}`);
			continue;
		}
		out.push(p);
	}
	return out;
}
export function assertSpawnAuth(env: NodeJS.ProcessEnv, sysPrompt: string): void {
	// A non-empty system prompt is always required: an empty --system-prompt routes Anthropic calls to
	// pay-per-token "extra usage", which is never what a worker wants.
	if (!sysPrompt || !sysPrompt.trim())
		throw new Error(
			"spawn auth: empty --system-prompt — a non-empty system prompt is required before spawning a worker",
		);
	// Opt-in OAuth canary (SUMMON_FORCE_OAUTH_ROUTING): fail closed if a billable key survived into the
	// worker env, so forced-subscription deployments can never silently bill pay-per-token.
	if (forceOAuthRouting(env) && env.ANTHROPIC_API_KEY)
		throw new Error(
			"$0-OAuth canary: SUMMON_FORCE_OAUTH_ROUTING is set but ANTHROPIC_API_KEY is present in worker env — eject it before spawn",
		);
	// Fail-closed credential-path check: with the API key ejected (above), a forced-OAuth worker can
	// ONLY authenticate through an injected auth extension. If none resolve, the sealed worker would
	// silently emit "No API key for provider: anthropic" and 0 bytes — so refuse to spawn, loudly.
	if (forceOAuthRouting(env) && authExtensions(env).length === 0)
		throw new Error(
			"$0-OAuth routing has no credential path: SUMMON_FORCE_OAUTH_ROUTING=1 ejects ANTHROPIC_API_KEY, but " +
				"SUMMON_AUTH_EXTENSIONS resolves to no loadable extension, so the sealed worker (--no-extensions) cannot " +
				"authenticate. Set SUMMON_AUTH_EXTENSIONS to your OAuth extension path " +
				"(e.g. /root/.summon/extensions/anthropic-oauth/index.ts).",
		);
}

// ── window governor (weighted concurrency + rolling-window usage tracking) ──────────────────
// Provider rate/usage limits are typically enforced over a rolling time window, so the governor caps
// simultaneous WEIGHT (frontier costs more than fast) AND tracks estimated token consumption inside
// a configurable rolling window. windowPct() surfaces that to observability; when a hard budget is
// configured (budgetTokens > 0) admit() also queues once the window is exhausted, draining as old
// usage ages out. windowMs/budgetTokens default to generic values and are fully configurable.
const WEIGHT = { fast: 1, standard: 2, frontier: 4 } as const;
export const DEFAULT_WINDOW_MS = 5 * 60 * 60 * 1000; // default rolling window (5h); override via opts.windowMs
// Rough output/input token estimate from character count (~4 chars/token). Labelled an estimate
// because we do not get exact provider usage off the subprocess; a proxy beats count-only gating.
export function estimateTokens(chars: number): number {
	return Math.max(0, Math.ceil(chars / 4));
}
export interface WindowGovernorOpts {
	maxWeight?: number;
	windowMs?: number;
	budgetTokens?: number; // 0 => tracking only (no hard gate, never hangs a session)
	now?: () => number; // injectable clock for offline wait-latency tests; default () => Date.now()
	// When true, in-flight reserved (pre-admission, approximate) tokens also count toward the window
	// gate, so a burst can't over-commit the budget before completions land. Default false = the
	// admission decision is byte-identical to a consumed()-only gate.
	reserveGate?: boolean;
}
// Hooks let the dependency-free core surface admission transitions to the caller's event bus WITHOUT
// importing it: the extension passes plain callbacks (so core stays unit-testable offline). reserveTokens
// is an APPROXIMATE pre-admission estimate (output bytes are unknown until completion) that is
// reconciled — subtracted — when the admitted slot is released.
export interface AdmitHooks {
	onQueued?: (info: { queueDepth: number; w: number }) => void;
	onAdmitted?: (info: { waitedMs: number; w: number }) => void;
	reserveTokens?: number;
}
export class WindowGovernor {
	private inUse = 0;
	private maxWeight: number; // mutable: the scale dial (#4) can resize the cap at runtime
	private readonly windowMs: number;
	private readonly budgetTokens: number;
	private readonly clock: () => number;
	private readonly reserveGate: boolean;
	private events: Array<{ ts: number; tokens: number }> = [];
	// FIFO admission queue: each waiter carries its weight, its reservation, the enqueue time (for
	// wait-latency), and the resolver pump() calls when the slot frees.
	private waiters: Array<{ w: number; reserve: number; enqueuedAt: number; resolve: () => void }> = [];
	// Sum of admit-time reservations not yet reconciled on release (surfaced via reservedTokens()).
	private reserved = 0;
	// Single re-pump timer for waiters blocked SOLELY by the rolling-window budget: such a waiter is
	// not woken by a release/record (only by usage aging OUT of the window), so we arm one .unref()'d
	// timer to re-pump at the age-out moment. Only ever armed when a hard budget gate is configured.
	private windowTimer: ReturnType<typeof setTimeout> | null = null;
	constructor(opts: WindowGovernorOpts = {}) {
		this.maxWeight = opts.maxWeight ?? 8;
		this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
		this.budgetTokens = Math.max(0, opts.budgetTokens ?? 0);
		this.clock = opts.now ?? (() => Date.now());
		this.reserveGate = opts.reserveGate ?? false;
	}
	private prune(now: number): void {
		const cut = now - this.windowMs;
		while (this.events.length && this.events[0].ts < cut) this.events.shift();
	}
	// Estimated tokens consumed inside the current rolling window.
	consumed(now = Date.now()): number {
		this.prune(now);
		let sum = 0;
		for (const e of this.events) sum += e.tokens;
		return sum;
	}
	// Record a completed spawn's estimated token cost against the window.
	record(tokens: number, now = Date.now()): void {
		if (tokens > 0) this.events.push({ ts: now, tokens });
	}
	// % of the rolling usage window consumed (0 when no budget configured — tracking only).
	windowPct(now = Date.now()): number {
		if (!this.budgetTokens) return 0;
		return Math.min(100, Math.round((this.consumed(now) / this.budgetTokens) * 100));
	}
	// % of the concurrency budget in use.
	loadPct(): number {
		return Math.round((this.inUse / this.maxWeight) * 100);
	}
	// Runtime scale dial (#4): resize the weighted concurrency cap. Raising it wakes waiters that now
	// fit; lowering it simply gates new admissions until in-flight work drains (never kills running work).
	setMaxWeight(n: number): void {
		this.maxWeight = Math.max(1, Math.floor(n));
		this.pump();
	}
	maxWeightCap(): number {
		return this.maxWeight;
	}
	// Whether a task of weight `w` (optionally reserving `reserve` tokens) fits right now.
	private hasHeadroom(w: number, reserve = 0): boolean {
		if (this.inUse + w > this.maxWeight) return false; // concurrency cap
		// reserved tokens only gate admission when reserveGate is on; off (the default) is byte-identical
		// to the historical consumed()-only gate.
		const used = this.consumed() + (this.reserveGate ? this.reserved + reserve : 0);
		if (this.budgetTokens && used >= this.budgetTokens) return false; // window exhausted
		return true;
	}
	private makeRelease(w: number, reserve: number): () => void {
		return () => {
			this.inUse -= w;
			this.reserved = Math.max(0, this.reserved - reserve);
			this.pump();
		};
	}
	// FIFO head-of-line wake: while the FRONT waiter now fits, admit it. pump() OWNS the inUse/reserved
	// increment for queued waiters — the admit() continuation must NOT re-add them (else double-count).
	private pump(): void {
		while (this.waiters.length && this.hasHeadroom(this.waiters[0].w, this.waiters[0].reserve)) {
			const next = this.waiters.shift()!;
			this.inUse += next.w;
			this.reserved += next.reserve;
			next.resolve();
		}
		this.scheduleWindowWake();
	}
	// Arm one re-pump for a head waiter blocked ONLY by the window budget (concurrency has room): such a
	// waiter is freed by usage aging out of the window, which is not an event, so we wake it precisely at
	// the age-out moment instead of busy-polling. No-op without a hard budget or when nothing can age out.
	private scheduleWindowWake(): void {
		if (!this.budgetTokens || this.windowTimer || this.waiters.length === 0) return;
		const head = this.waiters[0];
		if (this.inUse + head.w > this.maxWeight) return; // blocked by concurrency: a release will wake it
		const now = this.clock();
		this.prune(now);
		if (this.events.length === 0) return; // nothing to age out (e.g. blocked purely by reservations)
		const ageOutIn = Math.max(1, this.events[0].ts + this.windowMs - now);
		const t = setTimeout(() => {
			this.windowTimer = null;
			this.pump();
		}, ageOutIn);
		t.unref?.();
		this.windowTimer = t;
	}
	async admit(b: AgentBundle, hooks?: AdmitHooks): Promise<() => void> {
		const w = WEIGHT[b.model_tier];
		const reserve = hooks?.reserveTokens ?? 0;
		if (this.hasHeadroom(w, reserve)) {
			this.inUse += w;
			this.reserved += reserve;
			return this.makeRelease(w, reserve);
		}
		const enqueuedAt = this.clock();
		await new Promise<void>((resolve) => {
			this.waiters.push({ w, reserve, enqueuedAt, resolve });
			hooks?.onQueued?.({ queueDepth: this.waiters.length, w });
			this.scheduleWindowWake();
		});
		// pump() already incremented inUse + reserved for this waiter before resolving — do NOT re-add.
		hooks?.onAdmitted?.({ waitedMs: this.clock() - enqueuedAt, w });
		return this.makeRelease(w, reserve);
	}
	// ── introspection (pure reads; safe to call any time, no side effects) ──
	queueDepth(): number {
		return this.waiters.length;
	}
	oldestWaitMs(now = this.clock()): number {
		return this.waiters.length ? now - this.waiters[0].enqueuedAt : 0;
	}
	inUseWeight(): number {
		return this.inUse;
	}
	headroom(): number {
		return Math.max(0, this.maxWeight - this.inUse);
	}
	reservedTokens(): number {
		return this.reserved;
	}
}

export interface SpawnResult {
	agent: string;
	status: "done" | "failed" | "timeout" | "contract_violation" | "verify_failed";
	artifact_path?: string;
	artifact_excerpt: string;
	contract: { passed: boolean; missing: string[] };
	verify?: { cmd: string; passed: boolean; output: string };
	cached?: "cache" | "inflight"; // set when this result was served from the within-run result cache (#5)
	meta: { model: string; elapsed_s: number; bytes: number };
}

// ── retry combinator (pure + injectable — no subprocess knowledge) ─────────────
export async function withRetry(
	maxAttempts: number,
	run: (attempt: number, prev?: SpawnResult) => Promise<SpawnResult>,
): Promise<SpawnResult> {
	let last: SpawnResult | undefined;
	const n = Math.max(1, Math.floor(maxAttempts || 1));
	for (let a = 1; a <= n; a++) {
		last = await run(a, last);
		if (last.status === "done") return last; // success → stop early
	}
	return last!; // attempts exhausted → escalate last result
}

// ── feedback helper: shift retry context into the next attempt's prompt ───────
export function retryPrompt(prompt: string, prev?: SpawnResult): string {
	if (!prev) return prompt;
	const why =
		prev.status === "verify_failed"
			? `verify failed:\n${prev.verify?.output ?? ""}`
			: prev.status === "contract_violation"
				? `missing required sections: ${prev.contract.missing.join(", ")}`
				: `previous attempt ${prev.status}`;
	return `${prompt}\n\n## RETRY — your previous attempt did not pass\n${why}\nFix this and try again.`;
}

// ── expertise loader (reads context_globs into a bounded system-prompt appendix) ──
// Resolve a bundle's context_globs (relative to _dir), read the matched files, and return a
// bounded "## Expertise context" block to append to the system prompt. "" if nothing to add.
export function loadExpertise(bundle: AgentBundle, maxBytes = 8000): string {
	if (!bundle.context_globs?.length || !bundle._dir) return "";
	const files: string[] = [];
	for (const g of bundle.context_globs) {
		const star = g.indexOf("*");
		if (star === -1) {
			const p = join(bundle._dir, g);
			if (existsSync(p)) files.push(p);
		} else {
			// single-level "dir/*.md" style glob — expand via readdir on the glob's directory
			const slash = g.lastIndexOf("/");
			const dir = slash === -1 ? bundle._dir : join(bundle._dir, g.slice(0, slash));
			const pat = slash === -1 ? g : g.slice(slash + 1);
			if (!existsSync(dir)) continue;
			const re = new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
			for (const name of readdirSync(dir)) if (re.test(name)) files.push(join(dir, name));
		}
	}
	if (!files.length) return "";
	const seen = new Set<string>();
	let out = "## Expertise context\n";
	for (const f of files.sort()) {
		if (seen.has(f)) continue;
		seen.add(f);
		let body: string;
		try {
			body = readFileSync(f, "utf8");
		} catch {
			continue;
		}
		out += `\n### ${f}\n${body}\n`;
		if (out.length >= maxBytes) {
			out = `${out.slice(0, maxBytes)}\n\u2026[expertise truncated]`;
			break;
		}
	}
	return out;
}

// ── persistent expertise (#7): a per-bundle, self-maintained expertise.md ──────
// The bundle opts in with `expertise: true`. The harness reads the file into the worker's prompt at
// boot (newest notes kept) and, on a successful run, appends the worker's optional `## expertise`
// self-note (deduped, capped). The agent owns the file; lessons compound across runs.
export function parseExpertiseNote(text: string): string {
	const m = text.match(/##\s*expertise\b([\s\S]*?)(?:\n##\s|$)/i);
	return m ? m[1].trim() : "";
}
export function loadExpertiseMemory(bundle: AgentBundle, maxBytes = 4000): string {
	if (!bundle.expertise || !bundle._dir) return "";
	let body: string;
	try {
		body = readFileSync(join(bundle._dir, "expertise.md"), "utf8");
	} catch {
		return "";
	}
	if (!body.trim()) return "";
	const clipped = body.length > maxBytes ? body.slice(-maxBytes) : body; // keep the newest (end)
	return `## Prior expertise (your own self-maintained notes)\n${clipped}`;
}
// Append a note to the bundle's expertise.md: dedup (skip if already present), timestamp, and cap to
// the last `maxEntries` notes. Returns whether it wrote.
export function appendExpertiseNote(bundle: AgentBundle, note: string, opts: { maxEntries?: number } = {}): boolean {
	const dir = bundle._dir;
	const trimmed = note.trim();
	if (!dir || !trimmed) return false;
	const path = join(dir, "expertise.md");
	const maxEntries = Math.max(1, opts.maxEntries ?? 40);
	let existing = "";
	try {
		existing = readFileSync(path, "utf8");
	} catch {
		/* new file */
	}
	if (existing.includes(trimmed)) return false; // dedup — already recorded
	const blocks: string[] = [];
	let cur: string[] | null = null;
	for (const ln of existing.split("\n")) {
		if (/^## /.test(ln)) {
			if (cur) blocks.push(cur.join("\n").trim());
			cur = [ln];
		} else if (cur) cur.push(ln);
	}
	if (cur) blocks.push(cur.join("\n").trim());
	blocks.push(`## ${new Date().toISOString()}\n${trimmed}`);
	const header = `# ${bundle.name} expertise (self-maintained; newest last)`;
	const body = `${header}\n\n${blocks.slice(-maxEntries).join("\n\n")}\n`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, body);
	return true;
}

// Single source for a worker's system prompt: routing header + role + output-contract instruction +
// scoped context (context_globs) + self-maintained expertise memory (#7).
export function buildSystemPrompt(bundle: AgentBundle): string {
	const lines = [
		SYS_HEADER,
		bundle.role,
		`End your reply with exactly these markdown sections: ${bundle.output_contract.required_sections.join(", ")}.`,
	];
	if (bundle.expertise)
		lines.push(
			"You MAY add a final optional '## expertise' section: 1-3 terse, durable bullet lessons for your future self (a gotcha, params that worked). It is recorded across runs — omit it if you learned nothing new.",
		);
	return [lines.join("\n\n"), loadExpertiseMemory(bundle), loadExpertise(bundle)].filter(Boolean).join("\n\n");
}

// Build the SpawnResult from a worker's final text + exit code: contract check · deterministic verify
// (the harness re-runs the acceptance command itself; a failing check overrides 'done') · artifact write.
export function finalizeResult(
	bundle: AgentBundle,
	text: string,
	code: number | null,
	opts: { runDir?: string; taskId?: string; verify?: string; root?: string },
	t0: number,
	model: string,
): SpawnResult {
	const contract = checkContract(text, bundle.output_contract);
	let status: SpawnResult["status"] =
		code === 0 ? (contract.passed ? "done" : "contract_violation") : code === null ? "timeout" : "failed";
	// DETERMINISTIC verification: the harness RUNS the acceptance check itself — it never trusts the
	// agent's claim that "tests pass". A failing verify overrides a "done".
	let verify: SpawnResult["verify"];
	if (opts.verify && status === "done") {
		if (isDestructiveCmd(opts.verify)) {
			verify = { cmd: opts.verify, passed: false, output: "blocked: destructive verify command" };
			status = "verify_failed";
		} else {
			const v = runVerifyShell(opts.verify, opts.root ?? process.cwd());
			const passed = v.status === 0;
			verify = { cmd: opts.verify, passed, output: ((v.stdout ?? "") + (v.stderr ?? "")).slice(-1200) };
			if (!passed) status = "verify_failed";
		}
	}
	// Persistent expertise write-back (#7): on success, fold the worker's optional self-note into its
	// bundle's expertise.md so lessons compound across runs (best-effort; never fails the result).
	if (status === "done" && bundle.expertise) {
		try {
			appendExpertiseNote(bundle, parseExpertiseNote(text));
		} catch {
			/* best-effort */
		}
	}
	let artifact_path: string | undefined;
	if (opts.runDir) {
		mkdirSync(opts.runDir, { recursive: true });
		artifact_path = join(opts.runDir, `${opts.taskId ?? bundle.name}.md`);
		writeFileSync(artifact_path, text);
		appendFileSync(
			join(opts.runDir, "ledger.jsonl"),
			JSON.stringify({ ts: Date.now(), task: opts.taskId, agent: bundle.name, status, verify: verify?.passed }) +
				"\n",
		);
	}
	return {
		agent: bundle.name,
		status,
		artifact_path,
		artifact_excerpt: text.slice(0, 1500),
		contract,
		verify,
		meta: { model, elapsed_s: (Date.now() - t0) / 1000, bytes: text.length },
	};
}

// Discovery-disabling flags that SEAL a spawned worker: it receives exactly the
// extension/skill/prompt/theme/context we pass explicitly (--skill, -e guard) and
// nothing ambient. Each `--no-*` flag drops only *discovered* resources; explicit
// CLI paths still load (verified in resource-loader: noExtensions/noSkills/etc.
// keep cliEnabled + additional paths, drop only auto-discovered ones).
//
// This is both a perf win — no jiti (TS transpiler) init and no filesystem
// discovery walks per worker — and an isolation guarantee: a tool-restricted
// sub-agent can never inherit project AGENTS.md/CLAUDE.md context, a user theme,
// or a stray TypeScript extension. EVERY spawn path MUST route through
// buildWorkerArgs so a worker can never be spawned unsealed.
export const WORKER_SEAL_FLAGS = [
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
] as const;

// Per-tier worker model. Defaults to the Anthropic MODEL map, but SUMMON_WORKER_MODEL_{FAST,STANDARD,
// FRONTIER} (any summon model pattern, e.g. "openrouter/anthropic/claude-haiku-4.5") overrides it — so
// the harness fan-out can run on whatever provider the operator has, not just Anthropic. Read from the
// spawn env (not raw process.env) so the two transports stay in lockstep and tests can inject it.
export function workerModel(tier: AgentBundle["model_tier"], env: NodeJS.ProcessEnv = process.env): string {
	return env[`SUMMON_WORKER_MODEL_${tier.toUpperCase()}`] || MODEL[tier];
}

// Build the full argv tail shared by every worker transport. `head` carries the
// mode-specific prefix (e.g. ["-p","--no-session","--mode","json"] for one-shot,
// ["--mode","rpc","--no-session"] for the pooled rpc worker). The model, system
// prompt, tool allowlist, seal flags, explicit skill, and write-guard are applied
// identically so the two transports can never drift apart.
export function buildWorkerArgs(bundle: AgentBundle, head: string[], env: NodeJS.ProcessEnv = process.env): string[] {
	const args = [
		...head,
		"--model",
		workerModel(bundle.model_tier, env),
		"--system-prompt",
		buildSystemPrompt(bundle),
		"--tools",
		bundle.tools.join(","),
		...WORKER_SEAL_FLAGS,
	];
	// Carry declared credential extensions (e.g. subscription OAuth) past the seal via explicit -e —
	// the only extensions allowed to cross --no-extensions, so a sealed worker can still authenticate.
	for (const ext of authExtensions(env)) args.push("-e", ext);
	if (bundle.skills?.length && bundle._dir) {
		const sk = join(bundle._dir, "SKILL.md");
		if (existsSync(sk)) args.push("--skill", sk);
	}
	// Hardening: load the guard into any worker that can write/exec (blocks destructive bash +
	// out-of-root / protected-path writes at the tool layer — enforcement, not prompt convention).
	if (bundle.tools.some((t) => WRITE_TOOLS.has(t))) args.push("-e", GUARD_EXT);
	return args;
}

// SIGKILL deadline (ms) for a spawned worker. The agent definition's timeout_s is the per-agent
// intent; SUMMON_AGENT_TIMEOUT_S (seconds, set at launch) raises it to a global FLOOR so a long task
// (e.g. a deep audit) isn't cut off without re-editing every agent.json. It only ever EXTENDS — an
// agent already configured longer than the floor keeps its own value. Both spawn transports route
// through this so they can't drift.
export function agentTimeoutMs(bundle: { timeout_s?: number }, env: NodeJS.ProcessEnv = process.env): number {
	const base = bundle.timeout_s ?? 600;
	const floor = Number(env.SUMMON_AGENT_TIMEOUT_S);
	const sec = Number.isFinite(floor) && floor > 0 ? Math.max(base, floor) : base;
	return sec * 1000;
}

// ── spawn one worker via `summon -p --mode json` (the proven transport) ───────────
export function spawnOnce(
	bundle: AgentBundle,
	prompt: string,
	opts: {
		runDir?: string;
		taskId?: string;
		onEvent?: (ev: any) => void;
		verify?: string;
		protected?: string[];
		root?: string;
	} = {},
): Promise<SpawnResult> {
	const model = MODEL[bundle.model_tier];
	const sys = buildSystemPrompt(bundle);
	const env = spawnEnv(opts.root, opts.protected);
	const args = buildWorkerArgs(bundle, ["-p", "--no-session", "--mode", "json"], env);
	assertSpawnAuth(env, sys); // fail-closed auth check before we spawn anything
	const t0 = Date.now();
	return new Promise((resolve) => {
		const { cmd, prefix } = agentSpawnCommand();
		const child = spawn(cmd, [...prefix, ...args], { env });
		let text = "",
			buf = "";
		const killer = setTimeout(() => child.kill("SIGKILL"), agentTimeoutMs(bundle));
		child.stdin.write(prompt);
		child.stdin.end();
		child.stdout.on("data", (d) => {
			buf += d.toString();
			let nl: number = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				if (!line.trim()) continue;
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				opts.onEvent?.(ev);
				// the final answer = the LAST assistant message's text content (thinking excluded)
				if (ev.type === "message_end" && ev.message?.role === "assistant" && Array.isArray(ev.message.content)) {
					const t = ev.message.content
						.filter((c: any) => c?.type === "text")
						.map((c: any) => c.text)
						.join("");
					if (t) text = t;
				}
			}
		});
		child.on("close", (code) => {
			clearTimeout(killer);
			resolve(finalizeResult(bundle, text, code, opts, t0, model));
		});
	});
}

// ── builder→reviewer auto-pairing (pure + testable) ─────────────────────────────────
export function parseVerdict(text: string): "APPROVE" | "REJECT" | "UNKNOWN" {
	const m = text.match(/##\s*verdict\b([\s\S]*?)(?:\n##\s|$)/i);
	const section = m ? m[1] : text;
	if (/\bREJECT\b/.test(section)) return "REJECT"; // fail-closed: REJECT wins if both present
	if (/\bAPPROVE\b/.test(section)) return "APPROVE";
	return "UNKNOWN";
}

export function reviewDecision(
	buildStatus: SpawnResult["status"],
	reviewText?: string,
): { approved: boolean; reason: string } {
	if (buildStatus !== "done") return { approved: false, reason: `build ${buildStatus} — not reviewed` };
	if (reviewText == null) return { approved: false, reason: "no reviewer output" };
	const v = parseVerdict(reviewText);
	if (v === "APPROVE") return { approved: true, reason: "reviewer APPROVE" };
	if (v === "REJECT") return { approved: false, reason: "reviewer REJECT" };
	return { approved: false, reason: "reviewer verdict unparseable (fail-closed)" };
}

export interface ReviewOutcome {
	build: SpawnResult;
	review?: SpawnResult;
	approved: boolean;
	reason: string;
}

// Generic, injectable build→review orchestration (no Pi/subprocess knowledge → unit-testable).
export async function runWithReview(
	build: () => Promise<SpawnResult>,
	review: (b: SpawnResult) => Promise<SpawnResult>,
	opts: { enabled?: boolean } = {},
): Promise<ReviewOutcome> {
	const b = await build();
	if (opts.enabled === false) return { build: b, approved: b.status === "done", reason: "review disabled" };
	if (b.status !== "done") return { build: b, approved: false, reason: `build ${b.status} — not reviewed` };
	const r = await review(b);
	const d = reviewDecision(b.status, r.artifact_excerpt);
	return { build: b, review: r, approved: d.approved, reason: d.reason };
}

// ── best-of-N / quorum (pure + injectable → unit-testable, mirrors runWithReview) ─────────────
// Spawn K candidate attempts of one agent, keep only those that passed deterministic verify + contract
// (status === "done" — see finalizeResult), pick a winner by objective majority vote among identical
// outputs, and fall back to an injected judge over the survivors only when they diverge. No
// subprocess/fs knowledge — the caller injects the candidate + judge closures.
export interface QuorumOutcome {
	winner?: SpawnResult; // chosen candidate; undefined iff every candidate failed verify/contract
	ranking: SpawnResult[]; // all candidates, winner first, then spawn order
	survivors: SpawnResult[]; // candidates with status === "done" (verify + contract passed)
	agreement: "majority" | "judged" | "none";
	decidedBy: "vote" | "judge" | "no-survivor";
	groupSize?: number; // size of the winning identical-output group (vote path only)
	judge?: SpawnResult; // the judge's own result (judged path only)
}

// Equivalence key for the majority vote: whitespace-collapsed output text. APPROXIMATE (textual
// identity, not semantic) — the judge fallback is the correctness backstop.
export function candidateKey(r: SpawnResult): string {
	return (r.artifact_excerpt ?? "").replace(/\s+/g, " ").trim();
}

// Pure pre-filter + grouping: survivors = candidates whose status is "done" (which, per finalizeResult,
// means the contract passed AND any supplied deterministic verify passed); grouped by candidateKey.
export function tallyQuorum(results: SpawnResult[]): { groups: Map<string, SpawnResult[]>; survivors: SpawnResult[] } {
	const survivors = results.filter((r) => r.status === "done");
	const groups = new Map<string, SpawnResult[]>();
	for (const r of survivors) {
		const k = candidateKey(r);
		const g = groups.get(k);
		if (g) g.push(r);
		else groups.set(k, [r]);
	}
	return { groups, survivors };
}

// Parse a judge verdict like "## verdict\nAPPROVE candidate 2" → 2 (bounds-checked), else undefined.
export function parseQuorumPick(text: string, n: number): number | undefined {
	const m = text.match(/##\s*verdict\b([\s\S]*?)(?:\n##\s|$)/i);
	const section = m ? m[1] : text;
	const pick = section.match(/(?:candidate|#)\s*(\d+)/i);
	if (!pick) return undefined;
	const i = Number(pick[1]);
	return Number.isInteger(i) && i >= 0 && i < n ? i : undefined;
}

// The pure combinator. candidates/judge are injected closures; a candidate that throws is captured as a
// failed SpawnResult (never rethrown). maxN caps how many candidate closures are invoked.
export async function runQuorum(
	candidates: Array<() => Promise<SpawnResult>>,
	judge: (survivors: SpawnResult[]) => Promise<SpawnResult>,
	opts: { maxN?: number } = {},
): Promise<QuorumOutcome> {
	const n = Math.max(1, opts.maxN ?? candidates.length);
	const all = await Promise.all(
		candidates.slice(0, n).map((c) =>
			c().catch(
				(e): SpawnResult => ({
					agent: "quorum",
					status: "failed",
					artifact_excerpt: e instanceof Error ? e.message : String(e),
					contract: { passed: false, missing: [] },
					meta: { model: "", elapsed_s: 0, bytes: 0 },
				}),
			),
		),
	);
	const rankBy = (winners: SpawnResult[]): SpawnResult[] => [...winners, ...all.filter((r) => !winners.includes(r))];
	const { groups, survivors } = tallyQuorum(all);
	if (survivors.length === 0)
		return { winner: undefined, ranking: all, survivors, agreement: "none", decidedBy: "no-survivor" };
	// Largest identical-output group (deterministic: Map preserves first-insertion order on ties).
	let best: SpawnResult[] = [];
	for (const g of groups.values()) if (g.length > best.length) best = g;
	if (best.length > survivors.length / 2) {
		const winner = best[0];
		return {
			winner,
			ranking: rankBy([winner]),
			survivors,
			agreement: "majority",
			decidedBy: "vote",
			groupSize: best.length,
		};
	}
	// No strict majority among distinct survivors → judge. Fail-SAFE (not closed) to the first survivor if
	// the verdict is unparseable, because every survivor already passed deterministic verify + contract.
	const v = await judge(survivors);
	const pick = parseQuorumPick(v.artifact_excerpt ?? "", survivors.length);
	const winner = survivors[pick ?? 0] ?? survivors[0];
	return { winner, ranking: rankBy([winner]), survivors, agreement: "judged", decidedBy: "judge", judge: v };
}

// ── public entry point: thin wrapper that applies bundle.max_attempts via withRetry ──
export function spawnAgent(
	bundle: AgentBundle,
	prompt: string,
	opts: {
		runDir?: string;
		taskId?: string;
		onEvent?: (ev: any) => void;
		verify?: string;
		protected?: string[];
		root?: string;
	} = {},
): Promise<SpawnResult> {
	return withRetry(bundle.max_attempts ?? 1, (attempt, prev) =>
		spawnOnce(bundle, attempt === 1 ? prompt : retryPrompt(prompt, prev), opts),
	);
}
