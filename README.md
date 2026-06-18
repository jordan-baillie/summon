<p align="center">
  <img src="assets/aurora-banner.gif" alt="Aurora — the orchestrated coding agent" width="820">
</p>

<h1 align="center">Aurora</h1>

<p align="center"><b>A branded agent harness</b> — a coding agent with a specialised-sub-agent delegation harness built in, and a premium neon TUI. One command: <code>aurora</code>.</p>

---

Aurora is a coding agent with a **specialised-sub-agent delegation harness built in** and a premium
neon TUI — one command, `aurora`.

Aurora gives you a single agent that can **decompose a goal, write metaprompts, and fan the work out
to specialised, tool-restricted, model-tiered sub-agents in parallel** — with output-contract
validation, deterministic verification, a window-budget governor, safety guards, a live multi-agent
dashboard, named team recipes, and an optional warm worker pool. It looks like Aurora out of the box:
a sub-zero gradient `AURORA` wordmark, rounded box tool-cards, bordered messages, breathing gradient
spinner.

> **Cost model:** Aurora drives sub-agents through your existing Claude subscription via OAuth (it
> ejects `ANTHROPIC_API_KEY` so calls don't hit pay-per-token billing). Bring your own authenticated
> login; Aurora adds no separate API key.

---

## Install

```bash
git clone https://github.com/jordan-245/aurora.git
cd aurora
npm install
npm run build
npm link            # puts `aurora` on your PATH

aurora login        # one-time: authenticate (OAuth)
aurora              # start
```

Requires **Node ≥ 22**. Config lives in `~/.aurora/`. Your normal tooling is untouched.

The build is **hermetic and reproducible** — the model catalog
(`packages/ai/src/*.generated.ts`) is committed, so `npm run build` needs no network
and always produces the same output. Maintainers refresh the catalog deliberately with
`npm run refresh-models` (fetches the latest from models.dev), then review and commit the diff.

## What you get

- **The agent** — `aurora`: read / bash / edit / write tools, sessions, a polished interactive TUI.
- **The harness, built in** (zero setup): the `spawn_agent` tool family is auto-loaded —
  - `spawn_agent({ agent, prompt })` — delegate one task to a specialist.
  - `spawn_agents({ tasks: [...] })` — parallel fan-out (adaptive warm-pool for big batches).
  - `run_team({ team, vars })` — named recipes: sequential stages, parallel steps.
  - a live multi-agent **TUI dashboard** (`/harness-drill`, `/harness-web`).
- **The aurora look** — the `aurora` theme is the default; switch anytime with `aurora themes <name>`.

## Specialists (built-in registry)

| agent | tier | tools | output contract |
|---|---|---|---|
| `scout` | fast | read · grep · find · ls | `## findings` + `## confidence` |
| `builder` | standard | read · edit · write · bash · grep · find · ls | `## change-summary` + `## verification` |
| `reviewer` | fast | read · grep · find · ls · bash | `## verdict` + `## claims` + `## could-not-verify` |
| `orchestrator` | frontier | read · grep · find · ls + spawn tools | `## delegated` + `## synthesis` |

A **load-time, fail-closed validator** rejects unsafe shapes (an orchestrator with write/bash; a
worker with any delegation tool; a write-capable bundle scoped into a protected path). Workers are
spawned with a strict `--tools` allowlist, so sub-agents never get delegation tools.

**Add a specialist** = drop an `agent.json` + `SKILL.md` in `packages/coding-agent/src/builtin/harness/agents/<name>/`,
or per-project in `<project>/.pi/agents/`. Teams live alongside in `…/harness/teams/` or
`<project>/.pi/teams/`.

## Safety (trustable headless)
- **Deterministic verify** — `spawn_agent({ verify: "<cmd>" })`; the harness runs the acceptance
  command itself and a failure overrides the agent's own claim.
- **Tool-layer guard** — every write/exec-capable worker blocks destructive bash and writes outside
  the project root / into protected paths.
- **builder→reviewer auto-pairing** — `spawn_agent({ review: true })` runs the reviewer over the git
  diff and fails closed unless it APPROVEs.

## Configuration (all optional)
`AURORA_CODING_AGENT_DIR` (config home, default `~/.aurora`), `AURORA_MODEL` / `AURORA_BIN`,
`HARNESS_AGENTS_DIR` / `HARNESS_TEAMS_DIR`, `HARNESS_POOL_SIZE`. The harness model tiers default to
Claude Opus / Sonnet / Haiku.

## Layout
```
packages/                         the agent engine (tui · ai · agent · coding-agent)
packages/coding-agent/            the `aurora` CLI
  src/builtin/extensions/         built-in, auto-loaded extensions (the harness tools + dashboard)
  src/builtin/harness/            the harness: registry · validator · spawn · governor · pool · teams
  src/modes/interactive/theme/    themes incl. aurora (default) + harness
SPEC.md                           full system specification
NOTICE / LICENSE                  built on Pi (MIT); see below
```

## Built on Pi
Aurora is built on the [Pi coding agent](https://github.com/badlogic/pi-mono) (MIT © Mario Zechner).
See [`NOTICE`](NOTICE) and [`LICENSE`](LICENSE).

## License
MIT — see [LICENSE](LICENSE).
