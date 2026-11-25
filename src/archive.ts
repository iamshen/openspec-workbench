import { createTwoFilesPatch } from "diff";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readProposal } from "./catalog";
import { ACTIVE_INDEX, ARCHIVE_INDEX, addArchivedRow, markTasksDone, referencesTo, removeActiveRow, rewriteLinks, ResolveWiki, taskRecord } from "./markdown";
import { archiveFolder, changeFolder, checkChangeId, checkProjectDirectories, dateLabel, expectedArchiveName, OpenSpecProject } from "./project";
import { CliSettings, exists, inVault, message, OpenSpecCli, readText, replaceText, sha, vaultRelative, walk } from "./storage";

export const archiveTypes = {
  complete: { label: "已完成", fields: ["实际交付范围", "验收结果", "待验证事项"] },
  historical: { label: "历史方案", fields: ["原适用范围和状态"] },
  withdrawn: { label: "撤回提案", fields: ["撤回决定", "已知原因"] },
  collected: { label: "历史收拢", fields: ["原实施和验证状态"] },
} as const;

export type ArchiveType = keyof typeof archiveTypes;

export interface ArchiveRequest {
  id: string;
  type: ArchiveType;
  fields: string[];
  deliveryConfirmed: boolean;
  taskSelection?: { revision: string; lines: number[] };
}

interface TextWrite {
  path: string;
  before: string | null;
  after: string;
}

interface TaskWrite extends TextWrite {
  before: string;
}

interface SpecEdit {
  path: string;
  before: string | null;
  after: string | null;
}

type Tree = Record<string, string>;

interface Inputs {
  change: Tree;
  specs: Tree;
  config: string | null;
  schemas: Tree;
}

interface ArchiveResult {
  root?: { path: string };
  archive?: { archivedAs: string; specsUpdated: boolean; warnings?: string[] };
  status?: { message: string; fix?: string }[];
}

export interface PendingArchive {
  id: string;
  archiveName?: string;
  inputs: Inputs;
  expectedSpecs: Tree;
  writes: TextWrite[];
  external: string[];
  notices: string[];
  taskWrite?: TaskWrite;
  movedVerified?: boolean;
}

export interface ArchivePreview extends PendingArchive {
  request: ArchiveRequest;
  date: string;
  archiveName: string;
  destination: string;
  manageIndexes: boolean;
  cli: OpenSpecCli;
  specs: SpecEdit[];
  remainingTasks?: number;
}

export interface ArchiveOutcome {
  archived: boolean;
  folder: string;
  documentError?: string;
  external: string[];
  notices: string[];
}

interface ArchiveStorage {
  pending: () => PendingArchive | undefined;
  save: (value: PendingArchive | undefined) => Promise<void>;
}


