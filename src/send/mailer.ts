import nodemailer, { type Transporter } from "nodemailer";
import type { Settings } from "../config/settings.js";
import type { Repo } from "../db/repo.js";
import { renderEmail } from "../draft/compose.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("mailer");

export interface MailTransport {
  sendMail(msg: {
    from: string;
    to: string;
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}

export function createTransport(s: Settings): Transporter {
  return nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecure,
    auth: { user: s.smtpUser, pass: s.smtpPass },
  });
}

export function smtpConfigured(s: Settings): boolean {
  return Boolean(s.smtpHost && s.smtpUser && s.smtpPass);
}

export function fromAddress(s: Settings): string {
  const addr = s.fromEmail || s.smtpUser;
  return s.senderName ? `"${s.senderName.replace(/"/g, "")}" <${addr}>` : addr;
}

/** "08-18" → is `now` inside the window, Mon–Fri? */
export function inSendWindow(window: string, now = new Date()): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(window.trim());
  if (!m) return true;
  const h = now.getHours();
  return h >= Number(m[1]) && h < Number(m[2]);
}

export type SendBlock = "no_smtp" | "outside_window" | "daily_cap" | "no_address" | null;

export function sendBlocker(s: Settings, repo: Repo, now = new Date()): SendBlock {
  if (!smtpConfigured(s)) return "no_smtp";
  if (!s.senderAddress) return "no_address";
  if (!inSendWindow(s.sendWindow, now)) return "outside_window";
  if (repo.sentToday() >= s.dailyCap) return "daily_cap";
  return null;
}

/**
 * Sends the next due approved email, if any. One per call — the agent's
 * send tick calls this every ~90s so sends are spaced out like a human's.
 */
export async function sendNextDue(repo: Repo, s: Settings, transport: MailTransport, now = new Date()): Promise<"sent" | "idle" | SendBlock | "failed"> {
  const block = sendBlocker(s, repo, now);
  if (block) return block;

  const [draft] = repo.dueDrafts(1);
  if (!draft) return "idle";
  const lead = repo.getLead(draft.lead_id)!;

  if (!draft.email) {
    repo.updateDraft(draft.id, { status: "failed", error: "Lead has no email address" });
    return "failed";
  }
  if (repo.isSuppressed(draft.email)) {
    repo.cancelRemaining(lead.id);
    repo.log(`Skipped ${lead.name}: ${draft.email} is on the do-not-contact list`, "warn");
    return "idle";
  }

  const prev = draft.step > 0 ? repo.previousMessageId(lead.id, draft.step) : null;
  try {
    const info = await transport.sendMail({
      from: fromAddress(s),
      to: draft.email,
      subject: draft.subject,
      text: renderEmail(draft.body, s, "email"),
      ...(prev?.messageId ? { inReplyTo: prev.messageId, references: prev.messageId } : {}),
      headers: { "List-Unsubscribe": `<mailto:${s.fromEmail || s.smtpUser}?subject=stop>` },
    });
    repo.updateDraft(draft.id, { status: "sent", sent_at: new Date().toISOString().replace("T", " ").slice(0, 19), message_id: info.messageId ?? null, error: null });
    if (draft.step === 0) repo.updateLead(lead.id, { status: "contacted" });
    repo.log(`Sent ${draft.step === 0 ? "email" : `follow-up ${draft.step}`} to ${lead.name} <${draft.email}>`, "success");
    return "sent";
  } catch (err) {
    const msg = (err as Error).message;
    repo.updateDraft(draft.id, { status: "failed", error: msg });
    repo.log(`Failed to send to ${lead.name}: ${msg}`, "error");
    log.error({ err: msg, lead: lead.id }, "send failed");
    return "failed";
  }
}
