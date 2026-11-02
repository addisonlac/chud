import { callGroqTool } from "../ai/groqClient.js";
import type { Settings } from "../config/settings.js";
import type { Category, DraftChannel, Finding } from "../types.js";
import { CATEGORY_LABELS } from "../types.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("compose");

export interface ComposeContext {
  businessName: string;
  firstName: string | null;
  domain: string | null;
  category: Category;
  findings: Finding[]; // worst first, already filtered to the category
  channel: DraftChannel;
  settings: Settings;
}

export interface ComposedStep {
  step: number;
  subject: string;
  body: string;
  delayDays: number;
}

export interface ComposedSequence {
  composer: "ai" | "template";
  steps: ComposedStep[];
}

export const MAX_FIRST_EMAIL_WORDS = 170;
export const MAX_FOLLOWUP_WORDS = 90;

export function offerFor(category: Category, s: Settings): string {
  return category === "website" ? s.offerWebsite : category === "ads" ? s.offerAds : s.offerCro;
}

export function greeting(ctx: Pick<ComposeContext, "firstName" | "businessName">): string {
  return ctx.firstName ? `Hi ${ctx.firstName},` : `Hi ${ctx.businessName} team,`;
}

function ctaLine(ctx: ComposeContext): string {
  const where = ctx.domain ?? "your setup";
  const s = ctx.settings;
  return s.bookingUrl
    ? `If it's useful, I can record a free 2-minute video walking through exactly what I'd change on ${where} — or you can grab a time that suits you here: ${s.bookingUrl}. Want me to send the video over?`
    : `If it's useful, I can record a free 2-minute video walking through exactly what I'd change on ${where}. Want me to send it over?`;
}

/** Signature appended to every message (not part of the editable body). */
export function signature(s: Settings): string {
  const line2 = [s.senderTitle, s.senderCompany].filter(Boolean).join(", ");
  const line3 = [s.senderPhone, s.senderWebsite].filter(Boolean).join(" · ");
  return [s.senderName, line2, line3].filter(Boolean).join("\n");
}

/** CAN-SPAM footer: who we are, where we are, and how to opt out. */
export function complianceFooter(s: Settings): string {
  const who = [s.senderCompany || s.senderName, s.senderAddress].filter(Boolean).join(" · ");
  return `—\n${who}\nNot interested? Just reply "stop" and I won't email you again.`;
}

/** The full text that actually gets sent. */
export function renderEmail(body: string, s: Settings, channel: DraftChannel = "email"): string {
  const parts = [body.trim(), signature(s)];
  if (channel === "email") parts.push(complianceFooter(s));
  return parts.filter(Boolean).join("\n\n");
}

const SUBJECTS: Record<string, (c: ComposeContext, f: Finding) => string> = {
  no_https: (c) => `Chrome is warning visitors away from ${c.domain}`,
  no_mobile: (c) => `${c.businessName}'s website on a phone`,
  old_copyright: (c, f) => `${c.businessName}'s website (still says ${f.evidence})`,
  old_wordpress: (c) => `${c.businessName}'s site is running old WordPress`,
  flash: (c) => `Part of ${c.businessName}'s site is blank for visitors`,
  no_contact_path: (c) => `Making it easier to contact ${c.businessName}`,
  slow_mobile: (c, f) => (f.evidence.endsWith("s") ? `${c.businessName} takes ${f.evidence} to load on mobile` : `${c.businessName}'s mobile speed score`),
  vintage_theme: (c) => `Quick win for ${c.businessName}'s Shopify store`,
  app_bloat: (c, f) => `${f.evidence} slowing down ${c.businessName}`,
  no_reviews: (c) => `Reviews on ${c.businessName}'s product pages`,
  no_email_capture: (c) => `The visitors ${c.businessName} never hears from again`,
  stale_catalog: (c) => `Idea for ${c.businessName}'s homepage`,
  ads_no_website: () => `Your ads have nowhere to send customers`,
  ads_dead_landing: (c) => `Your ads are pointing to a page that won't load`,
  ads_no_pixel: (c) => `${c.businessName}'s Meta ads are flying blind`,
  ads_creative_fatigue: (_c, f) => `Your top ad has been running ${f.evidence}`,
  ads_single_creative: (c) => `Testing ${c.businessName}'s Facebook ads`,
  ads_slow_landing: (c) => `Where ${c.businessName}'s ad clicks are going`,
  no_meta_pixel_store: (c) => `Retargeting for ${c.businessName}`,
};

