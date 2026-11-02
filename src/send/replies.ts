import { ImapFlow } from "imapflow";
import type { Settings } from "../config/settings.js";
import type { Repo } from "../db/repo.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("replies");

const STOP_RE = /^\s*(stop|unsubscribe|remove me|remove|opt out|not interested)\b/i;

export function isOptOut(text: string): boolean {
  return STOP_RE.test(text) || /\b(unsubscribe|remove me from|stop emailing|take me off)\b/i.test(text.slice(0, 400));
}

/**
 * Scans the inbox for messages from leads we've emailed. A reply stops the
 * sequence (no more follow-ups) and moves the lead to "Replied"; an opt-out
 * reply also adds them to the do-not-contact list.
 */
export async function checkReplies(repo: Repo, s: Settings): Promise<number> {
  const user = s.imapUser || s.smtpUser;
  const pass = s.imapPass || s.smtpPass;
  if (!s.imapHost || !user || !pass) return 0;

  const client = new ImapFlow({ host: s.imapHost, port: s.imapPort, secure: true, auth: { user, pass }, logger: false });
  let found = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - 14 * 86_400_000);
      const uids = await client.search({ since }, { uid: true });
      if (!uids || !uids.length) return 0;
      for await (const msg of client.fetch(uids.slice(-300), { envelope: true, bodyParts: ["TEXT"] }, { uid: true })) {
        const from = msg.envelope?.from?.[0]?.address?.toLowerCase();
        if (!from) continue;
        const lead = repo.getLeadByEmail(from);
        if (!lead || lead.replied_at || !["contacted", "approved"].includes(lead.status)) continue;

        const text = msg.bodyParts?.get("TEXT")?.toString("utf8") ?? "";
        repo.cancelRemaining(lead.id);
        repo.updateLead(lead.id, { status: "replied", replied_at: new Date().toISOString() });
        if (isOptOut(text)) {
          repo.suppress(from, "replied stop");
          repo.log(`${lead.name} opted out — added to do-not-contact list`, "warn");
        } else {
          repo.log(`🎉 ${lead.name} replied! Follow-ups stopped.`, "success");
        }
        found++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  if (found) log.info({ found }, "new replies");
  return found;
}
