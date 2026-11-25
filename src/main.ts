import { App, FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import * as path from "node:path";
import { ArchivePreview, ArchiveService, PendingArchive } from "./archive";
import { readProposal, proposalAt, usesXrzcIndexes } from "./catalog";
import { changeFolder, locateProject } from "./project";
import { CliSettings, message, readText } from "./storage";
import { ArchiveModal, CatalogModal, ProposalModal, showOutcome } from "./views";

interface PluginData extends CliSettings {
  xrzcIndexes?: boolean;
  pending?: PendingArchive;
}

export default class OpenSpecWorkbench extends Plugin {
  private data: PluginData = { nodePath: "", cliPath: "" };
  private saveQueue = Promise.resolve();
  private defaultXrzcIndexes = false;
  private archiveService?: ArchiveService;

  async onload() {
    this.data = { ...this.data, ...await this.loadData() };
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const project = await locateProject(adapter.getBasePath());
    this.defaultXrzcIndexes = this.data.xrzcIndexes === undefined && await usesXrzcIndexes(project);
    const service = new ArchiveService(project, () => ({ ...this.cliSettings(), xrzcIndexes: this.xrzcIndexes() }), {
      pending: () => this.data.pending,
      save: (pending) => this.persist({ pending }),
    }, (link, note) => this.app.metadataCache.getFirstLinkpathDest(link, note)?.path);
    this.archiveService = service;
    const activeFolder = () => proposalAt(this.app.workspace.getActiveFile()?.path ?? "", project);

    this.addCommand({ id: "find-change", name: "查找提案", callback: () => this.find() });
    this.addCommand({ id: "inspect-change", name: "检查提案",
      callback: () => {
        const folder = activeFolder();
        if (folder) void this.show(folder, false);
        else this.find();
      } });
    this.addCommand({ id: "archive-change", name: "归档提案",
      callback: () => {
        const folder = activeFolder();
        if (folder && !folder.startsWith("changes/archive/")) void this.show(folder, true);
        else this.find(true);
      } });
    this.addCommand({ id: "resume-archive", name: "继续更新归档文档",
      checkCallback: (checking) => {
        const pending = this.data.pending;
        if (!pending) return false;
        if (!checking) void this.resume();
        return true;
      } });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      const folder = proposalAt(file.path, project);
      if (!folder || folder.startsWith("changes/archive/") ||
          !this.app.vault.getFileByPath(project.prefix + folder + "/proposal.md")) return;
      menu.addItem((item) => item.setTitle("归档提案").setIcon("archive").onClick(() => this.show(folder, true)));
    }));

    this.addSettingTab(new OpenSpecSettings(this.app, this, service));
  }

  private find(archiveOnly = false) {
    const service = this.archiveService;
    if (!service) return;
    new CatalogModal(this.app, service, (item) => { void this.show(item.folder, archiveOnly); }, archiveOnly).open();
  }

  private async show(folder: string, archive: boolean) {
    const service = this.archiveService;
    if (!service) return;
    try {
      if (archive && this.data.pending) {
        this.recovery(this.data.pending.id);
        return;
      }
      const proposal = await readProposal(service.project, folder, service.manageIndexes);
      if (!proposal) throw new Error("找不到提案文件 " + folder + "/proposal.md");
      if (archive && !proposal.archived) {
        const existing = await service.existingArchive(proposal.id);
        if (existing) {
          this.showExistingArchive(existing);
          return;
        }
        new ArchiveModal(this.app, proposal, service,
          (preview) => service.confirm(preview, () => this.checkEditors(preview)),
          (file) => this.openNote(file)).open();
      } else {
        new ProposalModal(this.app, proposal, service, (file) => this.openNote(file),
          () => { void this.show(folder, true); }).open();
      }
    } catch (error) {
      new Notice(message(error));
    }
  }

  private showExistingArchive(folder: string) {
    const modal = new Modal(this.app);
    modal.setTitle("已有同名归档");
    modal.contentEl.createEl("p", { text: folder });
    const file = folder + "/proposal.md";
    if (this.app.vault.getFileByPath(file)) {
      const open = modal.contentEl.createEl("button", {
        text: "打开已有归档", cls: "mod-cta", attr: { type: "button" },
      });
      open.addEventListener("click", () => {
        modal.close();
        this.openNote(file);
      });
    }
    modal.open();
  }

  private async checkEditors(preview: ArchivePreview) {
    const service = this.archiveService;
    if (!service) return;
    const source = service.project.prefix + changeFolder(preview.id) + "/";
    const destination = preview.destination + "/";
    const updates = new Set([
      ...preview.specs.map((edit) => edit.path),
      ...preview.writes.map((edit) => edit.path.startsWith(destination) ? source + edit.path.slice(destination.length) : edit.path),
    ]);
    const open: { file: string; value: string }[] = [];
    this.app.workspace.iterateAllLeaves(({ view }) => {
      if (view instanceof MarkdownView && view.file && view.getMode() === "source" &&
          (view.file.path.startsWith(source) || updates.has(view.file.path))) {
        open.push({ file: view.file.path, value: view.editor.getValue() });
      }
    });
    for (const note of open) {
      const disk = await readText(path.join(service.project.vault, note.file));
      if (disk?.replace(/\r\n/g, "\n") !== note.value.replace(/\r\n/g, "\n")) {
        throw new Error("请先保存正在编辑的文件，再重新预览：" + note.file);
      }
    }
  }

  private openNote(file: string) {
    const note = this.app.vault.getFileByPath(file);
    if (!note) {
      new Notice("Obsidian 暂未读取文件：" + file);
      return;
    }
    void this.app.workspace.getLeaf(false).openFile(note);
  }

  private recovery(id: string) {
    const modal = new Modal(this.app);
    modal.setTitle("继续更新归档文档");
    modal.contentEl.createEl("p", { text: id });
    const button = modal.contentEl.createEl("button", { text: "继续更新", cls: "mod-cta", attr: { type: "button" } });
    button.addEventListener("click", () => {
      modal.close();
      void this.resume();
    });
    modal.open();
  }

  private async resume() {
    try {
      const service = this.archiveService;
      if (!service) return;
      const outcome = await service.resume();
      const modal = new Modal(this.app);
      modal.setTitle("归档结果");
      const render = () => showOutcome(modal.contentEl, outcome, (file) => {
        modal.close();
        this.openNote(file);
      }, async () => {
        modal.close();
        await this.resume();
      });
      render();
      modal.open();
    } catch (error) {
      new Notice(message(error));
    }
  }

  xrzcIndexes() {
    return this.data.xrzcIndexes ?? this.defaultXrzcIndexes;
  }

  cliSettings() {
    return { nodePath: this.data.nodePath, cliPath: this.data.cliPath };
  }

  persist(update: Partial<PluginData>): Promise<void> {
    const operation = this.saveQueue.then(async () => {
      const next = { ...this.data, ...update };
      await this.saveData(next);
      this.data = next;
    });
    this.saveQueue = operation.catch(() => {});
    return operation;
  }
}

