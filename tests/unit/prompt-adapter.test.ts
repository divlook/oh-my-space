import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetPromptQueueForTests,
  assertPromptQueueDrained,
  guardedSelect,
  guardedText,
  promptQueueActive,
} from "../../scripts/lib/prompt-adapter.js";

test("prompt queues fail closed on malformed entries, wrong prompt types, and leftovers", async () => {
  const previousMode = process.env.OMS_TEST_MODE;
  const previousResponses = process.env.OMS_TEST_PROMPT_RESPONSES;
  process.env.OMS_TEST_MODE = "1";
  try {
    process.env.OMS_TEST_PROMPT_RESPONSES = "not json";
    __resetPromptQueueForTests();
    await assert.rejects(guardedSelect({ message: "Select", options: [{ value: "api", label: "api" }] }), /not valid JSON/);

    process.env.OMS_TEST_PROMPT_RESPONSES = JSON.stringify([{ type: "text", value: 42 }]);
    __resetPromptQueueForTests();
    await assert.rejects(guardedText({ message: "Branch name" }), /text "value" must be a string/);

    process.env.OMS_TEST_PROMPT_RESPONSES = JSON.stringify([{ type: "confirm", value: true }]);
    __resetPromptQueueForTests();
    await assert.rejects(guardedSelect({ message: "Select", options: [{ value: "api", label: "api" }] }), /confirm.*select.*prompt/);

    process.env.OMS_TEST_PROMPT_RESPONSES = JSON.stringify([
      { type: "select", value: "api" },
      { type: "confirm", value: true },
    ]);
    __resetPromptQueueForTests();
    assert.equal(await guardedSelect({ message: "Select", options: [{ value: "api", label: "api" }] }), "api");
    assert.throws(assertPromptQueueDrained, /unconsumed/);
  } finally {
    __resetPromptQueueForTests();
    if (previousMode === undefined) delete process.env.OMS_TEST_MODE;
    else process.env.OMS_TEST_MODE = previousMode;
    if (previousResponses === undefined) delete process.env.OMS_TEST_PROMPT_RESPONSES;
    else process.env.OMS_TEST_PROMPT_RESPONSES = previousResponses;
  }
});

test("prompt responses are inactive unless test mode is enabled", () => {
  const previousMode = process.env.OMS_TEST_MODE;
  const previousResponses = process.env.OMS_TEST_PROMPT_RESPONSES;
  delete process.env.OMS_TEST_MODE;
  process.env.OMS_TEST_PROMPT_RESPONSES = JSON.stringify([{ type: "select", value: "api" }]);
  __resetPromptQueueForTests();
  try {
    assert.equal(promptQueueActive(), false);
  } finally {
    __resetPromptQueueForTests();
    if (previousMode === undefined) delete process.env.OMS_TEST_MODE;
    else process.env.OMS_TEST_MODE = previousMode;
    if (previousResponses === undefined) delete process.env.OMS_TEST_PROMPT_RESPONSES;
    else process.env.OMS_TEST_PROMPT_RESPONSES = previousResponses;
  }
});
