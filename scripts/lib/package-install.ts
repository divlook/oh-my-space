import { PACKAGE_NAME } from "./constants.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type UpdateCommand = {
  executable: PackageManager;
  args: string[];
};

export function packageInstallCommand(
  manager: PackageManager,
  { tag = "latest", scope = "global", dev = false }: { tag?: "latest" | "beta"; scope?: "global" | "project"; dev?: boolean } = {},
): UpdateCommand {
  const args = manager === "npm" ? ["install"] : manager === "yarn" && scope === "global" ? ["global", "add"] : ["add"];
  if (scope === "global" && manager !== "yarn") args.push("-g");
  if (scope === "project" && dev) args.push(manager === "npm" ? "--save-dev" : manager === "yarn" ? "--dev" : manager === "bun" ? "-d" : "-D");
  args.push(`${PACKAGE_NAME}@${tag}`);
  return { executable: manager, args };
}

export function formatCommand(command: UpdateCommand): string {
  return [command.executable, ...command.args].join(" ");
}

