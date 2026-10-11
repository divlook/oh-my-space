import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetPromptQueueForTests,
  assertPromptQueueDrained,
  guardedConfirm,
  guardedMultiselect,
  guardedSelect,
  guardedText,
  isCancel,
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

    for (const [kind, prompt] of [
      ["multiselect", () => guardedMultiselect({ message: "Select", options: [{ value: "api", label: "api" }] })],
      ["confirm", () => guardedConfirm({ message: "Continue?" })],
      ["text", () => guardedText({ message: "Branch name" })],
    ] as const) {
      process.env.OMS_TEST_PROMPT_RESPONSES = JSON.stringify([{ type: "select", default: true }]);
      __resetPromptQueueForTests();
      await assert.rejects(prompt(), new RegExp('select.*"' + kind + '" prompt'));
    }

    process.env.OMS_TEST_PROMPT_RESPONSES = "[]";
    __resetPromptQueueForTests();
    await assert.rejects(guardedText({ message: "Branch name" }), /exhausted.*text/);

    process.env.OMS_TEST_PROMPT_RESPONSES = JSON.stringify([{ type: "select", default: true }]);
    __resetPromptQueueForTests();
    await assert.rejects(
      guardedSelect({ message: "Select", options: [{ value: "api", label: "api" }] }),
      /select default requires.*initialValue/,
    );

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

test("prompt queues preserve typed values, cancellation, and select defaults", async () => {
  const previousMode = process.env.OMS_TEST_MODE;
  const previousResponses = process.env.OMS_TEST_PROMPT_RESPONSES;
  process.env.OMS_TEST_MODE = "1";
  try {
    process.env.OMS_TEST_PROMPT_RESPONSES = JSON.stringify([
      { type: "select", value: "web" },
      { type: "multiselect", values: ["web", "api"] },
      { type: "confirm", value: false },
      { type: "confirm", value: true },
      { type: "text", value: "" },
      { type: "text", value: "work/topic" },
      { type: "select", default: true },
    ]);
    __resetPromptQueueForTests();
    const options = [{ value: "api", label: "api" }, { value: "web", label: "web" }];
    assert.equal(await guardedSelect({ message: "Select", options, initialValue: "api" }), "web");
    assert.deepEqual(await guardedMultiselect({ message: "Select", options }), ["web", "api"]);
    assert.equal(await guardedConfirm({ message: "Continue?" }), false);
    assert.equal(await guardedConfirm({ message: "Continue?" }), true);
    assert.equal(await guardedText({ message: "Branch name" }), "");
    assert.equal(await guardedText({ message: "Branch name" }), "work/topic");
    assert.equal(await guardedSelect({ message: "Select", options, initialValue: "api" }), "api");
    assertPromptQueueDrained();

    process.env.OMS_TEST_PROMPT_RESPONSES = JSON.stringify(Array(4).fill({ type: "cancel" }));
    __resetPromptQueueForTests();
    assert.equal(isCancel(await guardedSelect({ message: "Select", options })), true);
    assert.equal(isCancel(await guardedMultiselect({ message: "Select", options })), true);
    assert.equal(isCancel(await guardedConfirm({ message: "Continue?" })), true);
    assert.equal(isCancel(await guardedText({ message: "Branch name" })), true);
    assertPromptQueueDrained();
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
