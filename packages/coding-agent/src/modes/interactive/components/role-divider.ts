/**
 * role-divider.ts
 *
 * Shared helper for rendering role-label header lines used by the
 * 'rule' and 'bracket' messageStyle variants (editorial + brutalist).
 *
 * Puts the roleHeader logic here so user-message.ts and assistant-message.ts
 * share a single implementation without duplicating code.
 */

import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// ---------------------------------------------------------------------------
// Pure helper — computes the header string given a render width
// ---------------------------------------------------------------------------

/**
 * Build the role-header line string for the given role and terminal width.
 * Returns "" when roleLabelStyle is "none" (legacy themes: dark / light).
 */
export function buildRoleHeader(role: "user" | "assistant", width: number): string {
	const style = theme.roleLabelStyle();

	if (style === "none") return "";

	if (style === "smallcaps") {
		const label = theme.roleLabel(role).toUpperCase();
		const hrChar = theme.glyph("hr") || "─";
		const hrCount = Math.max(0, width - label.length - 1);
		return `${theme.fg("accent", label)} ${theme.fg("muted", hrChar.repeat(hrCount))}`;
	}

	if (style === "bracket") {
		const label = theme.roleLabel(role);
		const hr = theme.glyph("hr") || "-";
		const open = `${hr}${hr}[ ${label} ]`;
		const hrCount = Math.max(0, width - open.length);
		return theme.fg("muted", open + hr.repeat(hrCount));
	}

	return "";
}

// ---------------------------------------------------------------------------
// Component — renders one header line at the given width
// ---------------------------------------------------------------------------

/**
 * A width-aware component that renders the role-label header line.
 * Emits [] when roleLabelStyle is "none" (preserves dark/light compat).
 */
export class RoleHeaderComponent implements Component {
	private role: "user" | "assistant";

	constructor(role: "user" | "assistant") {
		this.role = role;
	}

	invalidate(): void {
		// Stateless — nothing to invalidate
	}

	render(width: number): string[] {
		const line = buildRoleHeader(this.role, width);
		return line ? [line] : [];
	}
}