async function tree(folder: string): Promise<Tree> {
  if (await exists(folder) && !(await fs.lstat(folder)).isDirectory()) {
    throw new Error("目录不可用：" + folder);
  }
  const files = await walk(folder);
  return Object.fromEntries(await Promise.all(files.map(async (file) =>
    [vaultRelative(folder, file), sha(await fs.readFile(file))])));
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function inputs(vault: string, id: string): Promise<Inputs> {
  const [change, specs, config, schemas] = await Promise.all([
    tree(path.join(vault, changeFolder(id))),
    tree(path.join(vault, "specs")),
    readText(path.join(vault, "config.yaml")),
    tree(path.join(vault, "schemas")),
  ]);
  if (!change["proposal.md"]) throw new Error("找不到活动提案：" + id);
  return { change, specs, config: config === null ? null : sha(config), schemas };
}

async function selectedTaskWrite(project: OpenSpecProject, request: ArchiveRequest, current: Inputs): Promise<TaskWrite | undefined> {
  const selection = request.taskSelection;
  if (request.type !== "complete" || !selection?.lines.length) return undefined;
  const taskPath = project.prefix + changeFolder(request.id) + "/tasks.md";
  const before = await readText(path.join(project.vault, taskPath));
  if (before === null || sha(before) !== selection.revision || current.change["tasks.md"] !== selection.revision) {
    throw new Error("任务列表已变化，请重新打开归档窗口。");
  }
  return { path: taskPath, before, after: markTasksDone(before, selection.lines) };
}

function archiveArgs(request: ArchiveRequest) {
  return ["archive", request.id, "--yes", ...(request.type === "complete" ? [] : ["--skip-specs"])];
}

export function patch(file: { path: string; before: string | null; after: string | null }): string {
  return createTwoFilesPatch(file.before === null ? "/dev/null" : file.path,
    file.after === null ? "/dev/null" : file.path, file.before ?? "", file.after ?? "", "", "", { context: 3 });
}

function journal(preview: ArchivePreview): PendingArchive {
  const { id, archiveName, inputs, expectedSpecs, writes, external, notices, taskWrite } = preview;
  return { id, archiveName, inputs, expectedSpecs, writes, external, notices, taskWrite };
}

export class ArchiveService {
  private working = false;

  constructor(
    readonly project: OpenSpecProject,
    private readonly settings: () => CliSettings & { xrzcIndexes: boolean },
    private readonly storage: ArchiveStorage,
    private readonly resolveWiki?: ResolveWiki,
  ) {}

  get workspace() {
    return this.project.workspace;
  }

  get manageIndexes() {
    return this.settings().xrzcIndexes;
  }

  get busy() {
    return this.working;
  }

  async cli() {
    return OpenSpecCli.locate(this.settings(), this.workspace);
  }

  async existingArchive(id: string): Promise<string | undefined> {
    checkChangeId(id);
    await checkProjectDirectories(this.project);
    const folder = archiveFolder(expectedArchiveName(id));
    return await exists(path.join(this.project.root, folder)) ? this.project.prefix + folder : undefined;
  }

  async preview(request: ArchiveRequest): Promise<ArchivePreview> {
    if (this.storage.pending()) throw new Error("请先处理上一次归档的文档更新。");
    const { id, type } = request;
    if (!archiveTypes[type]) throw new Error("请选择归档类型。");
    const existing = await this.existingArchive(id);
    if (existing) throw new Error("归档目录已存在：" + existing);
    const { root, prefix } = this.project;
    const manageIndexes = this.manageIndexes;
    const proposal = await readProposal(this.project, changeFolder(id), manageIndexes);
    if (!proposal) throw new Error("找不到活动提案：" + id);
    if (type === "complete" && !request.deliveryConfirmed) {
      throw new Error("请确认实际交付与验收范围。");
    }
    const labels = archiveTypes[type].fields;
    if (labels.some((_, index) => !(type === "withdrawn" && index === 1) && !request.fields[index]?.trim())) {
      throw new Error("请填写归档说明中的必填项。");
    }

    const current = await inputs(root, id);
    const taskWrite = await selectedTaskWrite(this.project, request, current);
    const date = dateLabel(manageIndexes ? "Asia/Shanghai" : undefined);
    const archiveName = expectedArchiveName(id);
    const cli = await this.cli();
    const scratch = await fs.mkdtemp(path.join(tmpdir(), "openspec-workbench-"));
    const copy = path.join(scratch, "openspec");
    try {
      await fs.mkdir(path.join(copy, "changes"), { recursive: true });
      await Promise.all(["config.yaml", "specs", "schemas", changeFolder(id)].map(async (relative) => {
        const source = path.join(root, relative);
        if (await exists(source)) await fs.cp(source, path.join(copy, relative), { recursive: true });
      }));
      if (!same(await inputs(copy, id), current)) throw new Error("文件已修改，请重新预览。");
      if (taskWrite) await replaceText(path.join(copy, taskWrite.path.slice(prefix.length)), taskWrite.before, taskWrite.after);

      const result = await cli.json<ArchiveResult>(archiveArgs(request), scratch);
      if (result.archive?.archivedAs !== archiveName) throw new Error("OpenSpec 归档目录已变化，请重新预览。");
      const destination = prefix + archiveFolder(archiveName);
      const expectedSpecs = await tree(path.join(copy, "specs"));
      if (type !== "complete" && !same(current.specs, expectedSpecs)) throw new Error("历史归档预演修改了正式规范。");
      const specs: SpecEdit[] = [];
      for (const relative of new Set([...Object.keys(current.specs), ...Object.keys(expectedSpecs)])) {
        if (current.specs[relative] === expectedSpecs[relative]) continue;
        const file = "specs/" + relative;
        const [before, after] = await Promise.all([readText(path.join(root, file)), readText(path.join(copy, file))]);
        specs.push({ path: prefix + file, before, after });
      }
      if (!same(await inputs(root, id), current)) throw new Error("文件已修改，请重新预览。");
      const { writes, notices } = await this.documentWrites(request,
        { archiveName, date, manageIndexes, repository: proposal.repository, specs, taskWrite });
      const external = await this.externalLinks(id, manageIndexes);
      const remainingTasks = type === "complete"
        ? (taskWrite ? taskRecord(taskWrite.after) : proposal.progress).open.length
        : undefined;
      return { id, inputs: current, expectedSpecs, writes, notices: [...(result.archive.warnings ?? []), ...notices],
        external, request, date, archiveName, destination, manageIndexes, cli, specs, taskWrite, remainingTasks };
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }

  async confirm(preview: ArchivePreview, beforeMove?: () => Promise<void>): Promise<ArchiveOutcome> {
    return this.exclusive(async () => {
      if (this.storage.pending()) throw new Error("请先处理上一次归档的文档更新。");
      const { id, request, archiveName, date, manageIndexes, specs, taskWrite } = preview;
      const existing = await this.existingArchive(id);
      if (existing) throw new Error("归档目录已存在：" + existing);
      // 先确认 CLI 确实选中了当前 Vault 所属项目，再执行归档。
      await preview.cli.json(["list"], this.workspace);
      if (this.manageIndexes !== manageIndexes || expectedArchiveName(id) !== archiveName ||
          dateLabel(manageIndexes ? "Asia/Shanghai" : undefined) !== date ||
          !same(await inputs(this.project.root, id), preview.inputs)) {
        throw new Error("归档设置、日期或文件已变化，请重新预览。");
      }
      const proposal = await readProposal(this.project, changeFolder(id), manageIndexes);
      const fresh = await this.documentWrites(request,
        { archiveName, date, manageIndexes, repository: proposal?.repository ?? "", specs, taskWrite });
      if (!same(fresh.writes, preview.writes) || !same(await this.externalLinks(id, manageIndexes), preview.external)) {
        throw new Error("索引或相关链接已变化，请重新预览。");
      }
      await beforeMove?.();
      const pending = journal(preview);
      await this.storage.save(pending);
      let archiveStarted = false;
      try {
        const task = pending.taskWrite;
        if (task) await replaceText(inVault(this.project.vault, task.path), task.before, task.after);
        archiveStarted = true;
        const result = await preview.cli.json<ArchiveResult>(archiveArgs(request), this.workspace);
        if (result.archive?.archivedAs !== archiveName) throw new Error("OpenSpec 返回了不同的归档目录。");
      } catch (error) {
        try {
          if (archiveStarted) await this.clearUnmoved(pending);
          else await this.storage.save(undefined);
        } catch (recoveryError) {
          throw new Error(message(error) + "\n恢复归档前状态失败：" + message(recoveryError));
        }
        throw error;
      }
      return this.finish(pending);
    });
  }

  async resume(): Promise<ArchiveOutcome> {
    return this.exclusive(async () => {
      const pending = this.storage.pending();
      if (!pending) throw new Error("没有待更新的归档文档。");
      checkChangeId(pending.id);
      if (pending.archiveName) checkChangeId(pending.archiveName);
      await checkProjectDirectories(this.project);
      if (await this.clearUnmoved(pending)) {
        return { archived: false, folder: "", external: [], notices: [] };
      }
      return this.finish(pending);
    });
  }

  private async clearUnmoved(pending: PendingArchive): Promise<boolean> {
    const task = pending.taskWrite;
    const target = archiveFolder(pending.archiveName ?? pending.id);
    if (pending.movedVerified || (!task && await exists(path.join(this.project.root, target)))) return false;
    const current = await inputs(this.project.root, pending.id).catch(() => null);
    if (!current) return false;
    if (task && current.change["tasks.md"] === sha(task.after)) {
      // 提案仍在活动目录，且任务文件与本次写入一致时，撤回本次勾选。
      await replaceText(inVault(this.project.vault, task.path), task.after, task.before);
      current.change["tasks.md"] = sha(task.before);
    }
    if (!same(current, pending.inputs)) return false;
    await this.storage.save(undefined);
    return true;
  }

  private async exclusive(operation: () => Promise<ArchiveOutcome>): Promise<ArchiveOutcome> {
    if (this.working) throw new Error("正在处理另一份归档。");
    this.working = true;
    try {
      return await operation();
    } finally {
      this.working = false;
    }
  }

  private async finish(pending: PendingArchive): Promise<ArchiveOutcome> {
    const { id, external, notices } = pending;
    const { vault, root, prefix } = this.project;
    const target = archiveFolder(pending.archiveName ?? id);
    const folder = prefix + target;
    if (await exists(path.join(root, changeFolder(id))) ||
        !await exists(path.join(root, target, "proposal.md"))) {
      throw new Error("无法确认提案已移入归档，请核对活动目录和归档目录：" + id);
    }
    try {
      if (!pending.movedVerified) {
        const actualSpecs = await tree(path.join(root, "specs"));
        if (!same(actualSpecs, pending.expectedSpecs)) throw new Error("正式规范与预览不一致，请核对 specs/。");
        await this.storage.save({ ...pending, movedVerified: true });
      }
      const base = await fs.realpath(vault);
      for (const write of pending.writes) {
        const file = inVault(base, write.path);
        const parent = await fs.realpath(path.dirname(file));
        inVault(base, vaultRelative(base, path.join(parent, path.basename(file))));
        await replaceText(file, write.before, write.after);
      }
      await this.storage.save(undefined);
      return { archived: true, folder, external, notices };
    } catch (error) {
      return { archived: true, folder, documentError: message(error), external, notices };
    }
  }

  private async documentWrites(request: ArchiveRequest, plan: {
    archiveName: string; date: string; manageIndexes: boolean; repository: string; specs: SpecEdit[]; taskWrite?: TaskWrite;
  }) {
    const { id, type } = request;
    const { vault, prefix } = this.project;
    const { archiveName, date, manageIndexes, repository, specs, taskWrite } = plan;
    const from = prefix + changeFolder(id);
    const to = prefix + archiveFolder(archiveName);
    const writes: TextWrite[] = [];
    const notices: string[] = [];
    const documents = new Map<string, string>();
    const files = await walk(vault, true);
    await Promise.all(files.map(async (file) => {
      const content = await readText(file);
      if (content !== null) documents.set(vaultRelative(vault, file), content);
    }));
    if (taskWrite) {
      if (documents.get(taskWrite.path) !== taskWrite.before) throw new Error("任务文件已变化，请重新预览。");
      documents.set(taskWrite.path, taskWrite.after);
    }
    for (const edit of specs) {
      if (edit.after === null) documents.delete(edit.path);
      else documents.set(edit.path, edit.after);
    }

    const meta = archiveTypes[type];
    const values = meta.fields.map((label, index) => [label, request.fields[index]?.trim() ?? ""] as const)
      .filter(([, field]) => field);
    const archiveRecord = ["# 归档说明", "", "归档日期：" + date, "归档类型：" + meta.label, "",
      ...values.flatMap(([label, value]) => ["## " + label, "", value, ""])];
    const archiveDoc = from + "/archive.md";
    const prior = documents.get(archiveDoc);
    const newRecord = prior
      ? prior.trimEnd() + "\n\n---\n\n" + archiveRecord.join("\n")
      : archiveRecord.join("\n");
    const indexReplacements = new Map<string, string>();
    if (manageIndexes) {
      const activeKey = prefix + ACTIVE_INDEX;
      const archiveKey = prefix + ARCHIVE_INDEX;
      const activeIndex = documents.get(activeKey);
      const archiveIndex = documents.get(archiveKey);
      if (!activeIndex || !archiveIndex) throw new Error("当前 OpenSpec 目录缺少 Xrzc 活动索引或归档索引。");
      const summary = [meta.label, ...values.map(([label, value]) => label + "：" + value)].join("。 ");
      indexReplacements.set(activeKey, removeActiveRow(activeIndex, id));
      indexReplacements.set(archiveKey, addArchivedRow(archiveIndex, archiveName, date, repository, summary));
    }

    for (const [file, original] of [...documents].sort(([left], [right]) => left.localeCompare(right))) {
      const isMoved = file.startsWith(from + "/");
      const destination = isMoved ? to + file.slice(from.length) : file;
      const rebased = rewriteLinks(indexReplacements.get(file) ?? original, file, from, to, this.resolveWiki);
      if (type !== "complete" && file.startsWith(prefix + "specs/")) {
        if (rebased !== original) notices.push("正式规范中的引用需人工更新：" + file);
        continue;
      }
      const after = file === archiveDoc
        ? rewriteLinks(newRecord, file, from, to, this.resolveWiki)
        : rebased;
      if (after !== original) writes.push({ path: destination, before: original, after });
    }
    if (!documents.has(archiveDoc)) {
      writes.push({ path: to + "/archive.md", before: null,
        after: rewriteLinks(newRecord, archiveDoc, from, to, this.resolveWiki) });
    }
    return { writes, notices };
  }

  private async externalLinks(id: string, manageIndexes: boolean): Promise<string[]> {
    // 项目根已是 Vault 时，交接文档会像其他 Vault 内文件一样参与预览。
    if (!manageIndexes || this.project.prefix) return [];
    const handoff = path.join(this.workspace, "HANDOFF.MD");
    const documents = await walk(path.join(this.workspace, "docs"), true);
    if (await exists(handoff)) documents.unshift(handoff);
    const results = await Promise.all(documents.map(async (doc) => {
      const content = await readText(doc);
      if (content === null) return [];
      const relative = vaultRelative(this.project.vault, doc);
      return referencesTo(content, relative, changeFolder(id)).map((line) => vaultRelative(this.workspace, doc) + ":" + line);
    }));
    return results.flat().sort();
  }
}
