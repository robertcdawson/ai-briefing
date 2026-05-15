import assert from "node:assert/strict";
import test from "node:test";
import { getChatCompletionAssistantText } from "../src/util.js";

test("getChatCompletionAssistantText returns first assistant message", () => {
  assert.equal(
    getChatCompletionAssistantText(
      { choices: [{ finish_reason: "stop", message: { content: '{"a":1}' } }] },
      "test",
    ),
    '{"a":1}',
  );
});

test("getChatCompletionAssistantText trims whitespace", () => {
  assert.equal(
    getChatCompletionAssistantText(
      { choices: [{ message: { content: "  {\"a\":1}  " } }] },
      "test",
    ),
    '{"a":1}',
  );
});

test("getChatCompletionAssistantText throws when choices is undefined", () => {
  assert.throws(
    () => getChatCompletionAssistantText({}, "ctx"),
    /ctx: missing assistant message content.*"choiceCount":0/s,
  );
});

test("getChatCompletionAssistantText throws when choices is empty", () => {
  assert.throws(
    () => getChatCompletionAssistantText({ choices: [] }, "ctx"),
    /"choiceCount":0/s,
  );
});
