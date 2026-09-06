export interface EscalationPolicy {
  /** Level at which the intervention removes tool affordances. */
  max_injections: number;
  /** Consecutive clean requests that reduce the level by one. */
  decay_after_clean: number;
}

interface Entry {
  injections: number;
  clean_run: number;
  last_seen_at: number;
}

const ENTRY_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * Per-conversation escalation state.
 *
 * Escalation is faster than decay on purpose: a stall adds one level, while
 * removing one costs a whole run of consecutive clean requests. A model that
 * emits a single unrelated call between stalls therefore still climbs, while a
 * model that genuinely recovers returns to zero and is forgotten.
 *
 * Entries are replaced rather than mutated, and a conversation at level zero
 * holds no entry at all.
 */
export class LoopEscalation {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  get size(): number {
    return this.entries.size;
  }

  recordStall(conversation_id: string, policy: EscalationPolicy): number {
    const now = this.clock();
    const current = this.live(conversation_id, now);
    const next: Entry = {
      injections: current.injections + 1,
      clean_run: 0,
      last_seen_at: now,
    };
    this.entries.set(conversation_id, next);
    this.evict(now);
    return Math.min(next.injections, Math.max(policy.max_injections, 1));
  }

  recordClean(conversation_id: string, policy: EscalationPolicy): void {
    const now = this.clock();
    const current = this.live(conversation_id, now);
    if (current.injections === 0) {
      this.entries.delete(conversation_id);
      return;
    }
    const clean_run = current.clean_run + 1;
    const decayed = clean_run >= policy.decay_after_clean;
    const injections = decayed ? current.injections - 1 : current.injections;
    if (injections === 0) {
      this.entries.delete(conversation_id);
      return;
    }
    this.entries.set(conversation_id, {
      injections,
      clean_run: decayed ? 0 : clean_run,
      last_seen_at: now,
    });
  }

  /** Reads an entry, treating one older than the TTL as absent. */
  private live(conversation_id: string, now: number): Entry {
    const entry = this.entries.get(conversation_id);
    if (entry === undefined || now - entry.last_seen_at > ENTRY_TTL_MS) {
      this.entries.delete(conversation_id);
      return { injections: 0, clean_run: 0, last_seen_at: now };
    }
    return entry;
  }

  private evict(now: number): void {
    if (this.entries.size <= MAX_ENTRIES) {
      return;
    }
    for (const [key, entry] of this.entries) {
      if (now - entry.last_seen_at > ENTRY_TTL_MS) {
        this.entries.delete(key);
      }
    }
    const oldest = [...this.entries.entries()].sort(
      (left, right) => left[1].last_seen_at - right[1].last_seen_at,
    );
    for (const [key] of oldest) {
      if (this.entries.size <= MAX_ENTRIES / 2) {
        break;
      }
      this.entries.delete(key);
    }
  }
}
