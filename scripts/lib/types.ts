export type Repo = {
  alias: string;
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

export type StatusOptions = SourcesOptions & {
  json?: boolean;
};

export type CommitOptions = {
  message?: string[];
};

export type SyncCommitOptions = SourcesOptions & {
  commit?: boolean;
};

export type AgentTarget = "agents" | "claude" | "both";

export type AgentOptions = {
  target?: string;
};

export type RemoteOptions = {
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
  | "recorded"
  | "skipped"
  | "failed";

export type RemoveOutcome = "removed" | "nothing-to-remove" | "failed";

export type GitResult = {
  exitCode: number | null;
  success: boolean;
  stdout: string;
  stderr: string;
};

export type ManageCommand = "fetch" | "pull" | "push";
