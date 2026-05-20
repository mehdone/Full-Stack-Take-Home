-- batch-dedupe.lua
-- KEYS[1]: hash key  e.g. "ingest:dedupe:<site_slug>"
-- ARGV[1]: field     e.g. "<batch_id>"
-- ARGV[2]: ttl       e.g. "86400" (seconds)
--
-- Atomically:
--   1. HSETNX key field 1   → returns 1 on first write, 0 if already present
--   2. On first write: HEXPIRE key ttl FIELDS 1 field
--
-- Returns: 1 if this is the first time the batch_id was seen, 0 if duplicate.

local result = redis.call("HSETNX", KEYS[1], ARGV[1], "1")
if result == 1 then
  redis.call("HEXPIRE", KEYS[1], ARGV[2], "FIELDS", 1, ARGV[1])
end
return result
