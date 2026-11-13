import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, truncateHead, formatSize, type ExtensionContext, type SessionProjection } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const KINDS = ["message", "tool_result", "tool_call", "compaction", "branch_summary", "custom"] as const;
export const historyParameterProperties = {
	query: Type.Optional(Type.String({ description: "Case-insensitive substring query for search; spaces mean AND, | means OR. Optional when kinds, start, or end is set." })),
	kinds: Type.Optional(Type.Array(StringEnum([...KINDS]), { description: "Entry kinds for search: message, tool_result, tool_call, compaction, branch_summary, or custom (default: message, tool_call, and tool_result)." })),
	start: Type.Optional(Type.String({ description: "Inclusive start time for search: ISO timestamp or YYYY-MM-DD." })),
	end: Type.Optional(Type.String({ description: "Inclusive end time for search: ISO timestamp or YYYY-MM-DD." })),
	scope: Type.Optional(StringEnum(["branch", "session", "cwd", "all"], { description: "Scope for search (default: session). branch uses the current branch; session uses the current Session; cwd uses Sessions in the current working directory; all uses all Sessions." })),
	entryId: Type.Optional(Type.String({ description: "Entry ID for view." })),
	sessionFile: Type.Optional(Type.String({ description: "Session file of the entry for view (default: the current Session)." })),
	around: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Entries to list on each side of the entry for view (default: 0, max: 20)." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum results for search, or lines to read for view (default: 10 results, all lines)." })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Number of search results to skip (default: 0), or the line to start from for view (1-indexed, default: 1)." })),
};

