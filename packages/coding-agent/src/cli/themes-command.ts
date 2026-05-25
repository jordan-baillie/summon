/**
 * themes-command.ts
 *
 * Implements `pi themes` (list available themes with previews)
 * and `pi themes <name>` (persist theme selection to settings).
 */

import chalk from "chalk";
import { getAgentDir } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { getAvailableThemesWithPaths, getThemeByName } from "../modes/interactive/theme/theme.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Repeat a character n times. */
function rep(ch: string, n: number): string {
	return n > 0 ? ch.repeat(n) : "";
}

/** Visible length of a string ignoring ANSI escapes. */
function visLen(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").length;
}

/** Right-pad a string to a visible width. */
function padRight(s: string, width: number): string {
	const pad = width - visLen(s);
	return pad > 0 ? `${s}${" ".repeat(pad)}` : s;
}

/**
 * Render a 6-line preview for the given theme at `width` columns.
 * We hand-roll the lines using the theme's actual glyphs/colors/layout
 * so the user can see the real difference between themes.
 */
function renderPreview(themeName: string, width: number): string[] {
	const t = getThemeByName(themeName);
	if (!t) return [`  ${chalk.red(`(theme "${themeName}" could not be loaded)`)}`];

	const hr = t.glyph("hr") || "─";
	const sep = t.footerSeparator();
	const ascii = t.isAsciiOnly();

	const indent = "  "; // 2-space global indent for preview block

	// ── Line 1: role header (user) ───────────────────────────────────────────
	let line1: string;
	const style = t.roleLabelStyle();
	if (style === "smallcaps") {
		const label = t.roleLabel("user").toUpperCase();
		const hrCount = Math.max(0, width - indent.length - label.length - 1);
		line1 = `${indent}${t.fg("accent", label)} ${t.fg("muted", rep(hr, hrCount))}`;
	} else if (style === "bracket") {
		const label = t.roleLabel("user");
		const open = `${hr}${hr}[ ${label} ]`;
		const hrCount = Math.max(0, width - indent.length - open.length);
		line1 = `${indent}${t.fg("muted", `${open}${rep(hr, hrCount)}`)}`;
	} else {
		// "none" — dark/light fills, show a bg-coloured user line
		line1 = `${indent}${t.bg("userMessageBg", padRight(t.fg("userMessageText", " What's the weather?"), width - indent.length))}`;
	}

	// ── Line 2: user body ────────────────────────────────────────────────────
	let line2: string;
	if (style === "none") {
		line2 = `${indent}${t.bg("userMessageBg", padRight(t.fg("userMessageText", ""), width - indent.length))}`;
	} else {
		line2 = `${indent} ${t.fg("text", "What's the weather in Sydney?")}`;
	}

	// ── Line 3: role header (assistant) ─────────────────────────────────────
	let line3: string;
	if (style === "smallcaps") {
		const label = t.roleLabel("assistant").toUpperCase();
		const hrCount = Math.max(0, width - indent.length - label.length - 1);
		line3 = `${indent}${t.fg("accent", label)} ${t.fg("muted", rep(hr, hrCount))}`;
	} else if (style === "bracket") {
		const label = t.roleLabel("assistant");
		const open = `${hr}${hr}[ ${label} ]`;
		const hrCount = Math.max(0, width - indent.length - open.length);
		line3 = `${indent}${t.fg("muted", `${open}${rep(hr, hrCount)}`)}`;
	} else {
		line3 = `${indent}${t.bg("userMessageBg", padRight(t.fg("accent", " pi"), width - indent.length))}`;
	}

	// ── Line 4: tool block header ────────────────────────────────────────────
	const toolStyle = t.toolBlockStyle();
	let line4: string;
	if (toolStyle === "ascii-box") {
		const open = t.glyph("toolBracketOpen") || "[";
		const close = t.glyph("toolBracketClose") || "]";
		const toolLabel = `${open}${open} bash ${close}`;
		const topHr = Math.max(0, width - indent.length - toolLabel.length - 2);
		line4 = `${indent}${t.fg("muted", `+${toolLabel}${rep(hr, topHr)}+`)}`;
	} else if (toolStyle === "indent") {
		const gutter = " ".repeat(t.toolGutter());
		const toolDot = t.glyph("toolDots");
		const prefix = "bash · running ";
		const elapsed = " 0.4s";
		const dotsCount = Math.max(0, width - indent.length - t.toolGutter() - prefix.length - elapsed.length);
		line4 = `${indent}${gutter}${t.fg("muted", `${prefix}${rep(toolDot, dotsCount)}${elapsed}`)}`;
	} else {
		// fill style
		line4 = `${indent}${t.bg("toolPendingBg", padRight(t.fg("toolTitle", "  bash"), width - indent.length))}`;
	}

	// ── Line 5: tool result / ok ─────────────────────────────────────────────
	let line5: string;
	if (toolStyle === "ascii-box") {
		const open = t.glyph("toolBracketOpen") || "[";
		const close = t.glyph("toolBracketClose") || "]";
		const pill = t.glyph("successPill");
		const elapsed = " 0.4s ";
		const botLabel = `${open}${open} `;
		const botSuffix = ` ${close} ${hr}${hr} ${elapsed}${hr}${hr}+`;
		const botHr = Math.max(0, width - indent.length - botLabel.length - pill.length - botSuffix.length);
		line5 = `${indent}${t.fg("muted", `+${botLabel}`)}${t.fg("success", pill)}${t.fg("muted", `${rep(hr, botHr)}${botSuffix}`)}`;
	} else if (toolStyle === "indent") {
		const gutter = " ".repeat(t.toolGutter());
		const pill = t.glyph("successPill");
		const elapsed = "  ·  0.4s";
		const hrCount = Math.max(0, width - indent.length - t.toolGutter() - 1 - pill.length - elapsed.length);
		line5 = `${indent}${gutter}${t.fg("muted", rep(hr, hrCount))} ${t.fg("success", pill)}${t.fg("muted", elapsed)}`;
	} else {
		line5 = `${indent}${t.bg("toolSuccessBg", padRight(t.fg("success", "  ✓ bash  ok  0.4s"), width - indent.length))}`;
	}

	// ── Line 6: footer ───────────────────────────────────────────────────────
	const model = "claude-sonnet-4-6";
	const ctx = "18.4%/200k";
	const tokens = ascii ? "in:1.2k out:340" : "↑1.2k ↓340";
	const cost = "$0.012";
	const cwd = "~/atlas";
	const footerParts = [model, ctx, tokens, cost, cwd].join(sep);
	const line6 = `${indent}${t.fg("dim", footerParts)}`;

	return [line1, line2, line3, line4, line5, line6];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the `pi themes` command.
 *
 * @param args  Remaining args after "themes" (e.g. ["editorial"])
 */
export async function runThemesCommand(args: string[]): Promise<void> {
	const subArg = args[0]; // Optional: a theme name to persist

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);

	if (subArg) {
		// ── `pi themes <name>` — persist selection ───────────────────────────
		const available = getAvailableThemesWithPaths();
		const found = available.find((t) => t.name === subArg);
		if (!found) {
			const names = available.map((t) => t.name).join(", ");
			console.error(chalk.red(`Unknown theme "${subArg}". Available: ${names}`));
			process.exitCode = 1;
			return;
		}
		settingsManager.setTheme(subArg);
		console.log(chalk.green(`✓ Theme set to "${subArg}".`));
		console.log(chalk.dim(`  Changes saved to settings.json. Restart pi to apply.`));
		return;
	}

	// ── `pi themes` — list all themes with previews ──────────────────────────
	const available = getAvailableThemesWithPaths();
	const width = Math.min(process.stdout.columns ?? 100, 100);

	console.log(chalk.bold(`\nAvailable themes  (${available.length} total)\n`));

	for (const { name, path: themePath } of available) {
		// Print theme header
		const displayPath = themePath
			? chalk.dim(`  ${themePath.replace(process.env.HOME ?? "", "~")}`)
			: chalk.dim("  (built-in)");
		console.log(`${chalk.bold(name)}${displayPath}`);

		// Print preview lines using that theme's actual glyphs/colors
		try {
			const previewLines = renderPreview(name, width);
			for (const line of previewLines) {
				console.log(line);
			}
		} catch (err) {
			console.log(`  ${chalk.red(`Preview error: ${err}`)}`);
		}

		console.log(); // blank line between themes
	}

	// Footer hint
	const currentTheme = settingsManager.getTheme() ?? "editorial";
	console.log(chalk.dim(`Current theme: ${currentTheme}`));
	console.log(chalk.dim(`To switch: pi themes <name>  (e.g. pi themes editorial)`));
	console.log();
}

/**
 * Top-level dispatcher: detect `args[0] === "themes"` and run.
 * Returns true if the command was handled (so main.ts can early-exit).
 */
export async function handleThemesCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "themes") return false;
	await runThemesCommand(args.slice(1));
	process.exit(process.exitCode ?? 0);
}
