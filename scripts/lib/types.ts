export type Repo = {
  alias: string;
  /** Named git remotes; must include "origin". Maps remote name to its clonable URL. */
  remotes: Record<string, string>;
  branch?: string;
};

export type SourcesOptions = {
  all?: boolean;
  list?: boolean;
};

export type UnsyncOptions = SourcesOptions & {
  force?: boolean;
  commit?: boolean;
};

export type PushOptions = {
  commit?: boolean;
  record?: boolean;
};

export type StatusOptions = SourcesOptions & {
  json?: boolean;
};

export type CommitOptions = {
  /** Repeated -m values, passed through to the submodule's git commit. */
  message?: string[];
};

export type SyncCommitOptions = SourcesOptions & {
  commit?: boolean;
};

export type AgentTarget = "agents" | "claude" | "both";

export type AgentOptions = {
  /** Raw --target value from the CLI; validated to AgentTarget at runtime. */
  target?: string;
};

export type RemoteOptions = {
  /** Remote name(s) requested via repeatable --remote; empty/undefined means "resolve interactively or default to origin". */
  remote?: string[];
};

export type CheckoutOptions = {
  from?: string;
};

export type WorkspaceOptions = {
  cwd?: string;
};

export type UpdateOptions = {
  check?: boolean;
  yes?: boolean;
};

export type OperationResult =
  | "added"
  | "updated"
  | "fetched"
  | "pulled"
  | "pushed"
  | "unsynced"
  | "failed";

export type RemoveOutcome = "removed" | "nothing-to-remove" | "failed";

export type GitResult = {
  exitCode: number | null;
  success: boolean;
  stdout: string;
};

export type ManageCommand = "fetch" | "pull" | "push";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type InstallContextKind = "global" | "project" | "ephemeral" | "development" | "unknown";

export type UpdateCommand = {
  executable: PackageManager;
  args: string[];
};

export type InstallContext = {
  kind: InstallContextKind;
  label: string;
  manager?: PackageManager;
  updateCommand?: UpdateCommand;
  guidance: string[];
  warnings: string[];
};

export type RuntimeEvidence = {
  packageRoot: string;
  realPackageRoot: string;
  runningBin: string;
  realRunningBin: string;
  pathBin: string | null;
  realPathBin: string | null;
  packageName: string | null;
};
