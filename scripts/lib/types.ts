export type Repo = {
  alias: string;
  /** Named git remotes; must include "origin". Maps remote name to its clonable URL. */
  remotes: Record<string, string>;
  branch?: string;
};

export type WorkspaceMode = "submodule" | "worktree";

export type WorkspaceManifest = {
  mode: WorkspaceMode;
  repos: Repo[];
};

export type SourcesOptions = {
  all?: boolean;
  list?: boolean;
};

export type UnsyncOptions = SourcesOptions & {
  force?: boolean;
  commit?: boolean;
  /** Internal mode-switch OIDs already copied into verified staged target storage. */
  preservedOids?: Record<string, string[]>;
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
  /** Internal transition identity that permits journal-owned target sync. */
  modeSwitchTransitionId?: string;
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
  stderr: string;
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

export type StatusChanges = { staged: number; unstaged: number; untracked: number };
export type StatusError = { scope: "root" | "repo" | "worktree"; alias: string | null; target: string | null; message: string };
export type StatusRoot = {
  path: string;
  relation: "same" | "ancestor";
  branch: string | null;
  head: string | null;
  detached: boolean;
  dirty: boolean;
  changes: StatusChanges;
  submodulePointers?: { moved: string[]; staged: string[]; split: string[]; conflict: string[] };
};
export type SubmoduleStatusRepo = {
  mode: "submodule";
  alias: string;
  path: string;
  absolutePath: string;
  configured: true;
  initialized: boolean;
  branch: string | null;
  head: string | null;
  detached: boolean;
  trackingBranch: string | null;
  pin: "ok" | "moved" | "uninit" | "missing" | "conflict";
  dirty: boolean;
  changes: StatusChanges;
  ahead: number | null;
  behind: number | null;
  error: string | null;
};
type WorktreeStatusEntryBase = {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  trackingBranch: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  changes: StatusChanges;
  locked: boolean;
  operation: string | null;
  error: string | null;
};
export type ManagedWorktreeStatusEntry = WorktreeStatusEntryBase & {
  managed: true;
  name: string;
  target: string;
  relativePath: string;
};
export type ExternalWorktreeStatusEntry = WorktreeStatusEntryBase & {
  managed: false;
  name: null;
  target: null;
  relativePath: null;
};
export type WorktreeStatusEntry = ManagedWorktreeStatusEntry | ExternalWorktreeStatusEntry;
export type WorktreeStatusRepo = {
  mode: "worktree";
  alias: string;
  commonPath: string;
  absoluteCommonPath: string;
  ready: boolean;
  remotes: Array<{ name: string }>;
  worktrees: WorktreeStatusEntry[];
  error: string | null;
};
export type StatusRepo = SubmoduleStatusRepo | WorktreeStatusRepo;
export type StatusV2 = {
  schemaVersion: 2;
  toolVersion: string;
  mode: WorkspaceMode;
  workspaceRoot: string;
  currentAlias: string | null;
  currentWorktree: string | null;
  currentTarget: string | null;
  root: StatusRoot | null;
  repos: StatusRepo[];
  errors: StatusError[];
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
