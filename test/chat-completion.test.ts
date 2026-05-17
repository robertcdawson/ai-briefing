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

test("getChatCompletionAssistantText includes safe completion metadata when content is missing", () => {
  assert.throws(
    () =>
      getChatCompletionAssistantText(
        {
          id: "chatcmpl-test",
          object: "chat.completion",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              native_finish_reason: "provider-empty",
              error: {
                message: "provider returned no message",
                code: "empty_choices",
                ignored: { nested: "value" },
              },
              message: { content: "" },
            },
          ],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 0,
            total_tokens: 42,
            ignored_details: { nested: true },
          },
        },
        "ctx",
      ),
    /ctx: missing assistant message content.*"responseKeys":\["choices","id","model","object","usage"\].*"id":"chatcmpl-test".*"model":"test\/model".*"object":"chat.completion".*"choiceCount":1.*"firstChoiceKeys":\["error","finish_reason","message","native_finish_reason"\].*"firstMessageKeys":\["content"\].*"native_finish_reason":"provider-empty".*"choiceError":\{"code":"empty_choices","message":"provider returned no message"\}.*"usage":\{"prompt_tokens":42,"completion_tokens":0,"total_tokens":42\}/s,
  );
});

test("getChatCompletionAssistantText includes safe top-level response errors", () => {
  assert.throws(
    () =>
      getChatCompletionAssistantText(
        {
          error: {
            code: 400,
            message: "Provider rejected response_format",
            status: "bad_request",
            type: "invalid_request_error",
            metadata: {
              raw: "do not include nested provider payloads",
            },
          },
        },
        "ctx",
      ),
    /ctx: missing assistant message content.*"responseKeys":\["error"\].*"choiceCount":0.*"responseError":\{"code":400,"message":"Provider rejected response_format","status":"bad_request","type":"invalid_request_error"\}/s,
  );
});
