import nodeTest from "node:test";

const shard = process.env.OMS_TEST_SHARD?.match(/^(\d+)\/(\d+)$/);
const shardIndex = shard ? Number.parseInt(shard[1], 10) : 0;
const shardCount = shard ? Number.parseInt(shard[2], 10) : 1;
if (shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount) {
  throw new Error(`Invalid OMS_TEST_SHARD: ${process.env.OMS_TEST_SHARD}`);
}
let ordinal = 0;

/** Registers only the deterministic shard owned by the current test file. */
export default function shardedTest(...args) {
  const selected = ordinal % shardCount === shardIndex;
  ordinal += 1;
  if (selected) return nodeTest(...args);
  return undefined;
}
