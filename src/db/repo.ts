import type { DB } from "./db.js";
import type { Category, DiscoveredLead, Draft, DraftStatus, Lead, LeadStatus } from "../types.js";
import { CATEGORIES } from "../types.js";

const JSON_COLS = ["scores", "socials", "ad_data", "findings"] as const;

/** "https://www.Shop.com/x" → "shop.com". Null for social/link-in-bio hosts. */
export function normalizeDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

function rowToLead(row: Record<string, unknown> | undefined): Lead | null {
  if (!row) return null;
  const out: Record<string, unknown> = { ...row };
  for (const col of JSON_COLS) {
    const v = row[col];
    out[col] = typeof v === "string" ? JSON.parse(v) : null;
  }
  return out as unknown as Lead;
}

export class Repo {
  constructor(readonly db: DB) {}

  // ---------- leads ----------

  /** Stores a discovered lead. Returns its id, or null if it's a duplicate. */
  insertLead(d: DiscoveredLead): number | null {
    const domain = normalizeDomain(d.websiteUrl);
    const pageId = d.adData?.pageId ?? null;
    if (!domain && !pageId) return null;

    const exists = this.db
      .prepare("SELECT id FROM leads WHERE (domain IS NOT NULL AND domain = ?) OR (page_id IS NOT NULL AND page_id = ?)")
      .get(domain, pageId);
    if (exists) return null;

    const res = this.db
      .prepare(
        `INSERT INTO leads (domain, page_id, name, source, niche, website_url, facebook_url, email, ad_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        domain,
        pageId,
        d.name.slice(0, 200),
        d.source,
        d.niche ?? null,
        domain ? (d.websiteUrl?.startsWith("http") ? d.websiteUrl : `https://${domain}`) : null,
        d.facebookUrl ?? null,
        d.email?.toLowerCase() ?? null,
        d.adData ? JSON.stringify(d.adData) : null,
      );
    return Number(res.lastInsertRowid);
  }

  getLead(id: number): Lead | null {
    return rowToLead(this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Record<string, unknown> | undefined);
  }

  getLeadByEmail(email: string): Lead | null {
    return rowToLead(
      this.db.prepare("SELECT * FROM leads WHERE lower(email) = lower(?)").get(email) as Record<string, unknown> | undefined,
    );
  }

