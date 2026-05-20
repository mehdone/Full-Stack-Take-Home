/**
 * Unit tests for DedupStore.
 *
 * Covers:
 * 1. Adding new keys returns true
 * 2. Adding duplicate keys returns false
 * 3. Eviction happens when max size is exceeded
 * 4. Oldest entries are evicted (LRU semantics)
 */

import { DedupStore } from "../../src/alerts/dedup.store.ts";

describe("DedupStore", () => {
  it("returns true for new keys", () => {
    const store = new DedupStore(10);

    expect(store.add("key1")).toBe(true);
    expect(store.add("key2")).toBe(true);
    expect(store.size).toBe(2);
  });

  it("returns false for duplicate keys", () => {
    const store = new DedupStore(10);

    expect(store.add("key1")).toBe(true);
    expect(store.add("key1")).toBe(false);
    expect(store.size).toBe(1);
  });

  it("evicts oldest 10% when maxSize is exceeded", () => {
    const maxSize = 100;
    const store = new DedupStore(maxSize);

    // Fill to max
    for (let i = 0; i < maxSize; i++) {
      expect(store.add(`key${i}`)).toBe(true);
    }
    expect(store.size).toBe(maxSize);

    // Add one more, should trigger eviction
    expect(store.add(`key${maxSize}`)).toBe(true);

    // Size should be reduced by 10 + 1 new = max - 10 + 1
    const expectedSize = maxSize - Math.ceil(maxSize * 0.1) + 1;
    expect(store.size).toBe(expectedSize);

    // Oldest entries (key0-key9) should be evicted
    expect(store.has("key0")).toBe(false);
    expect(store.has("key9")).toBe(false);
    // Newer entries should still exist
    expect(store.has("key10")).toBe(true);
    expect(store.has(`key${maxSize}`)).toBe(true);
  });

  it("maintains has() consistency", () => {
    const store = new DedupStore(10);

    store.add("test");
    expect(store.has("test")).toBe(true);

    store.add("other");
    expect(store.has("test")).toBe(true);
    expect(store.has("other")).toBe(true);
    expect(store.has("nonexistent")).toBe(false);
  });

  it("supports large entries count with graceful eviction", () => {
    const maxSize = 10000;
    const store = new DedupStore(maxSize);

    // Add 10001 entries
    for (let i = 0; i < maxSize + 1; i++) {
      store.add(`batch_${i}`);
    }

    // Should be less than or equal to maxSize after eviction
    expect(store.size).toBeLessThanOrEqual(maxSize);
    // The newest entries should be present
    expect(store.has(`batch_${maxSize}`)).toBe(true);
  });
});
