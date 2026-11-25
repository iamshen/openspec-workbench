import * as fs from "node:fs/promises";
import * as path from "node:path";
import { missing } from "./storage";

export interface OpenSpecProject {
  vault: string;
  root: string;
  workspace: string;
  prefix: "" | "openspec/";
}

const datedId = /^\d{4}-\d{2}-\d{2}-/;

export function changeFolder(id: string): string {
  return "changes/" + id;
}

export function archiveFolder(archiveName: string): string {
  return "changes/archive/" + archiveName;
}

export function dateLabel(timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"].map((name) => parts.find((part) => part.type === name)?.value).join("-");
}

export function expectedArchiveName(id: string): string {
  return datedId.test(id) ? id : dateLabel() + "-" + id;
}

export function checkChangeId(id: string): void {
  if (id === "archive" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error("提案目录名应使用小写字母、数字和单连字符。");
  }
}

async function isDirectory(folder: string): Promise<boolean> {
  try {
    return (await fs.lstat(folder)).isDirectory();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export async function checkProjectDirectories(project: OpenSpecProject): Promise<void> {
  for (const relative of ["", "changes", "changes/archive", "specs", "schemas"]) {
    const folder = path.join(project.root, relative);
    try {
      if (!(await fs.lstat(folder)).isDirectory()) {
        throw new Error("OpenSpec 路径需要使用实际目录：" + folder);
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}

export async function locateProject(vault: string): Promise<OpenSpecProject> {
  const nested = path.join(vault, "openspec");
  // CLI 从项目根识别 openspec 目录。直接打开 openspec 时需使用上一层作为工作目录。
  if (path.basename(vault).toLowerCase() === "openspec" && !await isDirectory(nested)) {
    return { vault, root: vault, workspace: path.dirname(vault), prefix: "" };
  }
  return { vault, root: nested, workspace: vault, prefix: "openspec/" };
}
