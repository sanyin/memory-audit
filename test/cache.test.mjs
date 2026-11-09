import test from "node:test";
import assert from "node:assert/strict";
import { cacheKeyFor, readCache, writeCache } from "../src/hook.mjs";
test("stale-but-recent cache is usable for a live session", () => {
  const p = "examples/demo-repeat.jsonl";
  const key = cacheKeyFor(p);
  writeCache(p, key, [{ id: "x" }]);
  assert.equal(readCache(p, "different-key", { allowStaleMs: 0 }), null);
  const stale = readCache(p, "different-key", { allowStaleMs: 30000 });
  assert.deepEqual(stale, [{ id: "x" }]);
});
