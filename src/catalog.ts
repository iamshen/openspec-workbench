import * as path from "node:path";
import { entries, exists, readText, sha } from "./storage";
import { ACTIVE_INDEX, ARCHIVE_INDEX, indexRows, taskRecord } from "./markdown";
import { OpenSpecProject } from "./project";

export interface Proposal {
  id: string;
  folder: string;
  archived: boolean;
  title: string;
  repository: string;
  progress: ReturnType<typeof taskRecord>;
  taskRevision?: string;
  files: { label: string; path: string }[];
}

export function proposalAt(file: string, project: OpenSpecProject): string | undefined {
  if (!file.startsWith(project.prefix)) return undefined;
  const folder = /^(changes\/(?:archive\/)?[a-z0-9][a-z0-9-]*)(?:\/|$)/i.exec(file.slice(project.prefix.length))?.[1];
  return folder === "changes/archive" ? undefined : folder;
}

export async function readProposal(project: OpenSpecProject, folder: string, manageIndexes: boolean,
  repository?: string): Promise<Proposal | undefined> {
  const vault = project.root;
  const id = path.posix.basename(folder);
  const proposal = await readText(path.join(vault, folder, "proposal.md"));
  if (proposal === null) return undefined;
  const tasks = await readText(path.join(vault, folder, "tasks.md"));
  if (manageIndexes && repository === undefined) {
    const archived = folder.startsWith("changes/archive/");
    const index = await readText(path.join(vault, archived ? ARCHIVE_INDEX : ACTIVE_INDEX));
    if (index) {
      try {
        repository = indexRows(index, archived).find((row) => row.id === id)?.repository;
      } catch {
        // 索引格式问题由提案列表和归档预览提示。
      }
    }
  }
  const files = [{ label: "提案", path: folder + "/proposal.md" }];
  if (tasks !== null) files.push({ label: "任务", path: folder + "/tasks.md" });
  for (const [file, label] of [["design.md", "设计"], ["archive.md", "归档说明"]]) {
    if (await exists(path.join(vault, folder, file))) files.push({ label, path: folder + "/" + file });
  }
  return {
    id,
    folder,
    archived: folder.startsWith("changes/archive/"),
    title: /^#\s+(.+)$/m.exec(proposal)?.[1]?.trim() ?? id,
    repository: repository || /^\s*(?:-\s*)?(?:\*\*)?主仓库[：:]\s*(?:\*\*)?[`]?([\w.-]+)/m.exec(proposal)?.[1] || "",
    progress: taskRecord(tasks),
    taskRevision: tasks === null ? undefined : sha(tasks),
    files: files.map((file) => ({ ...file, path: project.prefix + file.path })),
  };
}

export async function usesXrzcIndexes(project: OpenSpecProject): Promise<boolean> {
  const active = await readText(path.join(project.root, ACTIVE_INDEX));
  if (!active?.includes("# Xrzc 工作空间 OpenSpec") || !active.includes("## 活动提案索引")) return false;

  const archived = await readText(path.join(project.root, ARCHIVE_INDEX));
  return Boolean(archived?.includes("## 归档提案"));
}

export async function catalog(project: OpenSpecProject, manageIndexes: boolean): Promise<{ proposals: Proposal[]; issues: string[] }> {
  const vault = project.root;
  const proposals: Proposal[] = [];
  const issues: string[] = [];
  for (const archived of [false, true]) {
    const indexFile = archived ? ARCHIVE_INDEX : ACTIVE_INDEX;
    let rows: ReturnType<typeof indexRows> = [];
    if (manageIndexes) {
      const index = await readText(path.join(vault, indexFile));
      if (index === null) {
        issues.push("缺少索引 " + indexFile);
      } else {
        try {
          rows = indexRows(index, archived);
        } catch (error) {
          issues.push(indexFile + " · " + (error as Error).message);
        }
      }
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const directory = archived ? "changes/archive" : "changes";
    const folders = (await entries(path.join(vault, directory)))
      .filter((entry) => entry.isDirectory() && entry.name !== "archive");
    const found = await Promise.all(folders.map((entry) =>
      readProposal(project, directory + "/" + entry.name, manageIndexes, byId.get(entry.name)?.repository ?? "")));
    for (const item of found) {
      if (!item) continue;
      proposals.push(item);
      if (manageIndexes && !byId.has(item.id)) issues.push(indexFile + " 缺少 " + item.id);
    }
    const indexLinks = new Set(rows.flatMap((row) => row.links));
    await Promise.all([...indexLinks].map(async (link) => {
      if (!await exists(path.resolve(vault, link))) issues.push(indexFile + " 链接失效 " + link);
    }));
  }
  proposals.sort((left, right) => right.id.localeCompare(left.id));
  return { proposals, issues: issues.sort() };
}

interface ValidationIssue {
  level?: string;
  path?: string;
  message: string;
}

export interface Validation {
  root?: { path: string };
  items?: { valid: boolean; issues: ValidationIssue[] }[];
  status?: { message: string; fix?: string }[];
}
