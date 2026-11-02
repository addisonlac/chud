import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Agent } from "../agent/agent.js";
import type { SettingsStore } from "../config/settings.js";
import type { Repo } from "../db/repo.js";
import { csvToLeads } from "../discover/csvImport.js";
import { complianceFooter, signature } from "../draft/compose.js";
import { redraftLead } from "../pipeline/processLead.js";
import { fromAddress, sendBlocker, smtpConfigured } from "../send/mailer.js";
import { CATEGORIES, type Category, type LeadStatus } from "../types.js";

export interface AppDeps {
  repo: Repo;
  settings: SettingsStore;
  agent: Agent;
  password?: string;
}

const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function basicAuth(password: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const pass = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
      if (safeEqual(pass, password)) return next();
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Outreach Agent"');
    res.status(401).send("Login required");
  };
}

const id = (req: Request) => Number(req.params.id);

export function createApp(deps: AppDeps): Express {
  const { repo, settings, agent } = deps;
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    const st = agent.getStatus();
    res.json({ ok: true, running: st.running, phase: st.phase, lastCycleAt: st.lastCycleAt });
  });

  if (deps.password) app.use(basicAuth(deps.password));
  app.use(express.json({ limit: "5mb" }));
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

  // ---------- status / agent ----------
  app.get("/api/status", (_req, res) => {
    const s = settings.get();
    res.json({
      agent: agent.getStatus(),
      stats: repo.stats(),
      checklist: settings.setupChecklist(),
      dailyCap: s.dailyCap,
      sendBlock: sendBlocker(s, repo),
      niches: s.niches,
    });
  });
  app.post("/api/agent/start", (_req, res) => {
    agent.start();
    res.json(agent.getStatus());
  });
  app.post("/api/agent/pause", (_req, res) => {
    agent.pause();
    res.json(agent.getStatus());
  });
  app.post("/api/agent/run", (_req, res) => {
    agent.runNow();
    res.json(agent.getStatus());
  });
  app.get("/api/activity", (_req, res) => res.json(repo.activity(150)));

  // ---------- queues ----------
  app.get("/api/queue/:category", (req, res) => {
    const c = req.params.category as Category;
    if (!CATEGORIES.includes(c)) return res.status(404).json({ error: "unknown queue" });
    res.json(repo.queue(c));
  });

  app.get("/api/leads", (req, res) => {
    res.json(
      repo.listLeads({
        status: (req.query.status as LeadStatus) || undefined,
        category: (req.query.category as Category) || undefined,
        search: (req.query.q as string) || undefined,
        limit: Math.min(Number(req.query.limit) || 200, 1000),
        offset: Number(req.query.offset) || 0,
      }),
    );
  });

  app.get("/api/leads/:id", (req, res) => {
    const lead = repo.getLead(id(req));
    if (!lead) return res.status(404).json({ error: "not found" });
    const s = settings.get();
    res.json({ lead, drafts: repo.draftsForLead(lead.id), signature: signature(s), footer: complianceFooter(s), from: fromAddress(s) });
  });

  app.post("/api/leads", (req, res) => {
    const { name, website, email, facebook, niche } = req.body ?? {};
    if (!name || (!website && !facebook)) return res.status(400).json({ error: "Name and a website or Facebook URL are required" });
    const newId = repo.insertLead({ name, source: "manual", websiteUrl: website || null, email: email || null, facebookUrl: facebook || null, niche });
    if (newId === null) return res.status(409).json({ error: "That business is already in your leads" });
    repo.log(`Added lead ${name} manually`);
    res.json({ id: newId });
  });

  app.post("/api/import", (req, res) => {
    const leads = csvToLeads(String(req.body?.csv ?? ""));
    let added = 0;
    for (const l of leads) if (repo.insertLead(l) !== null) added++;
    repo.log(`Imported ${added} lead${added === 1 ? "" : "s"} from CSV (${leads.length - added} duplicates skipped)`);
    res.json({ parsed: leads.length, added });
  });

  // ---------- drafts / approval ----------
  app.put("/api/drafts/:id", (req, res) => {
    const d = repo.getDraft(id(req));
    if (!d) return res.status(404).json({ error: "not found" });
    if (d.status === "sent") return res.status(409).json({ error: "Already sent" });
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : d.subject;
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : d.body;
    if (!subject || !body) return res.status(400).json({ error: "Subject and body can't be empty" });
    repo.updateDraft(d.id, { subject, body });
    res.json(repo.getDraft(d.id));
  });

  app.post("/api/leads/:id/approve", (req, res) => {
    const lead = repo.getLead(id(req));
    if (!lead) return res.status(404).json({ error: "not found" });
    const drafts = repo.draftsForLead(lead.id);
    const first = drafts.find((d) => d.step === 0);
    if (!first) return res.status(400).json({ error: "No draft to approve" });
    const s = settings.get();

    if (first.channel === "manual") {
      // DM leads: the user sends it themselves; approving = marking it sent.
      repo.updateDraft(first.id, { status: "sent", sent_at: new Date().toISOString().replace("T", " ").slice(0, 19) });
      repo.setDraftStatusForLead(lead.id, ["pending"], "cancelled");
      repo.updateLead(lead.id, { status: "contacted" });
      repo.log(`Marked DM to ${lead.name} as sent`, "success");
      return res.json({ ok: true, note: "Marked as sent" });
    }

    if (!lead.email) return res.status(400).json({ error: "This lead has no email address" });
    if (repo.isSuppressed(lead.email)) return res.status(400).json({ error: `${lead.email} is on your do-not-contact list` });
    if (!smtpConfigured(s)) return res.status(400).json({ error: "Connect your email (SMTP) in Settings first" });

    repo.approveLead(lead.id, req.body?.includeFollowups !== false);
    repo.log(`Approved outreach to ${lead.name}`, "success");
    const block = sendBlocker(s, repo);
    const note =
      block === "outside_window"
        ? `Queued — sends in your next window (${s.sendWindow}, Mon–Fri)`
        : block === "daily_cap"
          ? "Queued — today's limit is reached, sends tomorrow"
          : block === "no_address"
            ? "Queued — add your mailing address in Settings so it can send"
            : "Queued — sending within a couple of minutes";
    res.json({ ok: true, note });
  });

  app.post("/api/leads/:id/skip", (req, res) => {
    repo.skipLead(id(req));
    res.json({ ok: true });
  });

  app.post("/api/leads/:id/unskip", (req, res) => {
    const lead = repo.getLead(id(req));
    if (!lead) return res.status(404).json({ error: "not found" });
    repo.setDraftStatusForLead(lead.id, ["skipped"], "pending");
    repo.updateLead(lead.id, { status: "drafted" });
    res.json({ ok: true });
  });

  app.post("/api/leads/:id/suppress", (req, res) => {
    const lead = repo.getLead(id(req));
    if (!lead) return res.status(404).json({ error: "not found" });
    if (lead.email) repo.suppress(lead.email, "manual");
    repo.skipLead(lead.id);
    repo.log(`Added ${lead.name} to do-not-contact list`, "warn");
    res.json({ ok: true });
  });

  app.post("/api/leads/:id/redraft", async (req, res) => {
    const lead = repo.getLead(id(req));
    if (!lead) return res.status(404).json({ error: "not found" });
    let ok = false;
    try {
      ok = await redraftLead(lead, { repo, settings: settings.get() });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
    if (!ok) return res.status(400).json({ error: "This lead has no audit findings to write from" });
    res.json({ ok: true, drafts: repo.draftsForLead(lead.id) });
  });

  app.post("/api/leads/:id/reaudit", (req, res) => {
    const lead = repo.getLead(id(req));
    if (!lead) return res.status(404).json({ error: "not found" });
    repo.setDraftStatusForLead(lead.id, ["pending"], "cancelled");
    repo.updateLead(lead.id, { status: "new", error: null });
    res.json({ ok: true, note: "Queued for the next cycle" });
  });

  app.get("/api/sent", (_req, res) => res.json(repo.sentLog()));

  // ---------- settings ----------
  app.get("/api/settings", (_req, res) => res.json(settings.forUi()));
  app.put("/api/settings", (req, res) => {
    settings.save(req.body ?? {});
    repo.log("Settings saved");
    res.json(settings.forUi());
  });

  app.post("/api/test-email", async (req, res) => {
    const s = settings.get();
    const to = String(req.body?.to ?? s.fromEmail ?? s.smtpUser);
    if (!smtpConfigured(s)) return res.status(400).json({ error: "Fill in SMTP host, username and password first" });
    try {
      await agent.transportForTest().sendMail({
        from: fromAddress(s),
        to,
        subject: "Outreach Agent — test email",
        text: `It works! Approved emails will be sent from this mailbox.\n\n${signature(s)}\n\n${complianceFooter(s)}`,
      });
      res.json({ ok: true, note: `Test email sent to ${to}` });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/suppression", (_req, res) => res.json(repo.listSuppressed()));
  app.post("/api/suppression", (req, res) => {
    const email = String(req.body?.email ?? "").trim();
    if (!/^@?[^@\s]*@?[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter an email or @domain.com" });
    repo.suppress(email, "manual");
    res.json({ ok: true });
  });
  app.delete("/api/suppression/:email", (req, res) => {
    repo.removeSuppressed(String(req.params.email));
    res.json({ ok: true });
  });

  // SPA fallback
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile("index.html", { root: PUBLIC_DIR }));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}
