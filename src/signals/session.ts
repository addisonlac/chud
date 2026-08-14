// ---------------------------------------------------------------------------
// Intraday session / "kill-zone" filter.
//
// A 1-minute entry model lives or dies on WHEN it trades. Outside the high-
// liquidity windows (the cash open, the London/NY overlap) 1m structure is
// mostly noise: thin volume, fake sweeps, chop that stops you out. This module
// gates signals to one or more wall-clock windows in a chosen timezone
// (default: the New York morning session), so the engine only fires when
// institutional flow is actually moving price.
//
// It is deliberately data-source agnostic — it takes a bar's unix time and a
// window spec, and answers "is this bar inside a tradeable session?".
// ---------------------------------------------------------------------------

/** A wall-clock window, "HH:MM"–"HH:MM" inclusive of start, exclusive of end. */
export interface SessionWindow {
  start: string; // "09:30"
  end: string; // "12:00"
  label?: string; // e.g. "NY open"
}

export interface SessionConfig {
  enabled: boolean;
  /** IANA timezone the windows are expressed in (e.g. "America/New_York"). */
  timezone: string;
  /** Trade only on these weekdays (0 = Sunday … 6 = Saturday). Default Mon–Fri. */
  weekdays: number[];
  windows: SessionWindow[];
}

/**
 * Default: the New York morning kill-zone, 09:30–12:00 ET, Monday–Friday. This
 * is the highest-liquidity stretch of the US cash session — the open drive and
 * the first reversal — where 1m setups have the cleanest follow-through. Narrow
 * or widen `windows` to match the exact strategy you're trading.
 */
export function defaultSessionConfig(): SessionConfig {
  return {
    enabled: true,
    timezone: "America/New_York",
    weekdays: [1, 2, 3, 4, 5],
    windows: [{ start: "09:30", end: "12:00", label: "NY open" }],
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Wall-clock (weekday, minutes-since-midnight) for a unix time in a timezone.
 * Uses Intl so DST is handled correctly (ET is UTC-4 in summer, UTC-5 in
 * winter) without pulling in a date library.
 */
function wallClock(unixSeconds: number, timezone: string): { weekday: number; minutes: number } {
  const d = new Date(unixSeconds * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = wdMap[get("weekday")] ?? 0;
  const hour = Number(get("hour")) % 24; // some environments render midnight as "24"
  const minute = Number(get("minute"));
  return { weekday, minutes: hour * 60 + minute };
}

/** True if the bar at `unixSeconds` falls inside an enabled trading window. */
export function inSession(unixSeconds: number, cfg: SessionConfig): boolean {
  if (!cfg.enabled) return true;
  const { weekday, minutes } = wallClock(unixSeconds, cfg.timezone);
  if (!cfg.weekdays.includes(weekday)) return false;
  return cfg.windows.some((w) => minutes >= toMinutes(w.start) && minutes < toMinutes(w.end));
}

/** The window a bar falls in, or null — handy for reasoning text. */
export function activeWindow(unixSeconds: number, cfg: SessionConfig): SessionWindow | null {
  const { minutes } = wallClock(unixSeconds, cfg.timezone);
  return cfg.windows.find((w) => minutes >= toMinutes(w.start) && minutes < toMinutes(w.end)) ?? null;
}

/** Compact human description, e.g. "09:30–12:00 ET". */
export function describeSession(cfg: SessionConfig): string {
  if (!cfg.enabled) return "any time (session filter off)";
  const tz = cfg.timezone.split("/").pop()?.replace(/_/g, " ") ?? cfg.timezone;
  return cfg.windows.map((w) => `${w.start}–${w.end}`).join(", ") + ` ${tzAbbrev(cfg.timezone) || tz}`;
}

/** Best-effort short tz label (ET/CT/PT/UTC…) for display only. */
function tzAbbrev(timezone: string): string {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return s ?? "";
  } catch {
    return "";
  }
}
