## Context

The existing design intentionally keeps `oms skills` as a thin wrapper over Vercel Labs `npx skills add`. That remains the right seam: the external tool already handles source resolution, agent detection, project/global scope, symlink versus copy behavior, and updates. The problem is not installation mechanics; it is the source path passed to the external tool.

The `skills` CLI's discovery model is broader than the original `oms` assumption. Repository root discovery includes agent-specific skill directories, so the repository root is not a clean public package boundary when the repository also carries its own development-agent skills.

```text
Current source: divlook/oh-my-space

repo root
├── skills/oms-*              public oms skills
├── .opencode/skills/*        repository development skills
├── .codex/skills/*           repository development skills
└── .claude/skills/*          repository development skills

Result: public + development skills are discoverable together
```

The external tool also supports a path suffix source:

```text
Scoped source: divlook/oh-my-space/skills

repo root
└── skills/
    ├── oms-workspace
    ├── oms-pointer
    └── oms-branch

Result: only public oms skills are discoverable
```

## Decision

### Decision: Use the repository `skills/` source path

`oms skills` will advertise and delegate to:

```bash
npx skills add divlook/oh-my-space/skills
```

instead of:

```bash
npx skills add divlook/oh-my-space
```

This is shorter than the full GitHub tree URL, keeps the public command readable, and constrains discovery to the intended skill package boundary.

### Decision: Keep `oms skills` a thin external-tool wrapper

No custom installer is added. `oms skills --install [...args]` continues to resolve to the workspace root for project installs and then delegates to `npx skills add <source> [...args]` with inherited stdio. Extra arguments remain opaque pass-through values owned by the external tool.

Because extra arguments are opaque, `oms` does not special-case `--list` or any other pass-through flag. Outside a workspace, `oms skills --install --list` follows the same rule as any project-scoped install attempt: it fails unless `-g` or `--global` is present. Delegation-failure fallback text also remains the existing base manual command, now with the scoped source, rather than reconstructing user-provided extra arguments.

This preserves the previous division of responsibility:

- `oms`: knows the correct source path and workspace root.
- `skills`: knows installation targets, supported agents, symlink/copy mechanics, and prompts.

### Decision: Do not rely on `--skill` to fix list output

Testing showed `npx skills add divlook/oh-my-space --list --skill oms-workspace` still lists all discovered repository skills. Therefore the fix must change the source path, not add a filter flag.

## Alternatives Considered

### Full GitHub tree URL

```bash
npx skills add https://github.com/divlook/oh-my-space/tree/main/skills
```

This works, but it is too verbose for a primary command in README output and CLI guidance.

### Root source plus internal metadata on development skills

The `skills` CLI supports `metadata.internal: true`, which could hide development skills from normal discovery. That can be useful as defense-in-depth, but it requires modifying internal OpenSpec skills and still leaves the public package boundary implicit. The scoped source is simpler and more direct.

### Custom `oms skills` installer

A custom installer could support only selected targets such as Claude, Codex, OpenCode, Pi, plus a custom path. It would also make `oms` responsible for target path conventions, copying/symlinking, conflict handling, update behavior, and future agent support. That is disproportionate when the existing external tool already works with a scoped source.

## Risks / Trade-offs

- The scoped shorthand `divlook/oh-my-space/skills` depends on current `skills` source parsing behavior. This is mitigated by tests for delegated arguments and by a manual verification step that runs `npx skills add divlook/oh-my-space/skills --list`.
- Users who manually run the old root-source command may still see extra skills. Documentation and `oms skills` output should consistently show the scoped source.
- If future public skill groups are added outside `skills/`, they will not be included by default. That is intentional: public installable `oms` skills should live under `skills/`.
