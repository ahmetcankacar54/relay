/**
 * Cross-Provider Protocol Translator.
 * Enables seamless interoperability between Anthropic Messages API and OpenAI Chat/Responses API.
 * When Claude accounts are exhausted, requests can seamlessly be fulfilled by Codex/OpenAI accounts,
 * or vice versa.
 */

export interface AnthropicMessageBlock {
  type: string;
  text?: string;
  source?: any;
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: string | any[];
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicMessageBlock[];
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicMessageBlock[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: any[];
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | any[];
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_completion_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: any[];
}

/**
 * Translates an Anthropic /v1/messages request body into an OpenAI Chat Completions payload.
 */
export function translateAnthropicToOpenAI(
  anthropicReq: AnthropicRequest,
  targetModel = "gpt-4o",
): OpenAIRequest {
  const openAIMessages: OpenAIMessage[] = [];

  // 1. Map system prompt
  if (anthropicReq.system) {
    let systemText = "";
    if (typeof anthropicReq.system === "string") {
      systemText = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      systemText = anthropicReq.system
        .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (systemText) {
      openAIMessages.push({ role: "system", content: systemText });
    }
  }

  // 2. Map conversation messages
  for (const msg of anthropicReq.messages ?? []) {
    if (typeof msg.content === "string") {
      openAIMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
      continue;
    }

    if (Array.isArray(msg.content)) {
      let textContent = "";
      const toolCalls: any[] = [];

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          textContent += (textContent ? "\n" : "") + block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        } else if (block.type === "tool_result") {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
          openAIMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: resultText,
          });
        }
      }

      if (textContent || toolCalls.length > 0) {
        const m: OpenAIMessage = {
          role: msg.role === "assistant" ? "assistant" : "user",
          content: textContent,
        };
        if (toolCalls.length > 0) {
          m.tool_calls = toolCalls;
        }
        openAIMessages.push(m);
      }
    }
  }

  // 3. Map tools if present
  let openAITools: any[] | undefined;
  if (Array.isArray(anthropicReq.tools) && anthropicReq.tools.length > 0) {
    openAITools = anthropicReq.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  return {
    model: targetModel,
    messages: openAIMessages,
    max_tokens: anthropicReq.max_tokens,
    temperature: anthropicReq.temperature,
    stream: anthropicReq.stream ?? false,
    tools: openAITools,
  };
}

/**
 * Translates an OpenAI Chat Completion response chunk into Anthropic SSE events.
 */
export function translateOpenAIChunkToAnthropic(
  openAIChunkStr: string,
  messageId: string,
): string[] {
  const events: string[] = [];
  const lines = openAIChunkStr.split("\n");

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const rawData = line.slice(6).trim();
    if (rawData === "[DONE]") {
      events.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        })}\n\n`,
      );
      events.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      continue;
    }

    try {
      const parsed = JSON.parse(rawData);
      const choice = parsed.choices?.[0];
      const delta = choice?.delta;

      if (delta?.content) {
        events.push(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta.content },
          })}\n\n`,
        );
      }
    } catch {
      // Ignore partial chunks
    }
  }

  return events;
}

/**
 * Translates a complete OpenAI JSON response into a complete Anthropic /v1/messages response.
 */
export function translateOpenAIResponseToAnthropic(
  openAIRes: any,
  messageId: string,
): any {
  const choice = openAIRes.choices?.[0];
  const message = choice?.message;
  const content: any[] = [];

  if (message?.content) {
    content.push({ type: "text", text: message.content });
  }

  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {}
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name,
        input: parsedInput,
      });
    }
  }

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model: openAIRes.model ?? "codex-translated",
    content,
    stop_reason:
      choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: openAIRes.usage?.prompt_tokens ?? 0,
      output_tokens: openAIRes.usage?.completion_tokens ?? 0,
      cache_read_input_tokens:
        openAIRes.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cache_creation_input_tokens: 0,
    },
  };
}
