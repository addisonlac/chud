/**
 * Bounds how many token evaluations run concurrently. The scanner can emit
 * new tokens far faster than the Birdeye/News/Groq/Jupiter calls in the
 * evaluation pipeline can complete, so without this an API-rate-limit
 * pile-up would be the very first thing that happens under real load —
 * Groq's free tier especially, which caps requests more tightly than a
 * paid Anthropic account would.
 */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
