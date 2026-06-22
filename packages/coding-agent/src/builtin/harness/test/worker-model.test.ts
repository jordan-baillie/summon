// workerModel — per-tier worker model with the SUMMON_WORKER_MODEL_<TIER> override.
// node --experimental-strip-types --test test/worker-model.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { workerModel } from "../src/core.ts";

test("workerModel: defaults to the Anthropic tier map", () => {
	assert.equal(workerModel("fast", {}), "claude-haiku-4-5");
	assert.equal(workerModel("standard", {}), "claude-sonnet-4-6");
	assert.equal(workerModel("frontier", {}), "claude-opus-4-8");
});

test("workerModel: SUMMON_WORKER_MODEL_<TIER> overrides only that tier", () => {
	const env = { SUMMON_WORKER_MODEL_FAST: "openrouter/anthropic/claude-haiku-4.5" };
	assert.equal(workerModel("fast", env), "openrouter/anthropic/claude-haiku-4.5", "fast is overridden");
	assert.equal(workerModel("standard", env), "claude-sonnet-4-6", "an unset tier keeps its default");
});
