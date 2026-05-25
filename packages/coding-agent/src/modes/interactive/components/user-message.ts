import { Box, Container, Markdown, type MarkdownTheme, Spacer } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { RoleHeaderComponent } from "./role-divider.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message.
 *
 * Branches on `theme.messageStyle()`:
 *  - "fill"    (dark/light): Box with userMessageBg — pixel-identical to pre-Phase-2.
 *  - "rule"    (editorial):  role-label + hr rule header, indented Markdown body.
 *  - "bracket" (brutalist):  --[ user ]-- header via Theme.roleHeader, indented body.
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.buildLayout();
	}

	/** Rebuild layout when the theme changes (called by ui.invalidate()). */
	override invalidate(): void {
		// Rebuild layout so a runtime theme switch is reflected.
		this.buildLayout();
		// Propagate invalidate to the newly-built children.
		super.invalidate();
	}

	private buildLayout(): void {
		this.clear();

		const style = theme.messageStyle();

		if (style === "fill") {
			// ── Legacy behavior: dark / light themes ─────────────────────────
			const contentBox = new Box(1, 1, (content: string) => theme.bg("userMessageBg", content));
			contentBox.addChild(
				new Markdown(this.text, 0, 0, this.markdownTheme, {
					color: (content: string) => theme.fg("userMessageText", content),
				}),
			);
			this.addChild(contentBox);
		} else {
			// ── Rule / Bracket: editorial + brutalist ─────────────────────────
			// role-label header line (YOU ───── or --[ user ]──)
			this.addChild(new RoleHeaderComponent("user"));
			// blank line between header and body
			this.addChild(new Spacer(1));
			// body — Markdown at paddingX=1, no bg fill
			this.addChild(new Markdown(this.text.trim(), 1, 0, this.markdownTheme));
			// trailing blank line for turn separation
			this.addChild(new Spacer(1));
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
