import type { OutreachConfig } from "./config.js";
import type { Lead } from "./leads.js";
import { env } from "../config/env.js";
import { callGroqTool, type GroqToolDef } from "../ai/groqClient.js";

const MESSAGE_TOOL: GroqToolDef = {
  name: "write_message",
  description: "Return the finished message text.",
  parameters: {
    type: "object",
    properties: { message: { type: "string", description: "The message, plain text, no placeholders." } },
    required: ["message"],
  },
};

const REPLY_TOOL: GroqToolDef = {
  name: "write_reply",
  description: "Return a reply to an inbound Facebook message or comment.",
  parameters: {
    type: "object",
    properties: {
      reply: { type: "string", description: "Reply text. Empty string if the message is spam or needs no reply." },
      isHotLead: { type: "boolean", description: "True if they want a website, a quote, or to talk." },
      summary: { type: "string", description: "One-line summary of what they want, for the owner." },
    },
    required: ["reply", "isHotLead", "summary"],
  },
};

export interface InboundReply {
  reply: string;
  isHotLead: boolean;
  summary: string;
}

export function businessContext(cfg: OutreachConfig): string {
  return [
    `Business: ${cfg.BUSINESS_NAME}`,
    cfg.BUSINESS_OWNER_NAME && `Owner (signs messages): ${cfg.BUSINESS_OWNER_NAME}`,
    `Offer: ${cfg.BUSINESS_OFFER}`,
    cfg.BUSINESS_PRICE_HINT && `Pricing you may mention: ${cfg.BUSINESS_PRICE_HINT}`,
    cfg.BUSINESS_PORTFOLIO_URL && `Portfolio: ${cfg.BUSINESS_PORTFOLIO_URL}`,
    cfg.BUSINESS_CONTACT && `How to reach us / book: ${cfg.BUSINESS_CONTACT}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const STYLE_RULES = [
  "Write like a real local person, not a marketer: short, warm, specific, no hype, no emojis spam, no ALL CAPS.",
  "Never invent facts, prices, discounts, deadlines, or past clients. Only use details given to you.",
  "Plain text only — no markdown, no placeholders like [Name].",
].join("\n");

export function buildColdMessagePrompt(lead: Lead, cfg: OutreachConfig): string {
  const facts = [
    `Name: ${lead.name}`,
    lead.niche && `Type of business: ${lead.niche}`,
    lead.city && `City: ${lead.city}`,
    lead.website ? `Current website: ${lead.website}` : "They have no website listed on Google.",
    lead.rating !== undefined && `Google rating: ${lead.rating} (${lead.reviewCount ?? 0} reviews)`,
    lead.notes && `Notes: ${lead.notes}`,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "Write a first-contact Facebook message to this local business offering website services.",
    "Under 80 words. Open with one specific, genuine observation about them (e.g. strong reviews but no site).",
    "Explain the benefit to THEM in one sentence, then a low-pressure question as the call to action.",
    "",
    "Prospect:",
    facts,
    "",
    "Sender:",
    businessContext(cfg),
  ].join("\n");
}

export function buildFollowUpPrompt(lead: Lead, cfg: OutreachConfig): string {
  return [
    `Write follow-up #${lead.followUpCount + 1} to ${lead.name} (${lead.niche || "local business"}, ${lead.city}).`,
    "They haven't replied to an earlier message about getting a website. Under 45 words, friendly, no guilt-tripping.",
    "Add one new reason it could help them, then make it easy to say no.",
    "",
    "Sender:",
    businessContext(cfg),
  ].join("\n");
}

export function buildInboundReplyPrompt(kind: "message" | "comment", fromName: string, text: string, cfg: OutreachConfig): string {
  return [
    `Someone${fromName ? ` named ${fromName}` : ""} sent this ${kind === "comment" ? "public comment on our Facebook post" : "Facebook message to our Page"}:`,
    `"""${text}"""`,
    "",
    "Reply on behalf of the business. Answer what they asked using only the facts below.",
    "If they're interested, ask one qualifying question (what their business does / do they have a site now) and point them to the contact/booking info.",
    kind === "comment" ? "This reply is public: keep it to 1–2 sentences and never discuss specifics of their business publicly." : "Keep it under 70 words.",
    "If it's spam, abuse, or needs no response, return an empty reply.",
    "",
    businessContext(cfg),
  ].join("\n");
}

