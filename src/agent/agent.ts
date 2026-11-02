import type { SettingsStore } from "../config/settings.js";
import type { Repo } from "../db/repo.js";
import { discoverViaBrave, discoverViaCertificates } from "../discover/shopify.js";
import { discoverViaMetaAds } from "../discover/metaAdLibrary.js";
import { formatQueueMessage, sendTelegramMessage } from "../notify/telegram.js";
import { processLead } from "../pipeline/processLead.js";
import { createTransport, sendNextDue, type MailTransport } from "../send/mailer.js";
import { checkReplies } from "../send/replies.js";
import type { DiscoveredLead } from "../types.js";
import { childLogger } from "../utils/logger.js";
import { Semaphore } from "../utils/semaphore.js";

const log = childLogger("agent");

export type AgentPhase = "idle" | "discovering" | "auditing" | "sleeping" | "paused";

export interface AgentStatus {
  running: boolean;
  phase: AgentPhase;
  detail: string;
  currentNiche: string | null;
  lastCycleAt: string | null;
  lastCycleSummary: string | null;
  nextCycleAt: string | null;
  cycles: number;
  lastError: string | null;
  sendState: string;
}

/**
 * The 24/7 loop. Each cycle: pick the next niche → discover leads from every
 * enabled source → audit + draft them → ping Telegram. Separately, a send
 * tick delivers approved emails (spaced out, inside the send window, under
 * the daily cap) and a reply check stops sequences when someone answers.
 */
export class Agent {
  private status: AgentStatus = {
    running: false,
    phase: "paused",
    detail: "Paused",
    currentNiche: null,
    lastCycleAt: null,
    lastCycleSummary: null,
    nextCycleAt: null,
    cycles: 0,
    lastError: null,
    sendState: "idle",
  };
  private cycleTimer: NodeJS.Timeout | null = null;
  private sendTimer: NodeJS.Timeout | null = null;
  private replyTimer: NodeJS.Timeout | null = null;
  private inCycle = false;
  private transport: MailTransport | null = null;
  private transportKey = "";

  constructor(
    private readonly repo: Repo,
    private readonly settings: SettingsStore,
  ) {
    this.status.lastCycleAt = repo.getKv("lastCycleAt");
    this.status.lastCycleSummary = repo.getKv("lastCycleSummary");
    this.status.cycles = Number(repo.getKv("cycles") ?? 0);
  }

  getStatus(): AgentStatus {
    return { ...this.status };
  }

  /** Start discovery/drafting. Sending/reply checks always run (approved emails still go out while paused). */
  start(): void {
    if (this.status.running) return;
    this.status.running = true;
    this.repo.setKv("agentRunning", "true");
    this.repo.log("Agent started — hunting for leads 24/7", "success");
    void this.runCycle();
  }

  pause(): void {
    this.status.running = false;
    this.repo.setKv("agentRunning", "false");
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    this.cycleTimer = null;
    this.status.nextCycleAt = null;
    if (!this.inCycle) this.setPhase("paused", "Paused");
    this.repo.log("Agent paused", "warn");
  }

  /** Background workers that run for the life of the app. */
  startBackground(): void {
    this.sendTimer = setInterval(() => void this.sendTick(), 90_000);
    this.replyTimer = setInterval(() => void this.replyTick(), 10 * 60_000);
    setTimeout(() => void this.sendTick(), 5_000);
    setTimeout(() => void this.replyTick(), 20_000);
  }

  stopAll(): void {
    for (const t of [this.cycleTimer, this.sendTimer, this.replyTimer]) if (t) clearTimeout(t);
  }

  runNow(): void {
    if (this.inCycle) return;
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    void this.runCycle(true);
  }

  private setPhase(phase: AgentPhase, detail: string): void {
    this.status.phase = phase;
    this.status.detail = detail;
  }

  private nextNiche(): string | null {
    const niches = this.settings.get().niches;
    if (!niches.length) return null;
    const i = Number(this.repo.getKv("nicheIndex") ?? 0) % niches.length;
    this.repo.setKv("nicheIndex", String(i + 1));
    return niches[i]!;
  }

  private async discover(niche: string): Promise<DiscoveredLead[]> {
    const s = this.settings.get();
    const out: DiscoveredLead[] = [];
    const per = s.leadsPerCycle;

    if (s.sources.includes("shopify_search") && s.braveApiKey) {
      const key = `brave:${niche}`;
      const page = Number(this.repo.getKv(key) ?? 0);
      try {
        out.push(...(await discoverViaBrave(s.braveApiKey, niche, page, per)));
        this.repo.setKv(key, String(page + 1));
      } catch (err) {
        this.repo.log(`Brave search failed for "${niche}": ${(err as Error).message}`, "error");
      }
    }

    if (s.sources.includes("shopify_ct")) {
      const seen = (handle: string) => this.repo.getKv(`ct:${handle}`) !== null;
      const markSeen = (handle: string) => this.repo.setKv(`ct:${handle}`, "1");
      try {
        out.push(...(await discoverViaCertificates(niche, per, seen, markSeen)));
      } catch (err) {
        this.repo.log(`Certificate-log search failed for "${niche}": ${(err as Error).message}`, "warn");
      }
    }

    if (s.sources.includes("meta_ads") && s.metaAccessToken) {
      const key = `meta:${niche}`;
      try {
        const res = await discoverViaMetaAds(s.metaAccessToken, niche, s.metaCountries, this.repo.getKv(key), per);
        this.repo.setKv(key, res.nextCursor ?? "");
        out.push(...res.leads);
      } catch (err) {
        this.repo.log(`Meta Ad Library failed for "${niche}": ${(err as Error).message}`, "error");
      }
    }
    return out;
  }