  listLeads(opts: { status?: LeadStatus; category?: Category; search?: string; limit?: number; offset?: number } = {}): Lead[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.category) {
      where.push("category = ?");
      args.push(opts.category);
    }
    if (opts.search) {
      where.push("(name LIKE ? OR domain LIKE ? OR email LIKE ?)");
      const q = `%${opts.search}%`;
      args.push(q, q, q);
    }
    const sql = `SELECT * FROM leads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ? OFFSET ?`;
    args.push(opts.limit ?? 100, opts.offset ?? 0);
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => rowToLead(r)!);
  }

  leadsToProcess(limit: number): Lead[] {
    return (this.db.prepare("SELECT * FROM leads WHERE status = 'new' ORDER BY id LIMIT ?").all(limit) as Record<string, unknown>[]).map(
      (r) => rowToLead(r)!,
    );
  }

  updateLead(id: number, patch: Partial<Omit<Lead, "id" | "created_at">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map((k) => {
      const v = (patch as Record<string, unknown>)[k];
      return (JSON_COLS as readonly string[]).includes(k) && v != null ? JSON.stringify(v) : v;
    });
    this.db.prepare(`UPDATE leads SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...vals, id);
  }

  // ---------- drafts ----------

  /** Replaces a lead's unsent drafts with a fresh sequence. */
  saveSequence(
    leadId: number,
    drafts: { step: number; subject: string; body: string; channel: Draft["channel"]; composer: Draft["composer"]; delayDays: number }[],
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM drafts WHERE lead_id = ? AND status IN ('pending','skipped','cancelled','failed')").run(leadId);
      const ins = this.db.prepare(
        "INSERT OR IGNORE INTO drafts (lead_id, step, channel, subject, body, composer, delay_days) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const d of drafts) ins.run(leadId, d.step, d.channel, d.subject, d.body, d.composer, d.delayDays);
    });
    tx();
  }

  getDraft(id: number): Draft | null {
    return (this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Draft | undefined) ?? null;
  }

  draftsForLead(leadId: number): Draft[] {
    return this.db.prepare("SELECT * FROM drafts WHERE lead_id = ? ORDER BY step").all(leadId) as Draft[];
  }

  updateDraft(id: number, patch: Partial<Omit<Draft, "id" | "lead_id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE drafts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((k) => (patch as Record<string, unknown>)[k]), id);
  }

  /**
   * Approves a lead's sequence. Step 0 goes out on the next send tick;
   * follow-ups (if included) go out `delay_days` after the previous step,
   * and only while the lead hasn't replied.
   */
  approveLead(leadId: number, includeFollowups: boolean): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE drafts SET status = 'approved', send_after = datetime('now') WHERE lead_id = ? AND step = 0 AND status = 'pending'")
        .run(leadId);
      this.db
        .prepare(`UPDATE drafts SET status = ? WHERE lead_id = ? AND step > 0 AND status = 'pending'`)
        .run(includeFollowups ? "approved" : "cancelled", leadId);
      this.updateLead(leadId, { status: "approved" });
    });
    tx();
  }

  skipLead(leadId: number): void {
    this.db.prepare("UPDATE drafts SET status = 'skipped' WHERE lead_id = ? AND status IN ('pending','approved')").run(leadId);
    this.updateLead(leadId, { status: "skipped" });
  }

  /** Stops any not-yet-sent steps (used when a lead replies or opts out). */
  cancelRemaining(leadId: number): void {
    this.db.prepare("UPDATE drafts SET status = 'cancelled' WHERE lead_id = ? AND status IN ('pending','approved')").run(leadId);
  }

  /** Approved email drafts whose time has come, oldest first. */
  dueDrafts(limit: number): (Draft & { email: string | null })[] {
    return this.db
      .prepare(
        `SELECT d.*, l.email AS email FROM drafts d JOIN leads l ON l.id = d.lead_id
         WHERE d.status = 'approved' AND d.channel = 'email' AND l.replied_at IS NULL
           AND (
             (d.step = 0 AND d.send_after <= datetime('now'))
             OR (d.step > 0 AND EXISTS (
               SELECT 1 FROM drafts p WHERE p.lead_id = d.lead_id AND p.step = d.step - 1 AND p.status = 'sent'
                 AND datetime(p.sent_at, '+' || d.delay_days || ' days') <= datetime('now')))
           )
         ORDER BY d.step, d.id LIMIT ?`,
      )
      .all(limit) as (Draft & { email: string | null })[];
  }

  /** Message-Id of the previous sent step, so follow-ups thread under it. */
  previousMessageId(leadId: number, step: number): { messageId: string | null; subject: string } | null {
    const row = this.db
      .prepare("SELECT message_id, subject FROM drafts WHERE lead_id = ? AND step = ? AND status = 'sent'")
      .get(leadId, step - 1) as { message_id: string | null; subject: string } | undefined;
    return row ? { messageId: row.message_id, subject: row.subject } : null;
  }

  sentToday(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'sent' AND channel = 'email' AND date(sent_at) = date('now')")
      .get() as { n: number };
    return row.n;
  }

  /** Review queue for one category: leads with a pending first draft, best score first. */
  queue(category: Category): (Lead & { draft: Draft })[] {
    const rows = this.db
      .prepare(
        `SELECT l.*, d.id AS d_id FROM leads l JOIN drafts d ON d.lead_id = l.id AND d.step = 0
         WHERE l.status = 'drafted' AND l.category = ? AND d.status = 'pending'
         ORDER BY CAST(json_extract(l.scores, '$.' || l.category) AS INTEGER) DESC, l.id DESC LIMIT 500`,
      )
      .all(category) as (Record<string, unknown> & { d_id: number })[];
    return rows.map((r) => ({ ...rowToLead(r)!, draft: this.getDraft(r.d_id)! }));
  }

  sentLog(limit = 200): (Draft & { lead_name: string; email: string | null; category: Category | null })[] {
    return this.db
      .prepare(
        `SELECT d.*, l.name AS lead_name, l.email AS email, l.category AS category FROM drafts d JOIN leads l ON l.id = d.lead_id
         WHERE d.status IN ('sent','failed') ORDER BY d.sent_at DESC, d.id DESC LIMIT ?`,
      )
      .all(limit) as (Draft & { lead_name: string; email: string | null; category: Category | null })[];
  }

  // ---------- suppression ----------

  suppress(email: string, reason: string): void {
    this.db.prepare("INSERT OR IGNORE INTO suppression (email, reason) VALUES (lower(?), ?)").run(email, reason);
  }

  isSuppressed(email: string): boolean {
    const domain = email.split("@")[1] ?? "";
    return Boolean(
      this.db.prepare("SELECT 1 FROM suppression WHERE email = lower(?) OR email = lower(?)").get(email, `@${domain}`),
    );
  }

  listSuppressed(): { email: string; reason: string | null; created_at: string }[] {
    return this.db.prepare("SELECT * FROM suppression ORDER BY created_at DESC").all() as {
      email: string;
      reason: string | null;
      created_at: string;
    }[];
  }

  removeSuppressed(email: string): void {
    this.db.prepare("DELETE FROM suppression WHERE email = lower(?)").run(email);
  }

  // ---------- kv / activity ----------

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  log(message: string, level: "info" | "warn" | "error" | "success" = "info"): void {
    this.db.prepare("INSERT INTO activity (level, message) VALUES (?, ?)").run(level, message);
    // keep the feed bounded
    this.db.prepare("DELETE FROM activity WHERE id <= (SELECT MAX(id) - 2000 FROM activity)").run();
  }

  activity(limit = 100): { id: number; ts: string; level: string; message: string }[] {
    return this.db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?").all(limit) as {
      id: number;
      ts: string;
      level: string;
      message: string;
    }[];
  }

  // ---------- stats ----------

  stats() {
    const byStatus = Object.fromEntries(
      (this.db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all() as { status: string; n: number }[]).map(
        (r) => [r.status, r.n],
      ),
    );
    const queues = Object.fromEntries(
      CATEGORIES.map((c) => [
        c,
        (
          this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM leads l JOIN drafts d ON d.lead_id = l.id AND d.step = 0 WHERE l.status = 'drafted' AND l.category = ? AND d.status = 'pending'",
            )
            .get(c) as { n: number }
        ).n,
      ]),
    ) as Record<Category, number>;
    const totalSent = (this.db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'sent'").get() as { n: number }).n;
    const totalLeads = (this.db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    const scheduled = (
      this.db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'approved' AND channel = 'email'").get() as { n: number }
    ).n;
    return { byStatus, queues, totalLeads, totalSent, sentToday: this.sentToday(), scheduled, replied: byStatus.replied ?? 0 };
  }

  setDraftStatusForLead(leadId: number, from: DraftStatus[], to: DraftStatus): void {
    this.db
      .prepare(`UPDATE drafts SET status = ? WHERE lead_id = ? AND status IN (${from.map(() => "?").join(",")})`)
      .run(to, leadId, ...from);
  }
}
