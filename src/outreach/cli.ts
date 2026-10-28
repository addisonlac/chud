import { readFileSync } from "node:fs";
import { outreachConfig, missingFacebookConfig } from "./config.js";
import { OutreachAgent, formatQueueMessage } from "./agent.js";
import { leadsFromCsv, type LeadStatus } from "./leads.js";
import { findBusinessesWithoutWebsite } from "./places.js";
import { draftPagePost } from "./writer.js";

const USAGE = `Facebook outreach agent — npm run outreach -- <command>

  check                        verify Facebook token + config
  find "<niche>" "<city>"      find local businesses with no website (Google Places)
  import <leads.csv>           add leads (columns: name,niche,city,facebook_url,phone,email,website,notes)
  draft                        write personalized DMs for new leads + due follow-ups
  queue                        show DMs ready to send (with Facebook links)
  sent <lead-id>               mark a DM as sent (starts the follow-up timer)
  status <lead-id> <replied|won|lost|skip>
  leads                        pipeline summary
  post [--dry-run]             write (and publish) a Page post now
  inbox                        replies awaiting approval (when FB_AUTO_REPLY=false)
  approve <id> | reject <id>   send / discard a pending reply
  tick                         run one full daemon cycle now

For hands-off 24/7 operation run: npm run outreach:daemon`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = outreachConfig;
  const agent = new OutreachAgent(cfg, async (text) => console.log(`\n${text}`));
  const { leads, state } = agent;

  switch (cmd) {
    case "check": {
      const missing = missingFacebookConfig(cfg);
      if (missing.length) throw new Error(`Missing: ${missing.join(", ")}`);
      const me = await agent.facebook.whoAmI();
      console.log(`✅ Connected to Facebook Page "${me.name}" (${me.id})`);
      if (me.id !== cfg.FB_PAGE_ID) console.warn(`⚠️ Token belongs to ${me.id}, but FB_PAGE_ID is ${cfg.FB_PAGE_ID}`);
      break;
    }
    case "find": {
      const [niche, city] = args;
      if (!niche || !city) throw new Error('Usage: find "<niche>" "<city>"');
      const found = await findBusinessesWithoutWebsite(cfg, niche, city);
      console.log(`Found ${found.length} businesses without a website; ${leads.add(found)} new.`);
      break;
    }
    case "import": {
      if (!args[0]) throw new Error("Usage: import <file.csv>");
      console.log(`Imported ${leads.add(leadsFromCsv(readFileSync(args[0], "utf8")))} new leads.`);
      break;
    }
    case "draft":
      console.log(`Drafted ${await agent.draftQueue()} messages. Run \`queue\` to see them.`);
      break;
    case "queue": {
      const queue = agent.sendQueue();
      if (!queue.length) console.log("Nothing queued. Run `draft` (or `find` / `import` first).");
      for (const { lead, followUp } of queue) console.log(`\n${"─".repeat(60)}\n${formatQueueMessage(lead, followUp)}`);
      break;
    }
    case "sent": {
      const lead = leads.markSent(requireArg(args[0], "sent <lead-id>"));
      console.log(`Marked ${lead.name} as contacted. Follow-up due in ${cfg.OUTREACH_FOLLOWUP_DAYS} days if no reply.`);
      break;
    }
    case "status": {
      const status = requireArg(args[1], "status <lead-id> <replied|won|lost|skip>") as LeadStatus;
      if (!["replied", "won", "lost", "skip"].includes(status)) throw new Error(`Unknown status "${status}"`);
      leads.update(requireArg(args[0], "status <lead-id> <status>"), { status, draft: undefined });
      console.log("Updated.");
      break;
    }
    case "leads": {
      const counts = new Map<string, number>();
      for (const l of leads.all()) counts.set(l.status, (counts.get(l.status) ?? 0) + 1);
      console.log([...counts].map(([s, n]) => `${s}: ${n}`).join("  ") || "No leads yet.");
      break;
    }
    case "post": {
      if (args.includes("--dry-run")) console.log(await draftPagePost(cfg));
      else console.log(`Published post ${await agent.publishPagePost()}`);
      break;
    }
    case "inbox": {
      const pending = state.pending();
      if (!pending.length) console.log("No replies awaiting approval.");
      for (const p of pending) {
        console.log(`\n[${p.id}] ${p.kind} from ${p.fromName || "unknown"}${p.isHotLead ? " 🔥" : ""}\n  They: ${p.inboundText}\n  Draft: ${p.reply}`);
      }
      break;
    }
    case "approve":
    case "reject": {
      const p = state.takePending(requireArg(args[0], `${cmd} <id>`));
      if (!p) throw new Error("No pending reply with that id");
      if (cmd === "approve") await agent.sendReply(p.kind, p.targetId, p.reply, p.isHotLead);
      console.log(cmd === "approve" ? "Sent." : "Discarded.");
      break;
    }
    case "tick":
      await agent.tick();
      console.log("Cycle complete.");
      break;
    default:
      console.log(USAGE);
  }

  leads.save();
  state.save();
}

function requireArg(value: string | undefined, usage: string): string {
  if (!value) throw new Error(`Usage: ${usage}`);
  return value;
}

main().catch((err: Error) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
