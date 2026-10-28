import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_PROCESSED_IDS = 5000;

export interface PendingReply {
  id: string; // inbound message/comment id
  kind: "message" | "comment";
  targetId: string; // PSID for messages, comment id for comments
  fromName: string;
  inboundText: string;
  reply: string;
  isHotLead: boolean;
  createdAt: string;
}

interface AgentStateData {
  startedAt: string;
  processedIds: string[];
  pending: PendingReply[];
  lastRun: Record<string, string>;
  targetIndex: number;
  stats: { repliesSent: number; hotLeads: number; postsPublished: number; leadsFound: number };
}

/**
 * Durable daemon state: which inbound items were already handled (so a
 * restart never double-replies), replies awaiting approval, and when each
 * scheduled task last ran (so restarts don't re-post or re-search early).
 */
export class AgentState {
  private data: AgentStateData;

  constructor(private readonly path: string, now = new Date()) {
    const loaded = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<AgentStateData>) : {};
    this.data = {
      startedAt: loaded.startedAt ?? now.toISOString(),
      processedIds: loaded.processedIds ?? [],
      pending: loaded.pending ?? [],
      lastRun: loaded.lastRun ?? {},
      targetIndex: loaded.targetIndex ?? 0,
      stats: loaded.stats ?? { repliesSent: 0, hotLeads: 0, postsPublished: 0, leadsFound: 0 },
    };
  }

  /** Inbound items older than the agent's first start are history, not new conversations. */
  get startedAt(): number {
    return new Date(this.data.startedAt).getTime();
  }

  get stats() {
    return this.data.stats;
  }

  isProcessed(id: string): boolean {
    return this.data.processedIds.includes(id);
  }

  markProcessed(id: string): void {
    this.data.processedIds.push(id);
    if (this.data.processedIds.length > MAX_PROCESSED_IDS) {
      this.data.processedIds.splice(0, this.data.processedIds.length - MAX_PROCESSED_IDS);
    }
  }

  isDue(task: string, intervalHours: number, now = new Date()): boolean {
    if (intervalHours <= 0) return false;
    const last = this.data.lastRun[task];
    return !last || now.getTime() - new Date(last).getTime() >= intervalHours * 60 * 60 * 1000;
  }

  markRan(task: string, now = new Date()): void {
    this.data.lastRun[task] = now.toISOString();
  }

  nextTargetIndex(count: number): number {
    const i = this.data.targetIndex % count;
    this.data.targetIndex = (i + 1) % count;
    return i;
  }

  pending(): PendingReply[] {
    return [...this.data.pending];
  }

  addPending(p: PendingReply): void {
    this.data.pending.push(p);
  }

  takePending(id: string): PendingReply | undefined {
    const idx = this.data.pending.findIndex((p) => p.id === id);
    return idx === -1 ? undefined : this.data.pending.splice(idx, 1)[0];
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}
