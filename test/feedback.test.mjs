import test from "node:test";
import assert from "node:assert/strict";
import { STEPS, checkStep, buildPayload } from "../public/feedback.js";

test("the steps are name, message, wish in that order; only the wish is optional", () => {
  assert.deepEqual(STEPS.map((s) => s.key), ["name", "message", "wish"]);
  assert.deepEqual(STEPS.map((s) => s.required), [true, true, false]);
});

test("checkStep: required, trimmed, length cap", () => {
  const [name, , wish] = STEPS;
  assert.match(checkStep(name, "   "), /填寫/);
  assert.equal(checkStep(name, " 小明 "), "");
  assert.match(checkStep(name, "a".repeat(41)), /最多 40/);
  assert.equal(checkStep(wish, ""), "");
  assert.equal(checkStep(wish, undefined), "");
});

test("buildPayload has the shape the service expects, with an empty honeypot", () => {
  assert.deepEqual(buildPayload("p", { name: "a" }, "https://x/"), { project: "p", answers: { name: "a" }, page: "https://x/", website: "" });
});