class OpenSpecSettings extends PluginSettingTab {
  constructor(app: App, private readonly workbench: OpenSpecWorkbench, private readonly service: ArchiveService) {
    super(app, workbench);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const config = this.workbench.cliSettings();
    const settings = [
      { key: "nodePath", label: "Node.js 可执行文件", placeholder: "node.exe 的完整路径" },
      { key: "cliPath", label: "OpenSpec CLI 入口", placeholder: "openspec.js 的完整路径" },
    ] as const;
    for (const { key, label, placeholder } of settings) {
      new Setting(containerEl).setName(label).setDesc("留空时自动查找本机安装。")
        .addText((control) => {
          control.inputEl.setAttribute("aria-label", label);
          control.setPlaceholder(placeholder).setValue(config[key]).onChange((value) => {
            void this.workbench.persist({ [key]: value.trim() }).catch((error: unknown) => new Notice(message(error)));
          });
        });
    }
    new Setting(containerEl)
      .setName("Xrzc 索引适配")
      .setDesc("更新 Xrzc 的两份归档索引。Vault 直接打开 openspec 时，还会检查上级工作区文档中的引用。")
      .addToggle((control) => control.setValue(this.workbench.xrzcIndexes()).onChange((value) => {
        void this.workbench.persist({ xrzcIndexes: value }).catch((error: unknown) => new Notice(message(error)));
      }));

    const result = containerEl.createDiv({ attr: { role: "status" } });
    new Setting(containerEl).setName("OpenSpec CLI").addButton((control) => {
      control.setButtonText("检测").onClick(async () => {
        control.setDisabled(true);
        result.setText("正在检测…");
        try {
          const cli = await this.service.cli();
          result.setText("已找到 OpenSpec " + await cli.version(this.service.workspace) + " · " + cli.entry);
        } catch (error) {
          result.setText(message(error));
        } finally {
          control.setDisabled(false);
        }
      });
    });
  }
}
