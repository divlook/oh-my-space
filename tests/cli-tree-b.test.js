process.env.OMS_TEST_SHARD_NAMES = JSON.stringify([
  "tree remove refuses from inside the target tree and reports unknown trees",
  "tree remove deletes an empty foreign directory and refuses a non-empty one without force",
  "tree remove resolves omitted arguments interactively and fails non-interactively",
  "tree list reports state for healthy, broken, and foreign entries and is a no-op when empty",
  "tree-cwd guard refuses alias commands before any mutation while read-only commands stay available",
  "unsync refuses while inventory entries exist, force included, and proceeds after removal",
  "status --json exposes the trees array with filtering, broken entries, and foreign directories",
  "doctor reports broken trees with repair guidance and a missing exclude entry",
]);
await import("./cli-tree.contracts.js");
