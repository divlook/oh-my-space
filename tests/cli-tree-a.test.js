process.env.OMS_TEST_SHARD_NAMES = JSON.stringify([
  "tree add starts at the canonical HEAD, prints one line, and leaves a detached canonical checkout detached",
  "tree add --from sets the start point, resumes an existing branch, and refuses --from on resume",
  "tree add refuses duplicate paths including foreign directories, invalid names, and unknown aliases",
  "tree add works offline and asserts the exclude entry idempotently with no root commit",
  "tree remove refuses a dirty worktree, force discards it, and both preserve the branch",
  "tree remove prunes a broken tree and cleans up empty parents through the namespace root",
]);
await import("./cli-tree.contracts.js");
