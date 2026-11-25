import { App, Modal, Notice } from "obsidian";
import { ArchiveOutcome, ArchivePreview, ArchiveRequest, ArchiveService, archiveTypes, ArchiveType, patch } from "./archive";
import { catalog, Proposal, Validation } from "./catalog";
import { message } from "./storage";

function button(parent: HTMLElement, label: string, action: () => void, primary = false) {
  const element = parent.createEl("button", { text: label, attr: { type: "button" } });
  if (primary) element.addClass("mod-cta");
  element.addEventListener("click", action);
  return element;
}

function status(parent: HTMLElement) {
  return parent.createDiv({ cls: "openspec-status", attr: { role: "status" } });
}

function details(parent: HTMLElement, title: string) {
  const box = parent.createEl("details");
  box.createEl("summary", { text: title });
  return box;
}

function list(parent: HTMLElement, items: string[]) {
  const body = parent.createEl("ul");
  for (const item of items) body.createEl("li", { text: item });
}

function noteButtons(parent: HTMLElement, proposal: Proposal, open: (path: string) => void) {
  for (const file of proposal.files) button(parent, file.label, () => open(file.path));
}

function progressLabel(proposal: Proposal) {
  const { completed, total } = proposal.progress;
  return total ? "任务 " + completed + "/" + total : "暂无任务记录";
}

export class CatalogModal extends Modal {
  constructor(app: App, private readonly service: ArchiveService, private readonly choose: (proposal: Proposal) => void,
    private readonly archiveOnly = false) {
    super(app);
  }

  onOpen() {
    this.setTitle(this.archiveOnly ? "选择要归档的提案" : "查找 OpenSpec 提案");
    this.modalEl.addClass("openspec-workbench");
    const tools = this.contentEl.createDiv({ cls: "openspec-actions" });
    const search = tools.createEl("input", {
      type: "search",
      placeholder: "中文标题、英文名称或主仓库",
      attr: { "aria-label": "搜索提案", spellcheck: "false" },
    });
    const filters = tools.createDiv({ cls: "openspec-actions" });
    const resultStatus = status(this.contentEl);
    const results = this.contentEl.createDiv({ cls: "openspec-results" });
    let archived = false;
    let proposals: Proposal[] = [];
    const tabs = [false, true].filter((item) => !item || !this.archiveOnly).map((item) => {
      const tab = button(filters, item ? "已归档" : "活动提案", () => {
        archived = item;
        render();
      });
      return { item, tab };
    });
    const render = () => {
      for (const { item, tab } of tabs) tab.setAttribute("aria-pressed", String(item === archived));
      const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches = proposals.filter((item) => item.archived === archived && terms.every((term) =>
        [item.id, item.title, item.repository].some((text) => text.toLocaleLowerCase().includes(term))));
      resultStatus.setText(matches.length ? matches.length + " 份提案" : "未找到提案");
      results.empty();
      for (const proposal of matches) {
        const row = button(results, proposal.title, () => {
          this.close();
          this.choose(proposal);
        });
        row.addClass("openspec-proposal-row");
        row.createEl("small", { text: [proposal.id, proposal.repository, progressLabel(proposal)].filter(Boolean).join(" · ") });
      }
    };
    search.addEventListener("input", render);
    search.focus();
    resultStatus.setText("正在读取提案…");
    void catalog(this.service.project, this.service.manageIndexes).then((result) => {
      if (!this.contentEl.isConnected) return;
      proposals = result.proposals;
      render();
      if (result.issues.length) {
        const warnings = details(this.contentEl, "索引问题（" + result.issues.length + "）");
        list(warnings, result.issues);
      }
    }).catch((error: unknown) => resultStatus.setText(message(error)));
  }
}

export class ProposalModal extends Modal {
  constructor(app: App, private readonly proposal: Proposal, private readonly service: ArchiveService,
    private readonly openFile: (path: string) => void, private readonly archive: () => void) {
    super(app);
  }

  onOpen() {
    this.setTitle(this.proposal.title);
    this.modalEl.addClass("openspec-workbench");
    const proposal = this.proposal;
    this.contentEl.createEl("p", { text: [proposal.id, proposal.repository, progressLabel(proposal)].filter(Boolean).join(" · ") });
    const actions = this.contentEl.createDiv({ cls: "openspec-actions" });
    noteButtons(actions, proposal, (path) => { this.close(); this.openFile(path); });
    if (proposal.progress.notes) {
      this.contentEl.createEl("h3", { text: "完成记录" });
      this.contentEl.createEl("pre", { text: proposal.progress.notes });
    }
    if (proposal.progress.open.length) {
      list(details(this.contentEl, "未完成任务（" + proposal.progress.open.length + "）"), proposal.progress.open.map((task) => task.text));
    }
    if (!proposal.archived) {
      this.contentEl.createEl("h3", { text: "OpenSpec 校验" });
      const output = this.contentEl.createDiv();
      const resultStatus = status(output);
      resultStatus.setText("正在校验…");
      void this.validate(output, resultStatus);
      button(actions, "归档提案", () => { this.close(); this.archive(); }, true);
    }
  }

