import nodeTest from "node:test";

const shard = process.env.OMS_TEST_SHARD?.match(/^(\d+)\/(\d+)$/);
const shardIndex = shard ? Number.parseInt(shard[1], 10) : 0;
const shardCount = shard ? Number.parseInt(shard[2], 10) : 1;
if (shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount) {
  throw new Error(`Invalid OMS_TEST_SHARD: ${process.env.OMS_TEST_SHARD}`);
}
const namedShard = process.env.OMS_TEST_SHARD_NAMES
  ? new Set(JSON.parse(process.env.OMS_TEST_SHARD_NAMES))
  : null;
if (namedShard && [...namedShard].some((name) => typeof name !== "string")) {
  throw new Error("OMS_TEST_SHARD_NAMES must be a JSON array of contract names.");
}
let ordinal = 0;

/** Registers only the deterministic shard owned by the current test file. */
export default function shardedTest(...args) {
  const selected = namedShard ? namedShard.has(args[0]) : ordinal % shardCount === shardIndex;
  ordinal += 1;
  if (selected) return nodeTest(...args);
  return undefined;
}
