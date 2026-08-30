import assert from "node:assert/strict";
import test from "node:test";

import {
  afterPrimaryProbe,
  afterRequest,
  type BackendCircuitState,
} from "./tts-backend-state.ts";

test("opens the circuit only after three consecutive primary failures", () => {
  let state: BackendCircuitState = {
    active: "gpu",
    consecutiveProbeFails: 0,
  };

  state = afterPrimaryProbe(state, false);
  assert.deepEqual(state, { active: "gpu", consecutiveProbeFails: 1 });

  state = afterPrimaryProbe(state, false);
  assert.deepEqual(state, { active: "gpu", consecutiveProbeFails: 2 });

  state = afterPrimaryProbe(state, false);
  assert.deepEqual(state, { active: "cpu", consecutiveProbeFails: 3 });
});

test("a successful primary probe closes the circuit", () => {
  const state = afterPrimaryProbe(
    { active: "cpu", consecutiveProbeFails: 7 },
    true,
  );

  assert.deepEqual(state, { active: "gpu", consecutiveProbeFails: 0 });
});

test("request failures do not alter probe-owned circuit state", () => {
  const state = afterRequest({ active: "gpu", consecutiveProbeFails: 2 });

  assert.deepEqual(state, { active: "gpu", consecutiveProbeFails: 2 });
});
