import assert from "node:assert";
import { describe, it } from "node:test";
import { TUI } from "../src/tui.ts";
import { normalizeTerminalOutput } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Regression guard for the per-frame normalization memo (see TUI.applyLineResets).
//
// normalizeTerminalOutput()+reset is a pure function of the raw line, so the TUI caches last frame's
// raw lines and their normalized output and reuses the SAME normalized string instance for any line
// whose raw text is unchanged. This keeps a long session (high context %) from re-normalizing and
// re-allocating every scrollback line on every spinner tick / keystroke — the cause of laggy typing,
// animations, and timers once the conversation grows.
//
// If this test fails, the memo regressed: either correctness (normalized output must always equal a
// fresh normalization) or the reuse contract (unchanged lines must keep a stable instance, which is
// what makes the doRender diff loop O(1) per unchanged line).

const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";
const normalize = (line: string) => normalizeTerminalOutput(line) + SEGMENT_RESET;

function newTui() {
	const tui = new TUI(new VirtualTerminal(80, 24));
	// applyLineResets is private; exercise it directly to simulate successive frames.
	const apply = (lines: string[]): string[] =>
		(tui as unknown as { applyLineResets(l: string[]): string[] }).applyLineResets(lines);
	return { tui, apply };
}

describe("TUI normalization memo (applyLineResets)", () => {
	it("produces output identical to a fresh normalization", () => {
		const { apply } = newTui();
		const raw = ["plain text", "with \x1b[31mcolor\x1b[0m", "tab\there", ""];
		const out = apply(raw.slice());
		for (let i = 0; i < raw.length; i++) {
			assert.strictEqual(out[i], normalize(raw[i]), `line ${i} must equal fresh normalization`);
		}
	});

	it("reuses the same normalized string instance for unchanged lines across frames", () => {
		const { apply } = newTui();
		const frame1 = ["Line A", "Line B", "Line C"];
		const out1 = apply(frame1.slice());

		// Frame 2: only the last line changes. The unchanged lines are passed as BRAND-NEW string
		// instances (same content) to prove the cache keys on value, not reference identity.
		const frame2 = ["Line A".slice(), `${"Line "}B`, "Line C changed"];
		const out2 = apply(frame2);

		assert.strictEqual(out2[0], out1[0], "unchanged line 0 must reuse the prior normalized instance");
		assert.strictEqual(out2[1], out1[1], "unchanged line 1 must reuse the prior normalized instance");
		assert.notStrictEqual(out2[2], out1[2], "changed line 2 must be recomputed");
		assert.strictEqual(out2[2], normalize("Line C changed"), "recomputed line must still be correct");
	});

	it("does not mutate its input array (returns a fresh array)", () => {
		const { apply } = newTui();
		const raw = ["x", "y"];
		const snapshot = raw.slice();
		const out = apply(raw);
		assert.notStrictEqual(out, raw, "must return a new array, not mutate in place");
		assert.deepStrictEqual(raw, snapshot, "input array contents must be left untouched");
	});

	it("recomputes correctly when a line's content changes back and forth", () => {
		const { apply } = newTui();
		apply(["a", "b"]);
		apply(["a", "B"]);
		const out = apply(["a", "b"]);
		assert.strictEqual(out[0], normalize("a"));
		assert.strictEqual(out[1], normalize("b"));
	});
});
