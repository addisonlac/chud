import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { getAnthropicClient } from "./anthropicClient.js";
import type { NewsItem, SentimentResult } from "../types/index.js";

const log = childLogger("sentiment");

const SENTIMENT_TOOL = {
  name: "report_sentiment",
  description: "Report the aggregate market sentiment derived from the supplied news articles.",
  input_schema: {
    type: "object" as const,
    properties: {
      score: {
        type: "number",
        description: "Sentiment score from -1 (very bearish) to 1 (very bullish).",
      },
      label: { type: "string", enum: ["bearish", "neutral", "bullish"] },
      summary: { type: "string", description: "One or two sentence justification." },
    },
    required: ["score", "label", "summary"],
  },
};

/**
 * Strategy rule #4 (AI half): runs sentiment analysis over recent crypto
 * news with Claude Sonnet. Tool-use forces structured output instead of
 * parsing free text.
 */
export async function analyzeSentiment(
  news: NewsItem[],
  context: { symbol?: string; tokenName?: string } = {},
): Promise<SentimentResult> {
  if (news.length === 0) {
    return { score: 0, label: "neutral", summary: "No recent news available.", basedOnArticles: 0 };
  }

  const articleList = news
    .slice(0, 15)
    .map((n, i) => `${i + 1}. [${n.source}] ${n.title}${n.description ? ` — ${n.description}` : ""}`)
    .join("\n");

  const focus = context.symbol
    ? `The trade under consideration is $${context.symbol}${context.tokenName ? ` (${context.tokenName})` : ""}, a Solana memecoin. Weigh general crypto/SOL market mood as a proxy risk backdrop for that trade.`
    : "Assess the general crypto/Solana market mood.";

  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: env.SENTIMENT_MODEL,
      max_tokens: 512,
      tools: [SENTIMENT_TOOL],
      tool_choice: { type: "tool", name: "report_sentiment" },
      messages: [
        {
          role: "user",
          content:
            `${focus}\n\nRecent crypto news headlines:\n${articleList}\n\n` +
            "Call report_sentiment with your assessment.",
        },
      ],
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Sentiment model did not return a tool_use block");
    }

    const input = toolUse.input as { score: number; label: SentimentResult["label"]; summary: string };
    return {
      score: clamp(input.score, -1, 1),
      label: input.label,
      summary: input.summary,
      basedOnArticles: news.length,
    };
  } catch (err) {
    log.error({ err: (err as Error).message }, "sentiment analysis failed, defaulting to neutral");
    return { score: 0, label: "neutral", summary: "Sentiment analysis unavailable.", basedOnArticles: news.length };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