type Kind = typeof KINDS[number];
export interface HistoryParams {
	action: string;
	query?: string;
	kinds?: Kind[];
	start?: string;
	end?: string;
	scope?: "branch" | "session" | "cwd" | "all";
	entryId?: string;
	sessionFile?: string;
	around?: number;
	limit?: number;
	offset?: number;
}
export interface HistoryExclusions { entryIds: Set<string>; entries: SessionProjection["entries"] }
interface Item {
	entryId: string;
	timestamp: string;
	kind: Kind;
	role: string;
	toolName?: string;
	text: string;
	sessionFile?: string;
}
function aborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("Operation aborted");
}
function resolved(file: string): string {
	try { return fs.realpathSync.native(file); } catch { return path.resolve(file); }
}
function displayPath(file: string): string {
	const home = os.homedir();
	return file.startsWith(home + path.sep) ? "~" + file.slice(home.length) : file;
}
function textContent(content: any, calls = false): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block: any) => {
		if (typeof block === "string") return block;
		if (block?.type === "text") return block.text ?? "";
		if (calls && block?.type === "toolCall" && block.name !== "tape") return `${block.name}(${JSON.stringify(block.arguments ?? {})})`;
		return "";
	}).filter(Boolean).join("\n\n");
}
function items(entry: any, sessionFile?: string): Item[] {
	const base = { entryId: entry.id, timestamp: new Date(entry.timestamp ?? 0).toISOString(), sessionFile };
	const anchor = entry.message?.details?.tapeAnchor;
	if (anchor?.version === 1 && typeof anchor.summary === "string") return [{ ...base, kind: "compaction", role: "compaction", text: anchor.summary }];
	if (entry.type === "compaction" || entry.type === "branch_summary") return [{ ...base, kind: entry.type, role: entry.type, text: entry.summary ?? "" }];
	if (entry.type === "custom_message") return [{ ...base, kind: "custom", role: "custom", text: textContent(entry.content) }];
	if (entry.type === "custom") return [{ ...base, kind: "custom", role: "custom", text: JSON.stringify(entry.data ?? {}) }];
	if (entry.type !== "message" || !entry.message) return [];
	const message = entry.message;
	if (message.role === "toolResult") return message.toolName === "tape" ? [] : [{ ...base, kind: "tool_result", role: message.role, toolName: message.toolName, text: textContent(message.content) }];
	const found: Item[] = [];
	const text = textContent(message.content);
	if (text || message.role === "user" || message.role === "assistant" && !message.content?.some?.((block: any) => block.type === "toolCall")) found.push({ ...base, kind: "message", role: message.role, text });
	if (message.role === "assistant" && Array.isArray(message.content)) {
		for (const call of message.content) {
			if (call?.type === "toolCall" && call.name !== "tape") found.push({ ...base, kind: "tool_call", role: "assistant", toolName: call.name, text: `${call.name}(${JSON.stringify(call.arguments ?? {})})` });
		}
	}
	return found;
}
function header(item: Item): string {
	const label = item.kind === "message" ? item.role : item.kind === "tool_call" || item.kind === "tool_result" ? `${item.kind} ${item.toolName}` : item.kind;
	return `${item.entryId}  ${label}  ${item.timestamp.slice(0, 16).replace("T", " ")}`;
}
function preview(text: string, term?: string): string {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	const chars = Array.from(collapsed);
	const match = term ? collapsed.toLowerCase().indexOf(term) : 0;
	const position = match < 0 ? 0 : Array.from(collapsed.slice(0, match)).length;
	const start = Math.max(0, position - 50);
	const leading = start > 0 ? "…" : "";
	const available = 200 - leading.length;
	const cut = chars.length - start > available;
	return leading + chars.slice(start, start + available - (cut ? 1 : 0)).join("") + (cut ? "…" : "");
}
function row(item: Item, term?: string, showFile = false): string {
	return `${header(item)}\n  ${preview(item.text, term)}${showFile && item.sessionFile ? `\n  sessionFile: ${displayPath(item.sessionFile)}` : ""}`;
}
function parsedSession(file: string, signal?: AbortSignal): { cwd?: string; entries: any[] } | undefined {
	let raw: string;
	try { raw = fs.readFileSync(file, "utf8"); } catch (error: any) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	const entries: any[] = [];
	let cwd: string | undefined;
	for (const line of raw.split("\n")) {
		aborted(signal);
		if (!line.trim()) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type === "session") cwd = entry.cwd;
		else entries.push(entry);
	}
	return { cwd, entries };
}
function sessionFiles(sessionDir?: string, sessionFile?: string, signal?: AbortSignal): string[] {
	const root = path.join(getAgentDir(), "sessions");
	const dirs: string[] = [];
	if (fs.existsSync(root)) for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
		aborted(signal);
		if (dir.isDirectory()) dirs.push(path.join(root, dir.name));
	}
	if (sessionDir) dirs.push(sessionDir);
	const files = new Set<string>();
	if (sessionFile) files.add(resolved(sessionFile));
	for (const dir of dirs) {
		aborted(signal);
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir)) if (name.endsWith(".jsonl")) files.add(resolved(path.join(dir, name)));
	}
	return [...files];
}
function time(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Date.parse(value);
	const date = Date.parse(value.slice(0, 10));
	if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(parsed) || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error(`\`${name}\` is not a valid timestamp. Use an ISO timestamp or YYYY-MM-DD.`);
	return name === "end" && value.length === 10 ? parsed + 86400000 - 1 : parsed;
}
function result(text: string, details: any) { return { content: [{ type: "text" as const, text }], details }; }
function integer(value: number | undefined, name: string, minimum: number, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < minimum) throw new Error(`\`${name}\` must be an integer of at least ${minimum}.`);
	return value;
}
function boundedRows(rows: string[], requiredIndex?: number): { text: string; start: number; shown: number } {
	let start = 0;
	let end = rows.length;
	if (requiredIndex === undefined) {
		end = 0;
		let text = "";
		for (const row of rows) {
			const next = text ? `${text}\n\n${row}` : row;
			if (truncateHead(next).truncated) break;
			text = next;
			end++;
		}
	}
	while (end > start && truncateHead(rows.slice(start, end).join("\n\n")).truncated) {
		if (requiredIndex !== undefined && end - 1 <= requiredIndex) start++;
		else end--;
	}
	if (end === start && rows.length) throw new Error("Entry metadata exceeds the output limit.");
	return { text: rows.slice(start, end).join("\n\n"), start, shown: end - start };
}
function neighbors(entries: any[], target: any, leafId: string | undefined, around: number, signal?: AbortSignal): any[] {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const children = new Map<string, any[]>();
	for (const entry of entries) {
		aborted(signal);
		if (entry.parentId) children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry]);
	}
	const leafPath = new Set<string>();
	for (let cur = byId.get(leafId); cur && !leafPath.has(cur.id); cur = byId.get(cur.parentId)) leafPath.add(cur.id);
	const eligible = (entry: any) => entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant" && entry.message.stopReason === "stop" && !entry.message.content?.some?.((block: any) => block.type === "toolCall") && !!textContent(entry.message.content));
	const before: any[] = [];
	const after: any[] = [];
	const seen = new Set([target.id]);
	for (let cur = byId.get(target.parentId); cur && before.length < around && !seen.has(cur.id); cur = byId.get(cur.parentId)) {
		aborted(signal); seen.add(cur.id);
		if (eligible(cur)) before.unshift(cur);
	}
	let cur = target;
	while (after.length < around) {
		aborted(signal);
		const kids = children.get(cur.id);
		const next = kids?.find(entry => leafPath.has(entry.id)) ?? kids?.at(-1);
		if (!next || seen.has(next.id)) break;
		seen.add(next.id); cur = next;
		if (eligible(cur)) after.push(cur);
	}
	return [...before, target, ...after];
}

