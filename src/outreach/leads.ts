import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LeadStatus = "new" | "drafted" | "sent" | "replied" | "won" | "lost" | "skip";

export interface Lead {
  id: string;
  name: string;
  niche: string;
  city: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  facebookUrl?: string;
  rating?: number;
  reviewCount?: number;
  notes?: string;
  source: "csv" | "google-places" | "facebook-inbound";
  status: LeadStatus;
  draft?: string;
  followUpCount: number;
  createdAt: string;
  sentAt?: string;
  lastContactAt?: string;
}

export type NewLead = Omit<Lead, "id" | "status" | "followUpCount" | "createdAt"> & { status?: LeadStatus };

export function leadId(name: string, city: string): string {
  return `${name}-${city}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** JSON-file lead pipeline: new → drafted → sent → replied → won/lost. */
export class LeadStore {
  private leads: Lead[];

  constructor(private readonly path: string) {
    this.leads = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Lead[]) : [];
  }

  all(): Lead[] {
    return [...this.leads];
  }

  get(id: string): Lead | undefined {
    return this.leads.find((l) => l.id === id);
  }

  byStatus(status: LeadStatus): Lead[] {
    return this.leads.filter((l) => l.status === status);
  }

  /** Adds leads, skipping duplicates (same name+city). Returns how many were new. */
  add(incoming: NewLead[], now = new Date()): number {
    let added = 0;
    for (const lead of incoming) {
      const id = leadId(lead.name, lead.city);
      if (!id || this.get(id)) continue;
      this.leads.push({ ...lead, id, status: lead.status ?? "new", followUpCount: 0, createdAt: now.toISOString() });
      added++;
    }
    return added;
  }

  update(id: string, patch: Partial<Lead>): Lead {
    const lead = this.get(id);
    if (!lead) throw new Error(`No lead with id "${id}"`);
    Object.assign(lead, patch);
    return lead;
  }

  markSent(id: string, now = new Date()): Lead {
    const lead = this.get(id);
    if (!lead) throw new Error(`No lead with id "${id}"`);
    const isFollowUp = lead.status === "sent";
    return this.update(id, {
      status: "sent",
      sentAt: lead.sentAt ?? now.toISOString(),
      lastContactAt: now.toISOString(),
      followUpCount: isFollowUp ? lead.followUpCount + 1 : lead.followUpCount,
      draft: undefined,
    });
  }

  sentOn(day: Date): number {
    const key = day.toISOString().slice(0, 10);
    return this.leads.filter((l) => l.lastContactAt?.slice(0, 10) === key).length;
  }

  /** Leads you messaged with no reply after `days`, still under the follow-up cap. */
  followUpsDue(days: number, maxFollowUps: number, now = new Date()): Lead[] {
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    return this.leads.filter(
      (l) =>
        l.status === "sent" &&
        l.followUpCount < maxFollowUps &&
        l.lastContactAt !== undefined &&
        new Date(l.lastContactAt).getTime() <= cutoff,
    );
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.leads, null, 2));
  }
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/**
 * Maps CSV rows to leads. Expected columns (case-insensitive, only `name`
 * required): name, niche, city, facebook_url, phone, email, website, notes.
 */
export function leadsFromCsv(text: string): NewLead[] {
  return parseCsv(text)
    .filter((r) => r.name)
    .map((r) => ({
      name: r.name!,
      niche: r.niche ?? "",
      city: r.city ?? "",
      facebookUrl: r.facebook_url || r.facebook || undefined,
      phone: r.phone || undefined,
      email: r.email || undefined,
      website: r.website || undefined,
      notes: r.notes || undefined,
      source: "csv" as const,
    }));
}
