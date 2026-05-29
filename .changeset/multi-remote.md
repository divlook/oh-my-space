---
"oh-my-space": minor
---

Support multiple git remotes per source. The `oms.yaml` `url` field is replaced by a `remotes` mapping (which must include an `origin` entry), and `oms sync` configures every declared remote on the submodule. `fetch`, `pull`, and `push` accept a repeatable `--remote <name>` flag, and prompt to choose a remote interactively when one is not given (defaulting to `origin` on a non-interactive shell). `push` sets the upstream only for `origin` so `oms status` keeps measuring against it. This is a breaking manifest change; see docs/migrations/0.6.x-to-0.7.0.md.
