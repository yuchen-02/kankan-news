import test from "node:test";
import assert from "node:assert/strict";
import { allowHit } from "../src/visits.ts";

test("allowHit：同一個來源在視窗內只算一次，過了視窗再算", () => {
  const m = new Map<string, number>();
  assert.equal(allowHit(m, "a", 1000, 10_000), true);
  assert.equal(allowHit(m, "a", 5000, 10_000), false);
  assert.equal(allowHit(m, "b", 5000, 10_000), true);
  assert.equal(allowHit(m, "a", 11_000, 10_000), true);
});

test("allowHit：追蹤的來源太多時會清理，不會無限長大", () => {
  const m = new Map<string, number>();
  for (let i = 0; i < 2500; i++) allowHit(m, "ip" + i, 0);
  allowHit(m, "x", 60_000);
  assert.ok(m.size < 2500);
});
