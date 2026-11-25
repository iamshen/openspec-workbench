import { posix } from "node:path";
import { parse, postprocess, preprocess } from "micromark";

export const ACTIVE_INDEX = "README.md";
export const ARCHIVE_INDEX = "changes/archive/README.md";
const activeHeading = "活动提案索引";
const archiveHeading = "归档提案";

// 与 OpenSpec 1.14 的任务统计一致，只有 x 和 X 算完成。
const taskLine = /^(\s*(?:[-*+]|\d{1,9}[.)])\s*)\[(?:\s*([^\]\s]?)\s*\](?![([])|\s+\])\s*(.*)/;
const isDone = (match: RegExpExecArray) => /^x$/i.test(match[2] ?? "");

export function markTasksDone(content: string, selectedLines: number[]): string {
  const parts = content.split(/(\r?\n)/);
  for (const line of new Set(selectedLines)) {
    const index = line * 2;
    const original = parts[index];
    const match = typeof original === "string" ? taskLine.exec(original) : null;
    if (!match || isDone(match)) throw new Error("任务列表已变化，请重新打开归档窗口。");
    const start = match[1].length;
    const end = original.indexOf("]", start);
    parts[index] = original.slice(0, start) + "[x]" + original.slice(end + 1);
  }
  return parts.join("");
}

export function taskRecord(content: string | null) {
  const lines = (content ?? "").split(/\r?\n/);
  const tasks = lines.flatMap((line, index) => {
    const match = taskLine.exec(line);
    return match ? [{ line: index, done: isDone(match), text: match[3].trim() }] : [];
  });
  const start = lines.findIndex((line) => /^##\s+完成记录\s*$/.test(line));
  const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line));
  return {
    completed: tasks.filter((item) => item.done).length,
    total: tasks.length,
    open: tasks.filter((item) => !item.done),
    notes: start >= 0 ? lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim() : "",
  };
}

interface Reference {
  start: number;
  end: number;
  value: string;
  wiki: boolean;
}

function references(content: string): Reference[] {
  const tokens = postprocess(parse().document().write(preprocess()(content, undefined, true)));
  const result: Reference[] = [];
  const excluded: [number, number][] = [];
  for (const [event, token] of tokens) {
    if (event !== "enter") continue;
    const { start, end, type } = token;
    if (type === "resourceDestinationString" || type === "definitionDestinationString") {
      result.push({ start: start.offset, end: end.offset, value: content.slice(start.offset, end.offset), wiki: false });
    }
    if (/^(?:codeFenced|codeIndented|codeText|htmlFlow|htmlText|resource|definition|labelLink|labelImage|characterEscape)$/.test(type)) {
      excluded.push([start.offset, end.offset]);
    }
  }
  for (const match of content.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
    const start = match.index + 2;
    const end = start + match[1].length;
    if (!excluded.some(([left, right]) => match.index < right && end + 2 > left)) {
      result.push({ start, end, value: match[1], wiki: true });
    }
  }
  return result.sort((left, right) => left.start - right.start);
}

export type ResolveWiki = (link: string, note: string) => string | undefined;

