import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateCost,
  priceKey,
  responseCost,
} from "../shared/model-prices";

const M = 1_000_000;
const near = (actual: number | undefined, expected: number) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-9,
    `${actual} ≠ ${expected}`,
  );
const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

test("model ids are matched with a trailing date or bracket suffix dropped", () => {
  assert.equal(priceKey("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(priceKey("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(priceKey("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(priceKey("claude-3-5-haiku-20241022"), "claude-3-5-haiku");
  assert.equal(priceKey("gpt-5"), undefined);
  assert.equal(priceKey("toString"), undefined);
  assert.equal(responseCost("unknown", { ...zero, input: M }), undefined);
});

test("each kind of token at its own rate", () => {
  near(responseCost("claude-opus-5-5", { ...zero, input: M }), 4);
  near(responseCost("claude-opus-5-5", { ...zero, output: M }), 20);
  near(responseCost("claude-opus-5-5", { ...zero, cacheRead: M }), 0.2);
  near(responseCost("claude-sonnet-5-5", { ...zero, cacheRead: M }), 0.1);
  near(responseCost("claude-fable-5-1", { ...zero, cacheRead: M }), 0.25);
  near(responseCost("claude-fable-5", { ...zero, cacheRead: M }), 1);
});

test("cache writes are 5-minute unless the row says 1-hour", () => {
  near(responseCost("claude-opus-5-5", { ...zero, cacheWrite: M }), 5);
  near(
    responseCost("claude-opus-5-5", { ...zero, cacheWrite: M, cacheWrite1h: M }),
    8,
  );
  near(
    responseCost("claude-opus-5-5", {
      ...zero,
      cacheWrite: 2 * M,
      cacheWrite1h: M,
    }),
    13,
  );
  // A split larger than the total never prices more than the total.
  near(
    responseCost("claude-opus-5-5", { ...zero, cacheWrite: M, cacheWrite1h: 5 * M }),
    8,
  );
});

test("fast mode doubles Opus 5.5 and scales its cache rates", () => {
  const usage = { input: M, output: M, cacheWrite: M, cacheWrite1h: M, cacheRead: M };
  near(responseCost("claude-opus-5-5", { ...usage, speed: "fast" }), 8 + 40 + 16 + 0.4);
  near(responseCost("claude-opus-4-8", { ...zero, output: M, speed: "fast" }), 50);
  // A model with no fast mode keeps its rates.
  near(responseCost("claude-sonnet-5-5", { ...zero, output: M, speed: "fast" }), 10);
});

test("US inference costs 1.1× on 4.6 and later models only", () => {
  near(responseCost("claude-opus-5-5", { ...zero, input: M, geo: "us" }), 4.4);
  near(responseCost("claude-opus-5-5", { ...zero, input: M, geo: "global" }), 4);
  near(responseCost("claude-haiku-4-5", { ...zero, input: M, geo: "us" }), 1);
});

test("Haiku 5.5 prices a prompt over 100,000 tokens at the higher tier", () => {
  near(
    responseCost("claude-haiku-5-5", { ...zero, input: 50_000, cacheRead: 50_000, output: M }),
    (50_000 * 0.1 + 50_000 * 0.01) / M + 0.5,
  );
  near(
    responseCost("claude-haiku-5-5", { ...zero, input: 50_000, cacheRead: 50_001, output: M }),
    (50_000 * 0.5 + 50_001 * 0.05) / M + 2.5,
  );
});

test("an estimate prices every cache write as 1-hour", () => {
  near(
    estimateCost("claude-opus-5-5", { input: M, output: M, cacheWrite: M, cacheRead: M }),
    4 + 20 + 8 + 0.2,
  );
  near(
    estimateCost("claude-haiku-5-5", { input: M, output: 0, cacheWrite: 0, cacheRead: 0 }),
    0.1,
  );
  assert.equal(estimateCost("mystery", zero), undefined);
});
