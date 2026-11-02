import type { DiscoveredLead } from "../types.js";

/** Small RFC-4180-ish CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  name: ["name", "business", "business name", "company", "store", "title"],
  website: ["website", "url", "site", "domain", "web"],
  email: ["email", "e-mail", "email address"],
  facebook: ["facebook", "facebook url", "fb"],
  niche: ["niche", "category", "industry"],
};

/** CSV with a header row → leads. Columns are matched loosely (Website/URL/Domain...). */
export function csvToLeads(text: string): DiscoveredLead[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const idx = (field: string) => header.findIndex((h) => ALIASES[field]!.includes(h.trim().toLowerCase()));
  const col = { name: idx("name"), website: idx("website"), email: idx("email"), facebook: idx("facebook"), niche: idx("niche") };
  const get = (r: string[], i: number) => (i >= 0 ? r[i]?.trim() || null : null);

  return rows
    .map((r): DiscoveredLead | null => {
      const website = get(r, col.website);
      const facebook = get(r, col.facebook);
      const name = get(r, col.name) ?? website ?? "";
      if (!name || (!website && !facebook)) return null;
      return {
        name,
        source: "csv",
        niche: get(r, col.niche) ?? undefined,
        websiteUrl: website,
        facebookUrl: facebook,
        email: get(r, col.email),
      };
    })
    .filter((l): l is DiscoveredLead => l !== null);
}
