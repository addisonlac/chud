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

export interface GroqConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface CallGroqToolParams {
  config: GroqConfig;
  systemPrompt?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  tool: GroqToolDef;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Calls Groq's OpenAI-compatible chat completions endpoint, forcing a single
 * tool call, and returns its parsed arguments. Groq's free tier (no payment
 * method required) is plenty for drafting a few hundred emails a day.
 */
export async function callGroqTool<T>(params: CallGroqToolParams): Promise<T> {
  const messages = [...(params.systemPrompt ? [{ role: "system", content: params.systemPrompt }] : []), ...params.messages];

  const body = {
    model: params.config.model,
    messages,
    tools: [
      {
        type: "function",
        function: { name: params.tool.name, description: params.tool.description, parameters: params.tool.parameters },
      },
    ],
    tool_choice: { type: "function", function: { name: params.tool.name } },
    max_tokens: params.maxTokens ?? 1500,
    temperature: params.temperature ?? 0.7,
  };

  const res = await fetchJson<GroqChatCompletionResponse>(`${params.config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${params.config.apiKey}` },
    body: JSON.stringify(body),
    timeoutMs: 45_000,
    retries: 2,
    retryDelayMs: 2000,
  });

  const toolCall = res.choices[0]?.message.tool_calls?.[0];
  if (!toolCall) throw new Error("Groq response did not include a tool call");
  return JSON.parse(toolCall.function.arguments) as T;
}
