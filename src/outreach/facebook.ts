import { createHmac, timingSafeEqual } from "node:crypto";
import { outreachConfig, type OutreachConfig } from "./config.js";
import { fetchJson } from "../utils/http.js";

/**
 * Thin Meta Graph API client scoped to what a Page is ALLOWED to do:
 * publish to its own feed, read/reply to comments on its own posts, and
 * message people who messaged the Page (or privately reply to someone who
 * commented). The Graph API has no endpoint for cold-messaging strangers —
 * that's by design, and automating it through a personal account breaks
 * Meta's terms and gets accounts banned. Cold outreach is drafted by the
 * agent and sent by you (see `npm run outreach queue`).
 */
export class FacebookPageClient {
  constructor(private readonly cfg: OutreachConfig = outreachConfig) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const qs = new URLSearchParams({ ...params, access_token: this.cfg.FB_PAGE_ACCESS_TOKEN });
    return `${this.cfg.FB_GRAPH_BASE_URL}/${this.cfg.FB_GRAPH_VERSION}/${path}?${qs.toString()}`;
  }

  private post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return fetchJson<T>(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      retries: 1,
    });
  }

  /** Confirms the token works and belongs to the configured Page. */
  async whoAmI(): Promise<{ id: string; name: string }> {
    return fetchJson(this.url("me", { fields: "id,name" }));
  }

  async publishPost(message: string, link?: string): Promise<{ id: string }> {
    return this.post(`${this.cfg.FB_PAGE_ID}/feed`, link ? { message, link } : { message });
  }

  /** Recent Page posts with their comments, for polling when webhooks aren't set up. */
  async recentComments(limit = 10): Promise<FacebookComment[]> {
    const res = await fetchJson<FeedResponse>(
      this.url(`${this.cfg.FB_PAGE_ID}/feed`, {
        fields: "id,message,comments.limit(25){id,message,from,created_time}",
        limit: String(limit),
      }),
    );
    return res.data.flatMap((post) =>
      (post.comments?.data ?? []).map((c) => ({
        id: c.id,
        postId: post.id,
        message: c.message ?? "",
        fromId: c.from?.id ?? "",
        fromName: c.from?.name ?? "",
        createdTime: c.created_time,
      })),
    );
  }

  /** Latest messages per Messenger conversation, newest first — the polling alternative to webhooks. */
  async recentMessages(limit = 15): Promise<FacebookMessage[]> {
    const res = await fetchJson<ConversationsResponse>(
      this.url(`${this.cfg.FB_PAGE_ID}/conversations`, {
        platform: "messenger",
        fields: "id,messages.limit(3){id,message,from,created_time}",
        limit: String(limit),
      }),
    );
    return res.data.flatMap((conv) =>
      (conv.messages?.data ?? []).map((m) => ({
        id: m.id,
        conversationId: conv.id,
        text: m.message ?? "",
        fromId: m.from?.id ?? "",
        fromName: m.from?.name ?? "",
        createdTime: m.created_time,
      })),
    );
  }

  async recentPostMessages(limit = 5): Promise<string[]> {
    const res = await fetchJson<FeedResponse>(this.url(`${this.cfg.FB_PAGE_ID}/posts`, { fields: "message", limit: String(limit) }));
    return res.data.map((p) => p.message ?? "").filter(Boolean);
  }

  async replyToComment(commentId: string, message: string): Promise<{ id: string }> {
    return this.post(`${commentId}/comments`, { message });
  }

  /** Messenger reply to someone who messaged the Page (24h standard messaging window). */
  async sendMessage(psid: string, text: string): Promise<{ message_id: string }> {
    return this.post(`${this.cfg.FB_PAGE_ID}/messages`, {
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message: { text },
    });
  }

  /** One private Messenger reply to a commenter — Meta's sanctioned comment-to-DM path. */
  async privateReply(commentId: string, text: string): Promise<{ message_id: string }> {
    return this.post(`${this.cfg.FB_PAGE_ID}/messages`, {
      recipient: { comment_id: commentId },
      message: { text },
    });
  }
}

export interface FacebookComment {
  id: string;
  postId: string;
  message: string;
  fromId: string;
  fromName: string;
  createdTime: string;
}

export interface FacebookMessage {
  id: string;
  conversationId: string;
  text: string;
  fromId: string;
  fromName: string;
  createdTime: string;
}

interface ConversationsResponse {
  data: {
    id: string;
    messages?: { data: { id: string; message?: string; from?: { id: string; name: string }; created_time: string }[] };
  }[];
}

interface FeedResponse {
  data: {
    id: string;
    message?: string;
    comments?: { data: { id: string; message?: string; from?: { id: string; name: string }; created_time: string }[] };
  }[];
}

/** Validates Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export type InboundEvent =
  | { kind: "message"; id: string; senderId: string; fromName: string; text: string; timestamp: number }
  | { kind: "comment"; commentId: string; postId: string; fromId: string; fromName: string; text: string; timestamp: number };

/**
 * Flattens a Page webhook payload into the events the agent acts on.
 * Drops echoes of the Page's own messages/comments so it never replies to itself.
 */
export function parseWebhookPayload(payload: unknown, pageId: string): InboundEvent[] {
  const events: InboundEvent[] = [];
  const body = payload as WebhookBody;
  if (body?.object !== "page" || !Array.isArray(body.entry)) return events;

  for (const entry of body.entry) {
    for (const m of entry.messaging ?? []) {
      const text = m.message?.text;
      if (!text || m.message?.is_echo || m.sender?.id === pageId) continue;
      events.push({
        kind: "message",
        id: m.message?.mid ?? `${m.sender.id}:${m.timestamp}`,
        senderId: m.sender.id,
        fromName: "",
        text,
        timestamp: m.timestamp ?? Date.now(),
      });
    }
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== "feed" || v?.item !== "comment" || v.verb !== "add") continue;
      if (!v.comment_id || !v.message || v.from?.id === pageId) continue;
      events.push({
        kind: "comment",
        commentId: v.comment_id,
        postId: v.post_id ?? "",
        fromId: v.from?.id ?? "",
        fromName: v.from?.name ?? "",
        text: v.message,
        timestamp: (v.created_time ?? Math.floor(Date.now() / 1000)) * 1000,
      });
    }
  }
  return events;
}

interface WebhookBody {
  object?: string;
  entry?: {
    messaging?: { sender: { id: string }; timestamp?: number; message?: { mid?: string; text?: string; is_echo?: boolean } }[];
    changes?: {
      field: string;
      value?: {
        item?: string;
        verb?: string;
        comment_id?: string;
        post_id?: string;
        message?: string;
        created_time?: number;
        from?: { id: string; name?: string };
      };
    }[];
  }[];
}