/** How a follow-up refers back to the main problem ("the missing Meta pixel on x.com"). */
const TOPICS: Record<string, string> = {
  no_https: 'the "Not secure" warning',
  no_mobile: "the mobile layout",
  old_copyright: "the outdated site",
  old_wordpress: "the old WordPress install",
  old_jquery: "the outdated code",
  flash: "the broken Flash sections",
  template_builder: "the template site",
  no_meta_description: "the missing search descriptions",
  no_contact_path: "the missing contact options",
  slow_mobile: "the slow mobile load time",
  vintage_theme: "the outdated theme",
  app_bloat: "the app bloat",
  no_reviews: "the missing reviews",
  no_email_capture: "the missing email signup",
  stale_catalog: "the homepage merchandising",
  ads_no_website: "the ads with no website behind them",
  ads_dead_landing: "the broken landing page",
  ads_no_pixel: "the missing Meta pixel",
  ads_creative_fatigue: "the tired ad creative",
  ads_single_creative: "the single-ad setup",
  ads_slow_landing: "the slow landing page",
  no_meta_pixel_store: "the missing Meta pixel",
};

export function topicOf(f: Finding): string {
  return TOPICS[f.id] ?? `the ${f.evidence} issue`;
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** Deterministic writer — used when there's no Groq key or the AI draft fails validation. */
export function templateSequence(ctx: ComposeContext): ComposedSequence {
  const [f1, f2, f3] = ctx.findings;
  if (!f1) throw new Error("templateSequence needs at least one finding");
  const where = ctx.domain ? ctx.domain : "your Facebook and Instagram ads";
  const costs = ctx.category === "website" ? "customers" : "sales";

  const subject = (SUBJECTS[f1.id] ?? ((c: ComposeContext) => `${CATEGORY_LABELS[c.category]} idea for ${c.businessName}`))(ctx, f1);

  const pains = [f1, f2].filter((f): f is Finding => Boolean(f));
  const intro =
    pains.length > 1
      ? `I was looking at ${where} and noticed a couple of things that are probably costing you ${costs}:`
      : `I was looking at ${where} and noticed something that's probably costing you ${costs}:`;

  const body1 = [
    greeting(ctx),
    intro + "\n\n" + pains.map((f) => `• ${f.pain}`).join("\n"),
    `What I'd do:\n` + pains.map((f) => `• ${f.fix}`).join("\n"),
    ctx.settings.senderProof ? ctx.settings.senderProof.trim() : "",
    ctaLine(ctx),
  ]
    .filter(Boolean)
    .join("\n\n");

  const [d1 = 3, d2 = 4] = ctx.settings.followupDays;
  const restate = `${topicOf(f1)}${ctx.domain && f1.id !== "ads_no_website" ? ` on ${ctx.domain}` : ""}`;
  const followup1 = [
    greeting(ctx),
    `Just bringing this back to the top of your inbox — ${restate} is usually a quick fix, and it keeps costing ${costs} every day it's left.`,
    f3 ? `One more thing I spotted: ${lowerFirst(f3.pain)}` : offerFor(ctx.category, ctx.settings),
    `Happy to send that free video walkthrough — just reply "yes" and I'll put it together.`,
  ].join("\n\n");

  const followup2 = [
    greeting(ctx),
    `I don't want to crowd your inbox, so this is my last note. If fixing ${restate} becomes a priority, just reply and I'll send the walkthrough over — no strings attached.`,
    `Either way, best of luck with ${ctx.businessName}.`,
  ].join("\n\n");

  const steps: ComposedStep[] = [{ step: 0, subject, body: body1, delayDays: 0 }];
  if (ctx.channel === "email") {
    steps.push({ step: 1, subject: `Re: ${subject}`, body: followup1, delayDays: d1 });
    steps.push({ step: 2, subject: `Re: ${subject}`, body: followup2, delayDays: d2 });
  }
  return { composer: "template", steps };
}

// ---------------------------------------------------------------- validation

const PLACEHOLDER_RE = /[{}[\]<>]|\bTBD\b|\blorem\b|\bX{2,}\b|\byour name\b|\bfirst ?name\b|\bcompany name\b|\binsert\b/i;
const BANNED = ["hope this email finds you well", "hope this finds you well", "guarantee", "i came across your business", "dear sir", "to whom it may concern"];

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
}

