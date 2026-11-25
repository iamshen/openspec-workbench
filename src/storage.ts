import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface CliSettings {
  nodePath: string;
  cliPath: string;
}

interface CliResult {
  root?: { path: string };
  status?: { message: string; fix?: string }[];
}

export const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export async function entries(folder: string) {
  try {
    return await fs.readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

export async function walk(folder: string, markdownOnly = false): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await entries(folder)) {
    if (markdownOnly && (entry.name.startsWith(".") || entry.name === "node_modules")) continue;
    if (entry.isSymbolicLink()) {
      if (!markdownOnly) throw new Error("OpenSpec 目录包含文件链接，无法复制预演：" + entry.name);
      continue;
    }
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file, markdownOnly));
    if (entry.isFile() && (!markdownOnly || /\.md$/i.test(file))) files.push(file);
  }
  return files.sort();
}

export function vaultRelative(base: string, file: string): string {
  return path.relative(base, file).split(path.sep).join("/");
}

export function inVault(base: string, relative: string): string {
  const file = path.resolve(base, relative);
  const suffix = vaultRelative(base, file);
  if (!suffix || suffix === ".." || suffix.startsWith("../") || path.isAbsolute(suffix)
      || suffix.split("/").some((segment) => segment.startsWith("."))) {
    throw new Error("归档文档路径超出 Vault 范围：" + relative);
  }
  return file;
}

export async function replaceText(file: string, before: string | null, after: string): Promise<void> {
  if (await exists(file) && (await fs.lstat(file)).isSymbolicLink()) {
    throw new Error("待更新的文件变成了链接：" + file);
  }
  const current = await readText(file);
  if (current === after) return;
  if (current !== before) throw new Error("文件已修改：" + file);
  const temporary = path.join(path.dirname(file), ".openspec-workbench-" + randomUUID() + ".tmp");
  try {
    await fs.writeFile(temporary, after, { flag: "wx" });
    if (before === null) {
      await fs.link(temporary, file);
    } else {
      if (await readText(file) !== before) throw new Error("文件已修改：" + file);
      await fs.rename(temporary, file);
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function where(executable: string, cwd: string): Promise<string[]> {
  const whereExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
  try {
    const result = await run(whereExe, ["$PATH:" + executable], { cwd, windowsHide: true, timeout: 5000 });
    return result.stdout.trim().split(/\r?\n/).filter((candidate) => path.isAbsolute(candidate));
  } catch {
    return [];
  }
}

export class OpenSpecCli {
  constructor(readonly executable: string, readonly entry: string) {}

  static async locate(settings: CliSettings, cwd: string): Promise<OpenSpecCli> {
    const nodePath = settings.nodePath.trim() || (await where("node.exe", cwd))[0];
    if (!nodePath || !path.isAbsolute(nodePath) || !await exists(nodePath)) {
      throw new Error("找不到 Node.js。请在插件设置中填写 node.exe 的完整路径。");
    }

    const shims = settings.cliPath.trim() ? [] : await where("openspec.cmd", cwd);
    const prefixes = [...shims.map((shim) => path.dirname(shim)), path.dirname(nodePath)];
    if (process.env.APPDATA) prefixes.push(path.join(process.env.APPDATA, "npm"));
    const candidates = settings.cliPath.trim()
      ? [settings.cliPath.trim()]
      : prefixes.map((prefix) => path.join(prefix, "node_modules", "@fission-ai", "openspec", "bin", "openspec.js"));
    for (const entry of new Set(candidates)) {
      if (path.isAbsolute(entry) && await exists(entry)) return new OpenSpecCli(nodePath, entry);
    }
    throw new Error("找不到 OpenSpec CLI。请在插件设置中填写 openspec.js 的完整路径。");
  }

  async version(cwd: string): Promise<string> {
    const result = await this.invoke(["--version"], cwd);
    if (result.failed || !result.stdout.trim()) throw new Error(result.stderr.trim() || "无法读取 OpenSpec CLI 版本。");
    return result.stdout.trim();
  }

  async json<T extends CliResult>(args: string[], cwd: string, allowFindings = false): Promise<T> {
    const { stdout, stderr, failed } = await this.invoke(["--no-color", ...args, "--json"], cwd);
    let result: T;
    try {
      result = JSON.parse(stdout) as T;
    } catch {
      throw new Error(stderr.trim() || stdout.trim() || "OpenSpec CLI 没有返回可读取的结果。");
    }
    if (failed && (!allowFindings || !result.root)) {
      const details = result.status?.map((item) => [item.message, item.fix].filter(Boolean).join("\n")).join("\n");
      throw new Error(details || stderr.trim() || "OpenSpec CLI 执行失败。");
    }
    const actualRoot = result.root?.path;
    if (!actualRoot || path.relative(await fs.realpath(cwd), await fs.realpath(actualRoot)) !== "") {
      throw new Error("OpenSpec CLI 识别到的工作空间与当前 Vault 不一致。");
    }
    return result;
  }

  private async invoke(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; failed: boolean }> {
    try {
      const result = await run(this.executable, [this.entry, ...args], {
        cwd,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, DO_NOT_TRACK: "1", NO_COLOR: "1" },
      });
      return { ...result, failed: false };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
      if (typeof failure.stdout === "string" && !failure.killed && typeof failure.code === "number") {
        return { stdout: failure.stdout, stderr: failure.stderr ?? "", failed: true };
      }
      throw new Error("无法运行 OpenSpec CLI：" + message(error));
    }
  }
}
