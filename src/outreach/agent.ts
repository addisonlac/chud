import { join } from "node:path";
import { parseTargets, type OutreachConfig } from "./config.js";
import { FacebookPageClient, type FacebookComment, type FacebookMessage, type InboundEvent } from "./facebook.js";
import { LeadStore, type Lead } from "./leads.js";
import { findBusinessesWithoutWebsite } from "./places.js";
import { AgentState } from "./state.js";
import { draftColdMessage, draftFollowUp, draftInboundReply, draftPagePost } from "./writer.js";
import { sendTelegramMessage } from "../notify/telegram.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("outreach");

/** Messenger's standard window: a Page may only reply within 24h of the user's last message. */
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type Notify = (text: string) => Promise<void>;

export function facebookSearchUrl(lead: Lead): string {
  return `https://www.facebook.com/search/pages/?q=${encodeURIComponent(`${lead.name} ${lead.city}`.trim())}`;
}

/**
 * Picks the inbound messages that still need an answer: per conversation,
 * only the newest message, only if the customer (not the Page) sent it, and
 * only while it's still inside the 24h reply window.
 */
export function messagesNeedingReply(messages: FacebookMessage[], pageId: string, now = Date.now()): FacebookMessage[] {
  const newest = new Map<string, FacebookMessage>();
  for (const m of messages) {
    const cur = newest.get(m.conversationId);
    if (!cur || new Date(m.createdTime).getTime() > new Date(cur.createdTime).getTime()) newest.set(m.conversationId, m);
  }
  return [...newest.values()].filter(
    (m) => m.fromId !== pageId && m.text && now - new Date(m.createdTime).getTime() < MESSAGING_WINDOW_MS,
  );
}

export function commentsNeedingReply(comments: FacebookComment[], pageId: string): FacebookComment[] {
  return comments.filter((c) => c.fromId !== pageId && c.message);
}

export function formatQueueMessage(lead: Lead, followUp: boolean): string {
  const where = [lead.niche, lead.city].filter(Boolean).join(", ");
  const header = `${followUp ? `🔁 FOLLOW-UP #${lead.followUpCount + 1}` : "✉️ NEW"}: ${lead.name}${where ? ` (${where})` : ""}`;
  const contact = [`Open: ${lead.facebookUrl ?? facebookSearchUrl(lead)}`, ...(lead.phone ? [`Phone: ${lead.phone}`] : [])];
  return [header, ...contact, "", lead.draft ?? "", "", `When sent: npm run outreach -- sent ${lead.id}`].join("\n");
}

/**
 * The always-on outreach agent. Every tick it answers new Page messages and
 * comments; on its own schedules it finds new prospects, drafts personalized
 * first messages + follow-ups, publishes Page posts, and sends a digest.
 * Every task is isolated so one failing API never stops the others.
 */
export class OutreachAgent {
  readonly leads: LeadStore;
  readonly state: AgentState;
  private readonly fb: FacebookPageClient;
  private readonly facebookEnabled: boolean;
  private running = false;

  constructor(
    private readonly cfg: OutreachConfig,
    private readonly notify: Notify = sendTelegramMessage,
  ) {
    this.leads = new LeadStore(join(cfg.OUTREACH_DATA_DIR, "outreach-leads.json"));
    this.state = new AgentState(join(cfg.OUTREACH_DATA_DIR, "outreach-state.json"));
    this.fb = new FacebookPageClient(cfg);
    this.facebookEnabled = Boolean(cfg.FB_PAGE_ID && cfg.FB_PAGE_ACCESS_TOKEN);
  }

  get facebook(): FacebookPageClient {
    return this.fb;
  }