/** Everything a draft is allowed to cite. A number not in here was invented. */
export function allowedText(ctx: ComposeContext): string {
  const s = ctx.settings;
  return [
    ctx.businessName,
    ctx.domain ?? "",
    ...ctx.findings.flatMap((f) => [f.pain, f.fix, f.evidence]),
    offerFor(ctx.category, s),
    s.senderProof,
    s.bookingUrl,
    s.senderCompany,
    s.senderWebsite,
    ctaLine(ctx),
    "24/7 365", // harmless everyday numbers
  ].join(" \n ");
}

export function validateMessage(text: string, ctx: ComposeContext, opts: { maxWords: number; requireEvidence: boolean }): string[] {
  const errors: string[] = [];
  if (!text.trim()) return ["message is empty"];
  const ph = PLACEHOLDER_RE.exec(text);
  if (ph) errors.push(`contains a placeholder or bracket ("${ph[0]}") — write the final text`);
  const lower = text.toLowerCase();
  for (const b of BANNED) if (lower.includes(b)) errors.push(`remove the phrase "${b}"`);
  const n = words(text);
  if (n > opts.maxWords) errors.push(`too long (${n} words, max ${opts.maxWords})`);

  const allowedNums = new Set(numbersIn(allowedText(ctx)));
  const invented = numbersIn(text).filter((x) => !allowedNums.has(x));
  if (invented.length) errors.push(`uses numbers that aren't in the audit facts (${[...new Set(invented)].join(", ")}) — only use numbers given`);

  if (opts.requireEvidence && !ctx.findings.some((f) => lower.includes(f.evidence.toLowerCase()))) {
    errors.push(`must quote at least one finding's evidence exactly (one of: ${ctx.findings.map((f) => `"${f.evidence}"`).join(", ")})`);
  }
  const g = greeting(ctx);
  if (!text.trim().startsWith(g)) errors.push(`must start with exactly "${g}"`);
  if (/\n\s*(best|cheers|thanks|regards|sincerely)[^\n]{0,20}\n\s*\S+\s*$/i.test(text.trim()) || (ctx.settings.senderName && text.trim().endsWith(ctx.settings.senderName))) {
    errors.push("do not sign off or add a signature — it is appended automatically");
  }
  return errors;
}

// ---------------------------------------------------------------- AI writer

interface AiOutput {
  subject: string;
  email: string;
  followup1: string;
  followup2: string;
}

const SYSTEM_PROMPT = `You write short, warm, highly specific cold emails for a small agency, to owners of small businesses and Shopify stores.
Structure of the first email:
1) The exact greeting given.
2) The PAIN: name 1–2 specific problems we observed on their site/ads (from the facts given), in plain English, and what it's costing them (lost customers/sales). Quote at least one "evidence" value exactly.
3) The RELIEF: what we would do about it, concretely, and the outcome for them — based on the fixes and the offer given.
4) The proof line, verbatim, if one is given (never invent results, clients or statistics).
5) One low-friction call to action ending in a question (use the CTA given).
Rules: plain text, no markdown, no bullet symbols other than "• ", no links except the booking link if given, no placeholders or brackets, no sign-off or signature (added automatically), no compliments you can't back up, never use a number that isn't in the facts, sound like a helpful human not a marketer. First email max ${MAX_FIRST_EMAIL_WORDS - 20} words.
Follow-up 1 (sent ~3 days later, same thread): start with the same greeting, add one NEW angle (another finding or the outcome), restate the free offer, max ${MAX_FOLLOWUP_WORDS - 20} words.
Follow-up 2 (final, polite break-up): start with the same greeting, short, make it easy to reply later, max 60 words.
Subject: under 8 words, specific to their business/problem, no clickbait, no emojis.`;

