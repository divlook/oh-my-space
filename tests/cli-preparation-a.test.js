process.env.OMS_TEST_SHARD_NAMES = JSON.stringify([
  "the five offer-side commands register once and continue",
  "auto-initialization leaves a pinned commit alone when the baseline branch is ahead",
  "two fetch failures report the exit code and later aliases still run",
  "fetch retries one transient failure and succeeds without an error",
  "automatic initialization stops when Git refuses the baseline attachment",
]);
await import("./cli-preparation.contracts.js");