export async function executeHistory(params: HistoryParams, signal: AbortSignal | undefined, ctx: ExtensionContext, exclusions: HistoryExclusions) {
	aborted(signal);
	if (params.sessionFile !== undefined) {
		const file = params.sessionFile.replace(/^@/, "");
		params = { ...params, sessionFile: path.resolve(ctx.cwd, file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file) };
	}
	const manager = ctx.sessionManager;
	const currentFile = manager.getSessionFile();
	const currentEntries = manager.getEntries();
	const sessionDir = manager.getSessionDir();
	const sameFile = (file?: string) => file === undefined || !!currentFile && resolved(file) === resolved(currentFile);
	if (params.action === "search") {
		if (params.entryId !== undefined || params.sessionFile !== undefined || params.around !== undefined) throw new Error("`entryId`, `sessionFile`, and `around` are only valid for view.");
		const start = time(params.start, "start");
		const end = time(params.end, "end");
		const query = (params.query ?? "").toLowerCase().split("|").map(part => part.trim().split(/\s+/).filter(Boolean)).filter(part => part.length);
		if (params.query?.trim() && !query.length) throw new Error("`query` must contain a search term.");
		if (!query.length && params.kinds === undefined && start === undefined && end === undefined) throw new Error("`query`, `kinds`, `start`, or `end` is required for search.");
		if (start !== undefined && end !== undefined && start > end) throw new Error("`start` must be before or equal to `end`.");
		const kinds = params.kinds ?? ["message", "tool_call", "tool_result"];
		if (!kinds.length || kinds.some(kind => !KINDS.includes(kind))) throw new Error("`kinds` must contain supported entry kinds.");
		const scope = params.scope ?? "session";
		if (!["branch", "session", "cwd", "all"].includes(scope)) throw new Error("`scope` must be branch, session, cwd, or all.");
		const offset = integer(params.offset, "offset", 0, 0);
		const limit = integer(params.limit, "limit", 1, 10);
		const recordKey = (item: Item) => JSON.stringify([item.kind, item.toolName, item.text]);
		const excludedRecords = new Map<string, Set<string>>();
		for (const { sourceEntry, messages } of exclusions.entries) {
			aborted(signal);
			if (!exclusions.entryIds.has(sourceEntry.id)) continue;
			const keys = new Set<string>();
			for (const message of messages) {
				const effectiveEntry = sourceEntry.type === "message" ? { ...sourceEntry, message }
					: sourceEntry.type === "custom_message" && "content" in message ? { ...sourceEntry, content: message.content } : sourceEntry;
				for (const item of items(effectiveEntry)) keys.add(recordKey(item));
			}
			excludedRecords.set(sourceEntry.id, keys);
		}
		const matches: { item: Item; term?: string }[] = [];
		const scan = (entries: any[], file?: string) => {
			for (const entry of entries) {
				aborted(signal);
				for (const item of items(entry, file)) {
					if (sameFile(file) && item.kind !== "compaction" && excludedRecords.get(entry.id)?.has(recordKey(item))) continue;
					if (!kinds.includes(item.kind)) continue;
					const timestamp = Date.parse(item.timestamp);
					if (start !== undefined && timestamp < start || end !== undefined && timestamp > end) continue;
					const terms = query.find(group => group.every(term => item.text.toLowerCase().includes(term)));
					if (query.length && !terms) continue;
					matches.push({ item, term: terms?.[0] });
					break;
				}
			}
		};
		if (scope === "session" || scope === "branch") scan(scope === "branch" ? manager.getBranch() : currentEntries, currentFile);
		else for (const file of sessionFiles(sessionDir, currentFile, signal)) {
			aborted(signal);
			const parsed = sameFile(file) ? { cwd: ctx.cwd, entries: currentEntries } : parsedSession(file, signal);
			if (parsed && (scope !== "cwd" || parsed.cwd === ctx.cwd)) scan(parsed.entries, file);
		}
		matches.sort((a, b) => b.item.timestamp.localeCompare(a.item.timestamp));
		const seen = new Set<string>();
		const unique = matches.filter(({ item }) => {
			const key = `${item.entryId}\0${item.kind}\0${item.timestamp}`;
			if (seen.has(key)) return false;
			seen.add(key); return true;
		});
		const selected = unique.slice(offset, offset + limit);
		const page = boundedRows(selected.map(({ item, term }) => row(item, term, scope === "cwd" || scope === "all")));
		const next = offset + page.shown;
		const notice = next < unique.length && page.shown ? `\n\n[${unique.length - next} more results. Use offset=${next} to continue.]` : "";
		return result((page.text || "No matching entries.") + notice, { results: selected.slice(0, page.shown).map(({ item: { text, ...metadata } }) => metadata), total: unique.length, offset, limit });
	}
	if (params.action !== "view") throw new Error(`Unknown history action: ${params.action}`);
	if (!params.entryId) {
		if (params.around !== undefined) throw new Error("`around` requires `entryId`.");
		if (params.sessionFile !== undefined) throw new Error("`sessionFile` requires `entryId`.");
		throw new Error("`entryId` is required for view.");
	}
	for (const name of ["query", "kinds", "start", "end", "scope"] as const) if (params[name] !== undefined) throw new Error(`\`${name}\` is only valid for search.`);
	const around = integer(params.around, "around", 0, 0);
	if (around > 20) throw new Error("`around` must not exceed 20.");
	const offset = integer(params.offset, "offset", 1, 1);
	if (params.limit !== undefined) integer(params.limit, "limit", 1, 1);
	let entries = currentEntries;
	let leafId = manager.getLeafId() ?? manager.getBranch().at(-1)?.id;
	if (!sameFile(params.sessionFile)) {
		const file = params.sessionFile!;
		const allowed = [path.join(getAgentDir(), "sessions"), sessionDir].some(dir => {
			if (!dir) return false;
			const relative = path.relative(resolved(dir), resolved(file));
			return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
		});
		if (!allowed || path.extname(file) !== ".jsonl") throw new Error("`sessionFile` must be within the configured session directories.");
		entries = parsedSession(file, signal)?.entries ?? [];
		leafId = entries.at(-1)?.id;
	}
	const entryId = params.entryId;
	const exact = entries.find(entry => entry.id === entryId);
	const candidates = exact ? [exact] : entries.filter(entry => entry.id?.startsWith(entryId));
	if (candidates.length > 1) throw new Error(`\`entryId\` is ambiguous: ${candidates.slice(0, 20).map(entry => entry.id).join(", ")}${candidates.length > 20 ? ` (${candidates.length - 20} more)` : ""}`);
	const entry = candidates[0];
	const item = entry && items(entry, params.sessionFile ?? currentFile)[0];
	if (!item) throw new Error(`No entry ${params.entryId} in ${params.sessionFile ? displayPath(params.sessionFile) : "this Session"}.`);
	if (around) {
		const range = neighbors(entries, entry, leafId, around, signal);
		const records = range.map(candidate => items(candidate, params.sessionFile ?? currentFile)[0]);
		const targetIndex = range.indexOf(entry);
		const page = boundedRows(records.map(record => row(record)), targetIndex);
		return result(page.text, { entryId: entry.id, sessionFile: params.sessionFile ?? currentFile, around, results: records.slice(page.start, page.start + page.shown).map(({ text, ...metadata }) => metadata), total: records.length, shown: page.shown });
	}
	const body = entry.type === "message" && "content" in entry.message && item.kind !== "compaction" ? textContent(entry.message.content, true) : item.text;
	const lines = body.split("\n");
	if (offset > lines.length) throw new Error(`\`offset\` ${offset} is beyond end of entry (${lines.length} lines total).`);
	const end = Math.min(lines.length, offset - 1 + (params.limit ?? lines.length));
	const selected = lines.slice(offset - 1, end).join("\n");
	const truncation = truncateHead(selected);
	aborted(signal);
	if (truncation.firstLineExceedsLimit) {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-tape-"));
		const fullOutputPath = path.join(directory, "output.txt");
		await fs.promises.writeFile(fullOutputPath, selected, "utf8");
		const notice = `[Line ${offset} is ${formatSize(Buffer.byteLength(lines[offset - 1]))}, exceeds ${formatSize(truncation.maxBytes)} limit. Full output: ${fullOutputPath} (entry lines ${offset}-${end})]`;
		const continuation = end < lines.length ? `\n\n[Read the full page file before continuing. Use offset=${end + 1} to continue.]` : "";
		return result(`${header(item)}\n${notice}${continuation}`, { entryId: entry.id, sessionFile: params.sessionFile ?? currentFile, offset, limit: params.limit ?? null, totalLines: lines.length, shownLines: 0, truncation, fullOutputPath });
	}
	const shownLines = truncation.truncated ? truncation.outputLines : end - offset + 1;
	const next = offset + shownLines;
	const notice = next <= lines.length ? `\n\n[Showing lines ${offset}-${next - 1} of ${lines.length}${truncation.truncatedBy === "bytes" ? ` (${formatSize(truncation.maxBytes)} limit)` : ""}. Use offset=${next} to continue.]` : "";
	return result(`${header(item)}\n${truncation.content}${notice}`, { entryId: entry.id, sessionFile: params.sessionFile ?? currentFile, offset, limit: params.limit ?? null, totalLines: lines.length, shownLines, ...(truncation.truncated ? { truncation } : {}) });
}