export function buildPagePostPrompt(cfg: OutreachConfig, recentPosts: string[]): string {
  return [
    "Write one Facebook Page post that attracts local business owners who need a website.",
    "Rotate angles: a quick tip, a common mistake, a before/after idea, a question to the audience, or a soft offer.",
    "60–120 words, end with a clear but low-pressure call to action. At most 2 hashtags.",
    recentPosts.length ? `Do NOT repeat these recent posts:\n${recentPosts.map((p) => `- ${p.slice(0, 140)}`).join("\n")}` : "",
    "",
    businessContext(cfg),
  ].join("\n");
}

async function writeMessage(cfg: OutreachConfig, prompt: string): Promise<string> {
  const res = await callGroqTool<{ message: string }>({
    model: cfg.OUTREACH_MODEL,
    systemPrompt: STYLE_RULES,
    userMessage: prompt,
    tool: MESSAGE_TOOL,
    maxTokens: 600,
  });
  return res.message.trim();
}

const signOff = (cfg: OutreachConfig) => (cfg.BUSINESS_OWNER_NAME ? `\n\n– ${cfg.BUSINESS_OWNER_NAME}, ${cfg.BUSINESS_NAME}` : `\n\n– ${cfg.BUSINESS_NAME}`);

/** Templates used when GROQ_API_KEY isn't set, so the agent still works end to end. */
function fallbackColdMessage(lead: Lead, cfg: OutreachConfig): string {
  const hook = lead.website
    ? `I came across ${lead.name} and had a few ideas to make your site bring in more calls.`
    : `I came across ${lead.name}${lead.rating ? ` and saw your ${lead.rating}★ reviews` : ""}, but couldn't find a website for you.`;
  return `Hi! ${hook} We build ${cfg.BUSINESS_OFFER}. Would you be open to me sending over a free mockup?${signOff(cfg)}`;
}

export async function draftColdMessage(lead: Lead, cfg: OutreachConfig): Promise<string> {
  if (!env.GROQ_API_KEY) return fallbackColdMessage(lead, cfg);
  return writeMessage(cfg, buildColdMessagePrompt(lead, cfg));
}

export async function draftFollowUp(lead: Lead, cfg: OutreachConfig): Promise<string> {
  if (!env.GROQ_API_KEY) {
    return `Hi again! Just bumping this in case it got buried — happy to put together a free website mockup for ${lead.name}, no strings attached. If now's not a good time, no worries at all.${signOff(cfg)}`;
  }
  return writeMessage(cfg, buildFollowUpPrompt(lead, cfg));
}

export async function draftPagePost(cfg: OutreachConfig, recentPosts: string[] = []): Promise<string> {
  if (!env.GROQ_API_KEY) {
    return `Local business owners: if a customer searches for you tonight, what do they find? ${cfg.BUSINESS_NAME} builds ${cfg.BUSINESS_OFFER}. Send us a message and we'll show you what yours could look like.${cfg.BUSINESS_PORTFOLIO_URL ? `\n\n${cfg.BUSINESS_PORTFOLIO_URL}` : ""}`;
  }
  return writeMessage(cfg, buildPagePostPrompt(cfg, recentPosts));
}

export async function draftInboundReply(
  kind: "message" | "comment",
  fromName: string,
  text: string,
  cfg: OutreachConfig,
): Promise<InboundReply> {
  if (!env.GROQ_API_KEY) {
    return {
      reply: `Thanks for reaching out! We'd love to help.${cfg.BUSINESS_CONTACT ? ` The quickest way to get started is ${cfg.BUSINESS_CONTACT}.` : " What kind of business do you run?"}`,
      isHotLead: true,
      summary: text.slice(0, 120),
    };
  }
  const res = await callGroqTool<InboundReply>({
    model: cfg.OUTREACH_MODEL,
    systemPrompt: STYLE_RULES,
    userMessage: buildInboundReplyPrompt(kind, fromName, text, cfg),
    tool: REPLY_TOOL,
    maxTokens: 500,
  });
  return { reply: res.reply.trim(), isHotLead: Boolean(res.isHotLead), summary: res.summary };
}
