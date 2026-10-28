import type { OutreachConfig } from "./config.js";
import type { NewLead } from "./leads.js";
import { fetchJson } from "../utils/http.js";

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
].join(",");

interface PlacesResponse {
  places?: {
    displayName?: { text: string };
    formattedAddress?: string;
    websiteUri?: string;
    nationalPhoneNumber?: string;
    rating?: number;
    userRatingCount?: number;
    businessStatus?: string;
  }[];
}

/**
 * Finds operating local businesses in a niche + city that list NO website on
 * Google — the strongest prospects for a website-building offer. Results
 * with a website are dropped unless `includeWithWebsite` is set (useful if
 * you also sell redesigns).
 */
export async function findBusinessesWithoutWebsite(
  cfg: OutreachConfig,
  niche: string,
  city: string,
  includeWithWebsite = false,
): Promise<NewLead[]> {
  if (!cfg.GOOGLE_PLACES_API_KEY) {
    throw new Error("GOOGLE_PLACES_API_KEY is not set — add leads with `import <file.csv>` instead");
  }

  const res = await fetchJson<PlacesResponse>(PLACES_SEARCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": cfg.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: `${niche} in ${city}`, pageSize: 20 }),
  });

  return (res.places ?? [])
    .filter((p) => p.displayName?.text && p.businessStatus !== "CLOSED_PERMANENTLY")
    .filter((p) => includeWithWebsite || !p.websiteUri)
    .map((p) => ({
      name: p.displayName!.text,
      niche,
      city,
      address: p.formattedAddress,
      phone: p.nationalPhoneNumber,
      website: p.websiteUri,
      rating: p.rating,
      reviewCount: p.userRatingCount,
      source: "google-places" as const,
    }));
}
