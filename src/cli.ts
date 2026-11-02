/**
 * Command-line helpers (the app itself is `npm start`). Useful for scripting
 * and for trying a single site:
 *
 *   npm run cli -- audit https://some-store.com     audit + draft one site, print the email
 *   npm run cli -- cycle                            run one discover → audit → draft cycle
 *   npm run cli -- import leads.csv                 import a CSV of leads
 *   npm run cli -- stats                            queue counts
 */
import { readFileSync } from "node:fs";
import { Agent } from "./agent/agent.js";
import { env } from "./config/env.js";
import { SettingsStore } from "./config/settings.js";
import { openDb } from "./db/db.js";
import { Repo } from "./db/repo.js";
import { csvToLeads } from "./discover/csvImport.js";
import { renderEmail } from "./draft/compose.js";
import { processLead } from "./pipeline/processLead.js";

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const repo = new Repo(openDb(env.DB_PATH));
  const settings = new SettingsStore(repo);

  switch (cmd) {
    case "audit": {
      if (!arg) throw new Error("usage: audit <url>");
      const domain = new URL(arg.startsWith("http") ? arg : `https://${arg}`).hostname.replace(/^www\./, "");
      let leadId = repo.insertLead({ name: domain.split(".")[0]!, source: "manual", websiteUrl: arg });
      if (leadId === null) {
        const existing = repo.db.prepare("SELECT id FROM leads WHERE domain = ?").get(domain) as { id: number };
        leadId = existing.id;
        repo.updateLead(leadId, { status: "new" });
      }
      const outcome = await processLead(repo.getLead(leadId)!, { repo, settings: settings.get() });
      const lead = repo.getLead(leadId)!;
      console.log(`\n${lead.name} (${lead.domain}) — platform: ${lead.platform}, outcome: ${outcome}`);
      console.log("Scores:", lead.scores, "→ queue:", lead.category ?? "none");
      for (const f of lead.findings ?? []) console.log(`  [${f.category} s${f.severity}] ${f.evidence}: ${f.pain}`);
      console.log("Contact:", lead.email ?? "(none)", lead.contact_name ?? "");
      for (const d of repo.draftsForLead(leadId)) {
        console.log(`\n───── step ${d.step} (${d.composer}, +${d.delay_days}d) ─────\nSubject: ${d.subject}\n\n${renderEmail(d.body, settings.get(), d.channel)}`);
      }
      break;
    }
    case "cycle": {
      const agent = new Agent(repo, settings);
      await agent.runCycle(true);
      console.log(agent.getStatus().lastCycleSummary);
      agent.stopAll();
      break;
    }
    case "import": {
      if (!arg) throw new Error("usage: import <file.csv>");
      const leads = csvToLeads(readFileSync(arg, "utf8"));
      let added = 0;
      for (const l of leads) if (repo.insertLead(l) !== null) added++;
      console.log(`Imported ${added}/${leads.length} leads`);
      break;
    }
    case "stats":
      console.log(JSON.stringify(repo.stats(), null, 2));
      break;
    default:
      console.log("commands: audit <url> | cycle | import <file.csv> | stats   (start the app with: npm start)");
  }
  repo.db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
