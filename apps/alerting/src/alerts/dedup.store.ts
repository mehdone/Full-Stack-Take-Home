/**
 * Bounded LRU in-memory deduplification set for business alerts.
 *
 * The outbox relay delivers at-least-once, so the alerting receiver must
 * suppress duplicates. We dedupe on (event_type + payload.batch_id), which
 * covers the common retry path (relay retries a row it already delivered but
 * failed to mark processed because of a network blip).
 *
 * This is intentionally an in-memory set — durability is not required because
 * the alerting service is a stub sink. On restart, the worst case is one extra
 * log line per outstanding outbox row that was delivered before the restart.
 *
 * Max size is 10 000 entries. When the cap is reached, the oldest 10 % of
 * entries are evicted (a simple LRU approximation using insertion-ordered Map).
 */
export class DedupStore {
  private readonly keys = new Map<string, number>(); // key → timestamp
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  /** Returns true if the key is new (first time seen). */
  add(key: string): boolean {
    if (this.keys.has(key)) {
      return false;
    }
    if (this.keys.size >= this.maxSize) {
      // Evict oldest 10 % to amortise the cost of eviction.
      const evictCount = Math.ceil(this.maxSize * 0.1);
      let evicted = 0;
      for (const k of this.keys.keys()) {
        this.keys.delete(k);
        if (++evicted >= evictCount) break;
      }
    }
    this.keys.set(key, Date.now());
    return true;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  get size(): number {
    return this.keys.size;
  }
}