export async function aiSequence(ctx: ComposeContext): Promise<ComposedSequence | null> {
  const s = ctx.settings;
  if (!s.groqApiKey) return null;

  const facts = {
    business_name: ctx.businessName,
    website: ctx.domain ?? "(no website — they only have social pages)",
    contact_channel: ctx.channel === "email" ? "email" : "Facebook/Instagram DM (keep it shorter)",
    greeting_to_use: greeting(ctx),
    queue: CATEGORY_LABELS[ctx.category],
    observed_problems: ctx.findings.map((f) => ({ evidence: f.evidence, problem: f.pain, our_fix: f.fix, severity: f.severity })),
    our_offer: offerFor(ctx.category, s),
    proof_line_verbatim: s.senderProof || null,
    call_to_action: ctaLine(ctx),
    sender_company: s.senderCompany || null,
  };

  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: `Write the outreach sequence from these facts (use nothing else):\n${JSON.stringify(facts, null, 2)}` },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    let out: AiOutput;
    try {
      out = await callGroqTool<AiOutput>({
        config: { apiKey: s.groqApiKey, baseUrl: s.groqBaseUrl, model: s.groqModel },
        systemPrompt: SYSTEM_PROMPT,
        messages,
        tool: {
          name: "write_outreach_sequence",
          description: "Return the finished subject line, first email and two follow-ups.",
          parameters: {
            type: "object",
            properties: {
              subject: { type: "string" },
              email: { type: "string", description: "First email body, from greeting through the call to action. No signature." },
              followup1: { type: "string" },
              followup2: { type: "string" },
            },
            required: ["subject", "email", "followup1", "followup2"],
          },
        },
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, "Groq call failed — falling back to template");
      return null;
    }

    const errors = [
      ...validateMessage(out.subject ?? "", { ...ctx, findings: ctx.findings }, { maxWords: 12, requireEvidence: false }).filter(
        (e) => !e.startsWith("must start with") && !e.startsWith("do not sign"),
      ).map((e) => `subject: ${e}`),
      ...validateMessage(out.email ?? "", ctx, { maxWords: MAX_FIRST_EMAIL_WORDS, requireEvidence: true }).map((e) => `email: ${e}`),
      ...validateMessage(out.followup1 ?? "", ctx, { maxWords: MAX_FOLLOWUP_WORDS, requireEvidence: false }).map((e) => `followup1: ${e}`),
      ...validateMessage(out.followup2 ?? "", ctx, { maxWords: MAX_FOLLOWUP_WORDS, requireEvidence: false }).map((e) => `followup2: ${e}`),
    ];
    if (s.senderProof && !out.email.includes(s.senderProof.trim().slice(0, 40))) {
      errors.push("email: include the proof line verbatim");
    }

    if (!errors.length) {
      const [d1 = 3, d2 = 4] = s.followupDays;
      const subject = out.subject.trim().replace(/^["']|["']$/g, "");
      const steps: ComposedStep[] = [{ step: 0, subject, body: out.email.trim(), delayDays: 0 }];
      if (ctx.channel === "email") {
        steps.push({ step: 1, subject: `Re: ${subject}`, body: out.followup1.trim(), delayDays: d1 });
        steps.push({ step: 2, subject: `Re: ${subject}`, body: out.followup2.trim(), delayDays: d2 });
      }
      return { composer: "ai", steps };
    }

    log.debug({ attempt, errors }, "AI draft failed validation — asking for a rewrite");
    messages.push({ role: "assistant", content: JSON.stringify(out) });
    messages.push({ role: "user", content: `Rewrite to fix these problems, keeping everything else:\n- ${errors.join("\n- ")}` });
  }
  return null;
}

/** AI first (if configured), validated; deterministic template otherwise. */
export async function composeSequence(ctx: ComposeContext): Promise<ComposedSequence> {
  return (await aiSequence(ctx)) ?? templateSequence(ctx);
}
