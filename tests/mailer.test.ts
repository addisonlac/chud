import { describe, expect, it, vi } from "vitest";
import { inSendWindow, sendNextDue, type MailTransport } from "../src/send/mailer.js";
import { memRepo, testSettings } from "./helpers.js";
import type { Repo } from "../src/db/repo.js";

function seedApproved(repo: Repo, email = "sarah@lumen.co") {
  const id = repo.insertLead({ name: "Lumen", source: "manual", websiteUrl: "https://lumen.co", email })!;
  repo.saveSequence(id, [
    { step: 0, subject: "S", body: "Hi Sarah,\n\nBody", channel: "email", composer: "template", delayDays: 0 },
    { step: 1, subject: "Re: S", body: "Hi Sarah,\n\nFU", channel: "email", composer: "template", delayDays: 3 },
  ]);
  repo.updateLead(id, { status: "drafted" });
  repo.approveLead(id, true);
  return id;
}

const transport = () => {
  const sent: Parameters<MailTransport["sendMail"]>[0][] = [];
  const t: MailTransport = { sendMail: vi.fn(async (m) => { sent.push(m); return { messageId: `<m${sent.length}@x>` }; }) };
  return { t, sent };
};

describe("inSendWindow", () => {
  it("only sends Mon–Fri inside the hours", () => {
    expect(inSendWindow("08-18", new Date(2026, 10, 2, 10))).toBe(true); // Monday 10:00
    expect(inSendWindow("08-18", new Date(2026, 10, 2, 19))).toBe(false);
    expect(inSendWindow("08-18", new Date(2026, 10, 1, 10))).toBe(false); // Sunday
  });
});

describe("sendNextDue", () => {
  it("sends the approved first email with the footer, then waits for the follow-up delay", async () => {
    const repo = memRepo();
    const id = seedApproved(repo);
    const { t, sent } = transport();
    const s = testSettings();
    expect(await sendNextDue(repo, s, t, new Date(2026, 10, 2, 10))).toBe("sent");
    expect(sent[0]!.to).toBe("sarah@lumen.co");
    expect(sent[0]!.text).toContain("1 Main St");
    expect(sent[0]!.text).toMatch(/reply "stop"/);
    expect(repo.getLead(id)!.status).toBe("contacted");
    // follow-up is not due yet (3 days)
    expect(await sendNextDue(repo, s, t, new Date(2026, 10, 2, 10))).toBe("idle");
    // pretend 3 days passed
    repo.db.prepare("UPDATE drafts SET sent_at = datetime('now','-4 days') WHERE step = 0").run();
    expect(await sendNextDue(repo, s, t, new Date(2026, 10, 2, 10))).toBe("sent");
    expect(sent[1]!.inReplyTo).toBe("<m1@x>"); // threads under the first email
  });

  it("never emails suppressed addresses or replied leads", async () => {
    const repo = memRepo();
    seedApproved(repo, "no@shop.com");
    repo.suppress("@shop.com", "domain opt-out");
    const { t, sent } = transport();
    await sendNextDue(repo, testSettings(), t, new Date(2026, 10, 2, 10));
    expect(sent).toHaveLength(0);

    const id2 = seedApproved(repo, "yes@other.com");
    repo.updateLead(id2, { replied_at: new Date().toISOString() });
    expect(await sendNextDue(repo, testSettings(), t, new Date(2026, 10, 2, 10))).toBe("idle");
  });

  it("respects the daily cap and missing setup", async () => {
    const repo = memRepo();
    seedApproved(repo);
    const { t } = transport();
    expect(await sendNextDue(repo, testSettings({ dailyCap: 0 }), t)).toBe("daily_cap");
    expect(await sendNextDue(repo, testSettings({ smtpPass: "" }), t)).toBe("no_smtp");
    expect(await sendNextDue(repo, testSettings({ senderAddress: "" }), t)).toBe("no_address");
  });
});