  private async validate(output: HTMLElement, resultStatus: HTMLElement) {
    try {
      const cli = await this.service.cli();
      const result = await cli.json<Validation>(["validate", this.proposal.id, "--type", "change", "--no-interactive"],
        this.service.workspace, true);
      const checked = result.items?.[0];
      resultStatus.setText(checked?.valid ? "校验通过" : "校验有问题");
      const issues = checked?.issues.map((issue) => [issue.level, issue.path, issue.message].filter(Boolean).join(" · "))
        ?? result.status?.map((issue) => issue.message);
      if (issues?.length) list(output, issues);
    } catch (error) {
      resultStatus.setText(message(error));
    }
  }
}

function field(parent: HTMLElement, label: string, name: string, required: boolean) {
  const group = parent.createEl("label", { cls: "openspec-field" });
  group.createSpan({ text: label + (required ? "（必填）" : "") });
  return group.createEl("textarea", { attr: { name, rows: 2, ...(required ? { required: "" } : {}) } });
}

export class ArchiveModal extends Modal {
  private type?: ArchiveType;
  private verified = false;
  private readonly selectedTasks = new Set<number>();
  private drafts: Partial<Record<ArchiveType, string[]>> = {};

  constructor(app: App, private readonly proposal: Proposal, private readonly service: ArchiveService,
    private readonly confirmWrites: (preview: ArchivePreview) => Promise<ArchiveOutcome>,
    private readonly openFile: (path: string) => void) {
    super(app);
    if (proposal.progress.total && proposal.progress.total === proposal.progress.completed) this.type = "complete";
  }

  onOpen() {
    this.setTitle("归档 · " + this.proposal.title);
    this.modalEl.addClass("openspec-workbench");
    this.form();
  }

