import test from "node:test";
import assert from "node:assert/strict";
import {
  translateAnthropicToOpenAI,
  translateOpenAIChunkToAnthropic,
  translateOpenAIResponseToAnthropic,
} from "../electron/core/proxy/protocol-translator";

test("translateAnthropicToOpenAI maps system prompt, text, and tools", () => {
  const anthropicReq = {
    model: "claude-3-5-sonnet",
    system: "You are a helpful coding assistant.",
    messages: [
      { role: "user" as const, content: "Hello world" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use",
            id: "call_123",
            name: "read_file",
            input: { path: "main.ts" },
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_123",
            content: "file content here",
          },
        ],
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file from disk",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ],
    max_tokens: 1024,
  };

  const openAIReq = translateAnthropicToOpenAI(anthropicReq, "gpt-4o");

  assert.equal(openAIReq.model, "gpt-4o");
  assert.equal(openAIReq.messages[0].role, "system");
  assert.equal(openAIReq.messages[0].content, "You are a helpful coding assistant.");

  assert.equal(openAIReq.messages[1].role, "user");
  assert.equal(openAIReq.messages[1].content, "Hello world");

  assert.equal(openAIReq.messages[2].role, "assistant");
  assert.equal(openAIReq.messages[2].tool_calls?.[0].id, "call_123");
  assert.equal(openAIReq.messages[2].tool_calls?.[0].function.name, "read_file");

  assert.equal(openAIReq.messages[3].role, "tool");
  assert.equal(openAIReq.messages[3].tool_call_id, "call_123");
  assert.equal(openAIReq.messages[3].content, "file content here");

  assert.equal(openAIReq.tools?.[0].type, "function");
  assert.equal(openAIReq.tools?.[0].function.name, "read_file");
});

test("translateOpenAIChunkToAnthropic converts SSE chunks to Anthropic text deltas", () => {
  const openaiSse = `data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n`;
  const events = translateOpenAIChunkToAnthropic(openaiSse, "msg-test");

  assert.equal(events.length, 3);
  assert.ok(events[0].includes("content_block_delta"));
  assert.ok(events[0].includes('"text":"Hello"'));
  assert.ok(events[1].includes("message_delta"));
  assert.ok(events[2].includes("message_stop"));
});

test("translateOpenAIResponseToAnthropic converts full completion", () => {
  const openAiRes = {
    id: "cmpl-99",
    model: "gpt-4o",
    choices: [
      {
        message: { role: "assistant", content: "Completed code" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 20,
    },
  };

  const anthropicRes = translateOpenAIResponseToAnthropic(openAiRes, "msg-123");
  assert.equal(anthropicRes.id, "msg-123");
  assert.equal(anthropicRes.role, "assistant");
  assert.equal(anthropicRes.content[0].text, "Completed code");
  assert.equal(anthropicRes.usage.input_tokens, 50);
  assert.equal(anthropicRes.usage.output_tokens, 20);
});