  /** One full discover → audit → draft pass. */
  async runCycle(manual = false): Promise<void> {
    if (this.inCycle) return;
    this.inCycle = true;
    const started = Date.now();
    let drafted = 0;
    try {
      const s = this.settings.get();
      const niche = this.nextNiche();
      this.status.currentNiche = niche;

      let added = 0;
      if (niche) {
        this.setPhase("discovering", `Searching for "${niche}" leads`);
        const found = await this.discover(niche);
        for (const l of found) if (this.repo.insertLead(l) !== null) added++;
        this.repo.log(`Found ${added} new lead${added === 1 ? "" : "s"} for "${niche}"`);
      }

      const todo = this.repo.leadsToProcess(Math.max(s.leadsPerCycle * 3, 20));
      const sem = new Semaphore(4);
      let done = 0;
      this.setPhase("auditing", `Auditing ${todo.length} lead${todo.length === 1 ? "" : "s"}`);
      await Promise.all(
        todo.map(async (lead) => {
          const release = await sem.acquire();
          try {
            const outcome = await processLead(lead, { repo: this.repo, settings: this.settings.get() });
            if (outcome === "drafted") drafted++;
          } finally {
            done++;
            this.status.detail = `Auditing & writing: ${done}/${todo.length}`;
            release();
          }
        }),
      );

      const summary = `${niche ? `"${niche}": ` : ""}${added} found, ${todo.length} audited, ${drafted} drafted`;
      this.status.lastCycleSummary = summary;
      this.status.lastCycleAt = new Date().toISOString();
      this.status.cycles++;
      this.status.lastError = null;
      this.repo.setKv("lastCycleAt", this.status.lastCycleAt);
      this.repo.setKv("lastCycleSummary", summary);
      this.repo.setKv("cycles", String(this.status.cycles));
      log.info({ summary, ms: Date.now() - started }, "cycle complete");

      if (drafted > 0) {
        const st = this.settings.get();
        await sendTelegramMessage(st.telegramBotToken, st.telegramChatId, formatQueueMessage(this.repo.stats().queues, drafted, st.appUrl));
      }
    } catch (err) {
      this.status.lastError = (err as Error).message;
      this.repo.log(`Cycle failed: ${(err as Error).message}`, "error");
      const st = this.settings.get();
      await sendTelegramMessage(st.telegramBotToken, st.telegramChatId, `⚠️ Outreach agent cycle failed: ${(err as Error).message}`);
    } finally {
      this.inCycle = false;
      this.scheduleNext(manual);
    }
  }

  private scheduleNext(_manual: boolean): void {
    if (!this.status.running) {
      this.setPhase("paused", "Paused");
      return;
    }
    const mins = Math.max(1, this.settings.get().cycleMinutes);
    const at = new Date(Date.now() + mins * 60_000);
    this.status.nextCycleAt = at.toISOString();
    this.setPhase("sleeping", `Next search at ${at.toLocaleTimeString()}`);
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    this.cycleTimer = setTimeout(() => void this.runCycle(), mins * 60_000);
  }

  private getTransport(): MailTransport {
    const s = this.settings.get();
    const key = `${s.smtpHost}|${s.smtpPort}|${s.smtpUser}|${s.smtpPass}|${s.smtpSecure}`;
    if (!this.transport || key !== this.transportKey) {
      this.transport = createTransport(s);
      this.transportKey = key;
    }
    return this.transport;
  }

  /** Exposed so the app can send a test email with the same transport. */
  transportForTest(): MailTransport {
    return this.getTransport();
  }

  private async sendTick(): Promise<void> {
    try {
      const s = this.settings.get();
      const r = await sendNextDue(this.repo, s, this.getTransport());
      const labels: Record<string, string> = {
        sent: "Sending",
        idle: "Nothing waiting to send",
        no_smtp: "Email not connected — add SMTP in Settings",
        no_address: "Add your mailing address in Settings to send",
        outside_window: `Waiting for send window (${s.sendWindow}, Mon–Fri)`,
        daily_cap: `Daily limit reached (${s.dailyCap}) — resumes tomorrow`,
        failed: "Last send failed — see Activity",
      };
      this.status.sendState = labels[r ?? "idle"] ?? String(r);
    } catch (err) {
      this.status.sendState = `Send error: ${(err as Error).message}`;
    }
  }

  private async replyTick(): Promise<void> {
    try {
      await checkReplies(this.repo, this.settings.get());
    } catch (err) {
      log.warn({ err: (err as Error).message }, "reply check failed");
    }
  }
}
