process.env.OMS_TEST_SHARD_NAMES = JSON.stringify([
  "all eight preparing commands auto-initialize without changing root topology",
  "pull --all asks once and registers three aliases in one topology commit",
  "a partial delegated sync does not ask a second preparation question",
  "commands that presuppose local state refuse an unregistered alias without touching root state",
  "status, doctor, and record report an uninitialized alias without preparing it",
]);
await import("./cli-preparation.contracts.js");