const virtualVault = "/workspace/openspec";

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function targetOf(reference: Reference, note: string, resolveWiki?: ResolveWiki) {
  const value = reference.value;
  const divider = reference.wiki ? /[#|]/ : /[?#]/;
  const parts = value.split(divider, 1);
  const raw = parts[0];
  if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return null;
  const decoded = decode(reference.wiki ? raw : raw.replace(/\\([!-/:-@[-\x60{-~])/g, "$1"));
  const wikiResolved = reference.wiki ? resolveWiki?.(decoded, note) : undefined;
  const rooted = raw.startsWith("/");
  const wikiAbsolute = reference.wiki && !/^\.{1,2}\//.test(raw);
  const base = posix.resolve(virtualVault, posix.dirname(note));
  const target = wikiResolved ?? (rooted || wikiAbsolute
    ? posix.relative(virtualVault, posix.resolve(virtualVault, decoded.replace(/^\/+/, "")))
    : posix.relative(virtualVault, posix.resolve(base, decoded)));
  return { target, raw, suffix: value.slice(raw.length), rooted, wikiAbsolute };
}

function inside(file: string, folder: string): boolean {
  const needle = folder.toLowerCase();
  const candidate = file.toLowerCase();
  return candidate === needle || candidate.startsWith(needle + "/");
}

function relocated(file: string, from: string, to: string): string {
  return inside(file, from) ? to + file.slice(from.length) : file;
}

function encodePath(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/");
}

export function rewriteLinks(content: string, note: string, from: string, to: string, resolveWiki?: ResolveWiki): string {
  const nextNote = relocated(note, from, to);
  let next = content;
  for (const reference of references(content).reverse()) {
    const link = targetOf(reference, note, resolveWiki);
    if (!link) continue;
    let target = relocated(link.target, from, to);
    if (target === link.target && (nextNote === note || link.rooted || link.wikiAbsolute)) continue;
    if (target !== link.target && nextNote !== note && !link.rooted && !link.wikiAbsolute) continue;
    if (reference.wiki && !/\.md$/i.test(link.raw)) target = target.replace(/\.md$/i, "");
    const relative = posix.relative(posix.resolve(virtualVault, posix.dirname(nextNote)), posix.resolve(virtualVault, target));
    const destination = relative || ".";
    const href = link.rooted ? "/" + target : link.wikiAbsolute ? target : destination;
    const slash = /\/$/.test(link.raw) && !href.endsWith("/") ? "/" : "";
    const formatted = reference.wiki ? href : encodePath(href);
    next = next.slice(0, reference.start) + formatted + slash + link.suffix + next.slice(reference.end);
  }
  return next;
}

export function referencesTo(content: string, note: string, folder: string): number[] {
  const lines = new Set<number>();
  for (const reference of references(content)) {
    const link = targetOf(reference, note);
    // Vault 外的相对 Markdown 链接按源文件所在目录解析。
    if (link && inside(link.target, folder)) lines.add(content.slice(0, reference.start).split("\n").length);
  }
  return [...lines];
}

function table(content: string, heading: string) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const section = lines.findIndex((line) => line.trim() === "## " + heading);
  if (section === -1) throw new Error("索引缺少「" + heading + "」标题。");
  const following = lines.findIndex((line, index) => index > section && /^#{1,2}\s/.test(line));
  const header = lines.findIndex((line, index) =>
    index > section && (following === -1 || index < following) && /^\s*\|/.test(line));
  if (header === -1 || !/^\s*\|\s*:?-{3,}/.test(lines[header + 1] ?? "")) {
    throw new Error("索引缺少「" + heading + "」表格。");
  }
  let last = header + 2;
  while (last < lines.length && /^\s*\|/.test(lines[last])) last++;
  return { lines, newline, first: header + 2, last };
}

export function indexRows(content: string, archived: boolean) {
  const note = archived ? ARCHIVE_INDEX : ACTIVE_INDEX;
  const { lines, first, last } = table(content, archived ? archiveHeading : activeHeading);
  return lines.slice(first, last).map((line) => {
    const links = references(line).map((reference) => targetOf(reference, note)?.target).filter((value): value is string => !!value);
    const prefix = archived ? "changes/archive/" : "changes/";
    const proposalLink = links.find((link) =>
      link.startsWith(prefix) && /^[-a-z0-9]+\/proposal\.md$/i.test(link.slice(prefix.length)));
    const id = proposalLink?.slice(prefix.length, -"/proposal.md".length);
    const cells = line.trim().slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim());
    const repoCell = cells[archived ? 2 : 3] ?? "";
    const repository = repoCell.match(/\[([^\]]+)\]\([^)]+\)/)?.[1] ?? repoCell;
    return { id, links, repository };
  });
}

export function removeActiveRow(content: string, id: string): string {
  const { lines, first, newline } = table(content, activeHeading);
  const matching = indexRows(content, false).flatMap((row, index) => row.id === id ? [index + first] : []);
  if (matching.length > 1) throw new Error("活动索引内有重复提案：" + id);
  if (matching.length === 1) lines.splice(matching[0], 1);
  return lines.join(newline);
}

function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

export function addArchivedRow(content: string, id: string, date: string, repository: string, summary: string): string {
  const { lines, first, last, newline } = table(content, archiveHeading);
  if (indexRows(content, true).some((row) => row.id === id)) throw new Error("归档索引已经登记该提案：" + id);
  const repo = /^[\w.-]+$/.test(repository)
    ? "[" + repository + "](../../../" + repository + "/)"
    : cell(repository);
  lines.splice(first, 0, "| " + date + " | [" + id + "](" + id + "/proposal.md) | " + repo + " | " + cell(summary) + " |");
  const count = last - first + 1;
  const countLine = lines.findIndex((line) => /^当前(?:共|索引收录)\s+\d+\s+份归档提案/.test(line));
  if (countLine >= 0) {
    lines[countLine] = lines[countLine].replace(/^当前(?:共|索引收录)\s+\d+\s+份归档提案/, "当前索引收录 " + count + " 份归档提案");
  }
  return lines.join(newline);
}