  /** One pass of everything that's due. Safe to call on any interval. */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return; // previous tick still in flight (slow API) — don't overlap
    this.running = true;
    try {
      if (this.facebookEnabled) await this.task("inbound", () => this.pollInbound());
      if (this.state.isDue("leadSearch", this.cfg.OUTREACH_LEAD_SEARCH_INTERVAL_HOURS, now)) {
        await this.task("leadSearch", () => this.findLeads());
        this.state.markRan("leadSearch", now);
      }
      if (this.state.isDue("drafts", 1, now)) {
        await this.task("drafts", () => this.draftQueue(now));
        this.state.markRan("drafts", now);
      }
      if (this.facebookEnabled && this.state.isDue("pagePost", this.cfg.OUTREACH_POST_INTERVAL_HOURS, now)) {
        await this.task("pagePost", () => this.publishPagePost());
        this.state.markRan("pagePost", now);
      }
      if (this.state.isDue("digest", this.cfg.OUTREACH_DIGEST_INTERVAL_HOURS, now)) {
        await this.task("digest", () => this.sendDigest(now));
        this.state.markRan("digest", now);
      }
    } finally {
      this.leads.save();
      this.state.save();
      this.running = false;
    }
  }

  private async task(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.error({ task: name, err: (err as Error).message }, "outreach task failed — will retry next cycle");
    }
  }

  // --- Inbound: messages + comments on your Page ---

  async pollInbound(): Promise<void> {
    const [messages, comments] = await Promise.all([this.fb.recentMessages(), this.fb.recentComments()]);
    for (const m of messagesNeedingReply(messages, this.cfg.FB_PAGE_ID)) {
      await this.handleInbound({
        kind: "message",
        id: m.id,
        senderId: m.fromId,
        fromName: m.fromName,
        text: m.text,
        timestamp: new Date(m.createdTime).getTime(),
      });
    }
    for (const c of commentsNeedingReply(comments, this.cfg.FB_PAGE_ID)) {
      await this.handleInbound({
        kind: "comment",
        commentId: c.id,
        postId: c.postId,
        fromId: c.fromId,
        fromName: c.fromName,
        text: c.message,
        timestamp: new Date(c.createdTime).getTime(),
      });
    }
  }

  /** Shared by polling and the webhook; dedupes so both can run at once. */
  async handleInbound(event: InboundEvent): Promise<void> {
    const id = event.kind === "message" ? event.id : event.commentId;
    if (this.state.isProcessed(id)) return;
    if (event.timestamp < this.state.startedAt) {
      // Pre-existing history from before the agent's first start, not a new conversation.
      this.state.markProcessed(id);
      return;
    }

    // Draft + send BEFORE marking processed: if Groq or Facebook is down, the
    // item is retried next tick instead of silently going unanswered.
    const { reply, isHotLead, summary } = await draftInboundReply(event.kind, event.fromName, event.text, this.cfg);
    const targetId = event.kind === "message" ? event.senderId : event.commentId;

    if (reply && this.cfg.FB_AUTO_REPLY) {
      await this.sendReply(event.kind, targetId, reply, isHotLead);
    } else if (reply) {
      this.state.addPending({
        id,
        kind: event.kind,
        targetId,
        fromName: event.fromName,
        inboundText: event.text,
        reply,
        isHotLead,
        createdAt: new Date().toISOString(),
      });
    }
    this.state.markProcessed(id);

    if (isHotLead) {
      this.state.stats.hotLeads++;
      if (event.fromName) {
        this.leads.add([{ name: event.fromName, niche: "", city: "", notes: summary, source: "facebook-inbound", status: "replied" }]);
      }
      await this.notify(
        [
          `🔥 HOT LEAD via Facebook ${event.kind}${event.fromName ? ` from ${event.fromName}` : ""}`,
          `They said: ${event.text.slice(0, 300)}`,
          `Wants: ${summary}`,
          reply ? `${this.cfg.FB_AUTO_REPLY ? "Agent replied" : "Draft awaiting approval"}: ${reply}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    this.leads.save();
    this.state.save();
  }

  async sendReply(kind: "message" | "comment", targetId: string, reply: string, isHotLead: boolean): Promise<void> {
    if (kind === "message") {
      await this.fb.sendMessage(targetId, reply);
    } else {
      await this.fb.replyToComment(targetId, reply);
      if (isHotLead && this.cfg.FB_PRIVATE_REPLY_HOT_COMMENTS) {
        // A failed private reply (e.g. commenter blocks messages) shouldn't undo the public one.
        await this.fb
          .privateReply(targetId, `Hi! Thanks for your comment — happy to help with a website. ${this.cfg.BUSINESS_CONTACT ? `You can book a quick chat here: ${this.cfg.BUSINESS_CONTACT}` : "What kind of business do you run?"}`)
          .catch((err: Error) => log.warn({ err: err.message }, "private reply failed"));
      }
    }
    this.state.stats.repliesSent++;
    log.info({ kind, targetId }, "sent reply");
  }

  // --- Prospecting ---

  async findLeads(): Promise<number> {
    const targets = parseTargets(this.cfg.OUTREACH_TARGETS);
    if (!this.cfg.GOOGLE_PLACES_API_KEY || targets.length === 0) return 0;
    const target = targets[this.state.nextTargetIndex(targets.length)]!;
    const found = await findBusinessesWithoutWebsite(this.cfg, target.niche, target.city);
    const added = this.leads.add(found);
    this.state.stats.leadsFound += added;
    log.info({ ...target, found: found.length, added }, "lead search done");
    return added;
  }

  /** Drafts first messages for new leads (up to the daily cap) and follow-ups that are due. */
  async draftQueue(now = new Date()): Promise<number> {
    let drafted = 0;
    const waiting = this.leads.byStatus("drafted").length;
    const room = Math.max(0, this.cfg.OUTREACH_DAILY_LIMIT - waiting - this.leads.sentOn(now));
    for (const lead of this.leads.byStatus("new").slice(0, room)) {
      this.leads.update(lead.id, { draft: await draftColdMessage(lead, this.cfg), status: "drafted" });
      drafted++;
    }
    const due = this.leads.followUpsDue(this.cfg.OUTREACH_FOLLOWUP_DAYS, this.cfg.OUTREACH_MAX_FOLLOWUPS, now);
    for (const lead of due.filter((l) => !l.draft)) {
      this.leads.update(lead.id, { draft: await draftFollowUp(lead, this.cfg) });
      drafted++;
    }
    return drafted;
  }

  /** Leads with a ready-to-send message: new first-contacts, then follow-ups. */
  sendQueue(): { lead: Lead; followUp: boolean }[] {
    return [
      ...this.leads.byStatus("drafted").map((lead) => ({ lead, followUp: false })),
      ...this.leads.byStatus("sent").filter((l) => l.draft).map((lead) => ({ lead, followUp: true })),
    ];
  }

  // --- Page content ---

  async publishPagePost(): Promise<string> {
    const recent = await this.fb.recentPostMessages().catch(() => []);
    const message = await draftPagePost(this.cfg, recent);
    const { id } = await this.fb.publishPost(message, this.cfg.BUSINESS_PORTFOLIO_URL || undefined);
    this.state.stats.postsPublished++;
    log.info({ postId: id }, "published Page post");
    return id;
  }

  // --- Reporting ---

  async sendDigest(now = new Date()): Promise<void> {
    const s = this.state.stats;
    const queue = this.sendQueue().slice(0, this.cfg.OUTREACH_DAILY_LIMIT);
    await this.notify(
      [
        `📊 Outreach digest — ${now.toISOString().slice(0, 10)}`,
        `Replies sent: ${s.repliesSent} | Hot leads: ${s.hotLeads} | Posts: ${s.postsPublished} | Prospects found: ${s.leadsFound}`,
        `Pipeline: ${this.leads.byStatus("sent").length} contacted, ${this.leads.byStatus("replied").length} replied, ${this.leads.byStatus("won").length} won`,
        this.state.pending().length ? `⏳ ${this.state.pending().length} replies awaiting approval (npm run outreach -- inbox)` : "",
        queue.length ? `\n${queue.length} personalized DMs ready to send — they follow below.` : "No DMs queued today.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    for (const { lead, followUp } of queue) await this.notify(formatQueueMessage(lead, followUp));
  }
}
