import { env } from "../config/env.js";
import { fetchJson } from "../utils/http.js";

export interface GroqToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface GroqChatCompletionResponse {
  choices: { message: { tool_calls?: GroqToolCall[] } }[];
}

export interface CallGroqToolParams {
  model: string;
  systemPrompt?: string;
  userMessage: string;
  tool: GroqToolDef;
  maxTokens?: number;
}

/**
 * Calls Groq's OpenAI-compatible chat completions endpoint, forcing a
 * single tool call, and returns its parsed arguments. Groq's free tier
 * (no payment method required) is what makes this a viable Anthropic
 * replacement — quality/rate-limits are the tradeoff, not cost.
 */
export async function callGroqTool<T>(params: CallGroqToolParams): Promise<T> {
  const messages = [
    ...(params.systemPrompt ? [{ role: "system", content: params.systemPrompt }] : []),
    { role: "user", content: params.userMessage },
  ];

  const body = {
    model: params.model,
    messages,
    tools: [
      {
        type: "function",
        function: { name: params.tool.name, description: params.tool.description, parameters: params.tool.parameters },
      },
    ],
    tool_choice: { type: "function", function: { name: params.tool.name } },
    max_tokens: params.maxTokens ?? 1024,
  };

  const res = await fetchJson<GroqChatCompletionResponse>(`${env.GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify(body),
    timeoutMs: 15_000,
    retries: 1,
  });

  const toolCall = res.choices[0]?.message.tool_calls?.[0];
  if (!toolCall) {
    throw new Error("Groq response did not include a tool call");
  }

  return JSON.parse(toolCall.function.arguments) as T;
}