  private form(initialMessage?: string) {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.proposal.id + " · " + progressLabel(this.proposal) });
    if (this.proposal.progress.notes) {
      details(this.contentEl, "查看已有完成记录").createEl("pre", { text: this.proposal.progress.notes });
    }
    const form = this.contentEl.createEl("form");
    const choices = form.createEl("fieldset", { cls: "openspec-types" });
    choices.createEl("legend", { text: "归档类型" });
    const fields = form.createDiv();
    const resultStatus = status(form);
    if (initialMessage) resultStatus.setText(initialMessage);
    const actions = form.createDiv({ cls: "openspec-actions openspec-footer" });
    button(actions, "取消", () => this.close());
    const preview = actions.createEl("button", { text: "预览归档", cls: "mod-cta", attr: { type: "submit" } });
    let draftFields: HTMLTextAreaElement[] = [];
    const renderFields = () => {
      fields.empty();
      const type = this.type;
      if (!type) return;
      fields.createEl("p", { text: type === "complete" ? "同步正式规范中的变更" : "跳过正式规范同步" });
      if (type === "complete" && this.proposal.progress.open.length) this.renderTasks(fields);
      draftFields = archiveTypes[type].fields.map((label, index) => {
        const required = !(type === "withdrawn" && index === 1);
        const input = field(fields, label, "archive-field-" + index, required);
        input.value = this.drafts[type]?.[index] ?? (required ? "无" : "");
        return input;
      });
      if (type === "complete") {
        const label = fields.createEl("label", { cls: "openspec-confirmation" });
        const check = label.createEl("input", { type: "checkbox", attr: { name: "delivery-confirmed", required: "" } });
        check.checked = this.verified;
        check.addEventListener("change", () => { this.verified = check.checked; });
        label.appendText("已核对实际交付、验收结果和待验证事项");
      }
    };
    for (const type of Object.keys(archiveTypes) as ArchiveType[]) {
      const label = choices.createEl("label");
      const radio = label.createEl("input", { type: "radio", attr: { name: "archive-type", value: type, required: "" } });
      radio.checked = this.type === type;
      label.appendText(archiveTypes[type].label);
      radio.addEventListener("change", () => {
        if (this.type) this.drafts[this.type] = draftFields.map((input) => input.value);
        this.type = type;
        renderFields();
      });
    }
    renderFields();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (preview.disabled || !this.type) return;
      this.drafts[this.type] = draftFields.map((input) => input.value);
      const request: ArchiveRequest = {
        id: this.proposal.id,
        type: this.type,
        fields: this.drafts[this.type] ?? [],
        deliveryConfirmed: this.verified,
      };
      if (this.type === "complete" && this.selectedTasks.size && this.proposal.taskRevision) {
        request.taskSelection = { revision: this.proposal.taskRevision, lines: [...this.selectedTasks] };
      }
      preview.disabled = true;
      resultStatus.setText("正在预演归档…");
      void this.service.preview(request).then((value) => {
        if (this.contentEl.isConnected) this.showPreview(value);
      }).catch((error: unknown) => resultStatus.setText(message(error)))
        .finally(() => { preview.disabled = false; });
    });
  }

  private renderTasks(parent: HTMLElement) {
    const group = parent.createEl("fieldset", { cls: "openspec-tasks" });
    group.createEl("legend", { text: "未完成任务（" + this.proposal.progress.open.length + "）" });
    group.createEl("p", { text: "勾选要标记为完成的任务。其余任务保留原状态，仍可归档。" });
    const items = group.createDiv({ cls: "openspec-task-list" });
    for (const task of this.proposal.progress.open) {
      const label = items.createEl("label", { cls: "openspec-task-option" });
      const checkbox = label.createEl("input", {
        type: "checkbox", attr: { name: "completed-task", value: String(task.line) },
      });
      checkbox.checked = this.selectedTasks.has(task.line);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedTasks.add(task.line);
        else this.selectedTasks.delete(task.line);
      });
      label.createSpan({ text: task.text || "第 " + (task.line + 1) + " 行的任务" });
    }
  }

  private showPreview(preview: ArchivePreview) {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: archiveTypes[preview.request.type].label + " · " + preview.date });
    this.contentEl.createEl("p", { text: "移动至 " + preview.destination + "/" });
    const changes = this.contentEl.createDiv({ cls: "openspec-preview" });
    if (preview.taskWrite) {
      const count = new Set(preview.request.taskSelection?.lines).size;
      details(changes, "归档前勾选 " + count + " 项任务").createEl("pre", { text: patch(preview.taskWrite) });
    }
    if (preview.remainingTasks) {
      changes.createEl("p", { text: "归档后保留 " + preview.remainingTasks + " 项未完成任务。" });
    }
    changes.createEl("h3", { text: "正式规范" });
    if (!preview.specs.length) changes.createEl("p", { text: "没有正式规范改动" });
    for (const file of preview.specs) {
      details(changes, (file.before === null ? "新增 " : file.after === null ? "删除 " : "修改 ") + file.path)
        .createEl("pre", { text: patch(file) });
    }
    changes.createEl("h3", { text: "归档说明、索引与链接" });
    for (const file of preview.writes) details(changes, file.path).createEl("pre", { text: patch(file) });
    showReferences(changes, preview);
    const resultStatus = status(this.contentEl);
    const actions = this.contentEl.createDiv({ cls: "openspec-actions openspec-footer" });
    const cancel = button(actions, "取消", () => this.close());
    const back = button(actions, "返回编辑", () => this.form());
    const confirm = button(actions, "确认归档", () => {
      confirm.disabled = back.disabled = true;
      cancel.setText("关闭");
      resultStatus.setText("正在归档…");
      void this.confirmWrites(preview).then((outcome) => {
        if (!this.contentEl.isConnected) {
          new Notice(outcome.documentError ? "提案已归档，文档待更新" : "提案已归档");
          return;
        }
        this.contentEl.empty();
        showOutcome(this.contentEl, outcome, this.openFile, () => this.resume());
      }).catch((error: unknown) => {
        if (this.contentEl.isConnected) this.form(message(error));
        else new Notice(message(error));
      });
    }, true);
    cancel.focus();
  }

  private resume() {
    return this.service.resume().then((outcome) => {
      this.contentEl.empty();
      showOutcome(this.contentEl, outcome, this.openFile, () => this.resume());
    });
  }
}

function showReferences(parent: HTMLElement, outcome: Pick<ArchiveOutcome, "external" | "notices">) {
  if (outcome.external.length) {
    const external = details(parent, "Vault 外需人工更新的引用（" + outcome.external.length + "）");
    list(external, outcome.external);
  }
  if (outcome.notices.length) {
    list(details(parent, "归档提示（" + outcome.notices.length + "）"), outcome.notices);
  }
}

export function showOutcome(parent: HTMLElement, outcome: ArchiveOutcome,
  open: (path: string) => void, resume: () => Promise<void>) {
  const output = status(parent);
  if (!outcome.archived) {
    output.setText("上次归档尚未移动提案，可以重新预览。");
    return;
  }
  output.setText(outcome.documentError ? "提案已归档，文档待更新" : "提案已归档");
  parent.createEl("p", { text: outcome.folder + "/" });
  if (outcome.documentError) {
    parent.createEl("p", { text: outcome.documentError });
    const retry = button(parent, "继续更新归档文档", () => {
      retry.disabled = true;
      void resume().catch((error: unknown) => output.setText(message(error)))
        .finally(() => { retry.disabled = false; });
    }, true);
  } else {
    button(parent, "打开归档说明", () => open(outcome.folder + "/archive.md"));
  }
  showReferences(parent, outcome);
}
