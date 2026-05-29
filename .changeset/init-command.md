---
"oh-my-space": minor
---

Add the `oms init` command to scaffold a starter `oms.yaml` in the current directory. The generated file ships with a placeholder repo entry and a `# yaml-language-server: $schema=…` comment so YAML LSPs provide autocompletion and validation out of the box. `init` also registers `oms/` in `.gitignore` (marked with a `# managed by oms` comment, shared with `oms sync`), refuses to clobber an existing `oms.yaml`, and accepts `--force` to overwrite. The README's `oms.yaml` examples now include the schema comment as well.
