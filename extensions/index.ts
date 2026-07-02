import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, findCutPoint, getAgentDir, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_KEEP_RECENT_TOKENS = 20000;
const SEARCH_PREVIEW_LENGTH = 200;
const DEFAULT_SEARCH_KINDS = ["message", "tool_result"] as const;
const SEARCH_KINDS = ["message", "tool_result", "tool_call", "anchor", "compact", "summary", "custom"] as const;
const SEARCH_KINDS_SET = new Set<string>(SEARCH_KINDS);
const DEFAULT_SEARCH_KINDS_SET = new Set<string>(DEFAULT_SEARCH_KINDS);
const SEARCH_INTERNAL_TOOL_NAMES = new Set(["tape"]);

// ============================================================================
// Types
// ============================================================================

interface TapeAnchorData {
	version: 1;
	name: string;
	summary: string;
	keepRecentTokens: number;
	firstKeptEntryId?: string;
	createdAt: string;
	source: {
		cwd: string;
		sessionFile?: string;
		leafId?: string;
	};
}

type TapeRecordKind = "anchor" | "compact";

interface TapeRecord {
	kind: TapeRecordKind;
	entryId: string;
	name: string;
	summary: string;
	timestamp: string;
	sessionFile?: string;
	sessionCwd?: string;
	sourceSessionFile?: string;
}

type SearchKind = (typeof SEARCH_KINDS)[number];

type QueryExpr = string[][];

interface TimeFilter {
	start?: number;
	end?: number;
}

interface SearchItem {
	kind: SearchKind;
	role: string;
	searchableText: string;
	payload: Record<string, unknown>;
	timestamp: string;
	sessionFile?: string;
	sessionCwd?: string;
	sourceSessionFile?: string;
}

interface SearchResult {
	entryId: string;
	timestamp: string;
	kind: SearchKind;
	role: string;
	preview: string;
	payload: Record<string, unknown>;
	sessionFile?: string;
	sessionCwd?: string;
	sourceSessionFile?: string;
}

// ============================================================================
// Session file helpers
// ============================================================================

function getSessionsDir(): string {
	return path.join(getAgentDir(), "sessions");
}

function listSessionFiles(): Array<{ file: string; mtime: number }> {
	const sessionsDir = getSessionsDir();
	if (!fs.existsSync(sessionsDir)) return [];

	const files: Array<{ file: string; mtime: number }> = [];
	for (const dirent of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue;
		const subdirPath = path.join(sessionsDir, dirent.name);

		for (const name of fs.readdirSync(subdirPath)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = path.join(subdirPath, name);
			try {
				files.push({ file, mtime: fs.statSync(file).mtimeMs });
			} catch { /* skip */ }
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	return files;
}

function parseSessionFile(file: string): { cwd?: string; entries: any[] } | null {
	let raw: string;
	try { raw = fs.readFileSync(file, "utf-8"); } catch { return null; }

	let cwd: string | undefined;
	const entries: any[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type === "session") {
			cwd = entry.cwd;
		} else {
			entries.push(entry);
		}
	}
	return { cwd, entries };
}

function resolvedFilePath(file: string): string {
	try { return fs.realpathSync.native(file); } catch { return path.resolve(file); }
}

function isCurrentSessionFile(file: string, sessionFile?: string): boolean {
	return !!sessionFile && resolvedFilePath(file) === resolvedFilePath(sessionFile);
}

function sessionEntriesForScan(item: { file: string }, sessionFile: string | undefined, sessionEntries: any[], cwd: string): { file: string; cwd?: string; entries: any[] } | null {
	if (isCurrentSessionFile(item.file, sessionFile)) return { file: sessionFile!, cwd, entries: sessionEntries };
	const parsed = parseSessionFile(item.file);
	return parsed ? { file: item.file, ...parsed } : null;
}

// ============================================================================
// Timestamp helpers
// ============================================================================

function normalizeTimestamp(timestamp: unknown): string {
	if (typeof timestamp === "string") return timestamp;
	if (typeof timestamp === "number") return new Date(timestamp).toISOString();
	return "";
}

function timestampToMs(timestamp: string): number {
	if (!timestamp) return Number.NaN;
	return Date.parse(timestamp);
}

function parseFilterTimestamp(value: unknown, name: string): { value?: number; error?: string } {
	if (value == null) return {};
	if (typeof value !== "string" || !value.trim()) return { error: `\`${name}\` must be a timestamp string.` };
	const raw = value.trim();
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
	const timestamp = dateOnly
		? `${raw}T${name === "end" ? "23:59:59.999" : "00:00:00.000"}`
		: raw;
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return { error: `\`${name}\` is not a valid timestamp: ${value}` };
	return { value: parsed };
}

function matchesTimeFilter(timestamp: string, filter: TimeFilter): boolean {
	if (filter.start == null && filter.end == null) return true;
	const ms = timestampToMs(timestamp);
	if (Number.isNaN(ms)) return false;
	if (filter.start != null && ms < filter.start) return false;
	if (filter.end != null && ms > filter.end) return false;
	return true;
}

function formatTimestampSecond(timestamp: string): string {
	const raw = normalizeTimestamp(timestamp);
	const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
	if (match) return `${match[1]} ${match[2]}`;
	const ms = Date.parse(raw);
	if (!Number.isNaN(ms)) return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
	return raw.slice(0, 19);
}

function compactNameFromTimestamp(timestamp: string): string {
	const display = formatTimestampSecond(timestamp);
	const match = display.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
	if (match) return `compact/${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}`;
	return `compact/${display.replace(/[^0-9]/g, "").slice(0, 15)}`;
}

// ============================================================================
// Anchor detection & record extraction
// ============================================================================

function isTapeAnchorMessage(message: any): boolean {
	return message?.role === "toolResult" && message?.toolName === "tape" && !!message?.details?.tapeAnchor;
}

function anchorFromMessage(message: any): TapeAnchorData | null {
	const data = message?.details?.tapeAnchor;
	if (!data || data.version !== 1 || !data.name || !data.summary) return null;
	return data as TapeAnchorData;
}

function anchorFromEntry(entry: any, sessionFile?: string, sessionCwd?: string): TapeRecord | null {
	if (entry?.type !== "message" || !isTapeAnchorMessage(entry.message)) return null;

	const anchor = anchorFromMessage(entry.message);
	if (!anchor) return null;

	return {
		kind: "anchor",
		entryId: entry.id,
		name: anchor.name,
		summary: anchor.summary,
		timestamp: normalizeTimestamp(entry.timestamp ?? anchor.createdAt),
		sessionFile,
		sessionCwd: sessionCwd ?? anchor.source?.cwd,
		sourceSessionFile: anchor.source?.sessionFile,
	};
}

function compactFromEntry(entry: any, sessionFile?: string, sessionCwd?: string): TapeRecord | null {
	if (entry?.type !== "compaction" || !entry.summary) return null;
	const timestamp = normalizeTimestamp(entry.timestamp);
	return {
		kind: "compact",
		entryId: entry.id,
		name: compactNameFromTimestamp(timestamp),
		summary: entry.summary,
		timestamp,
		sessionFile,
		sessionCwd,
	};
}

function anchorRecordsFromEntries(entries: any[], sessionFile?: string, sessionCwd?: string): TapeRecord[] {
	const anchors: TapeRecord[] = [];
	for (const entry of entries) {
		const anchor = anchorFromEntry(entry, sessionFile, sessionCwd);
		if (anchor) anchors.push(anchor);
	}
	return anchors;
}

function tapeRecordsFromEntries(entries: any[], sessionFile?: string, sessionCwd?: string): TapeRecord[] {
	const records: TapeRecord[] = [];
	for (const entry of entries) {
		const anchor = anchorFromEntry(entry, sessionFile, sessionCwd);
		if (anchor) {
			records.push(anchor);
			continue;
		}
		const compact = compactFromEntry(entry, sessionFile, sessionCwd);
		if (compact) records.push(compact);
	}
	return records;
}

// ============================================================================
// Token estimation
// ============================================================================

function estimateMessageTokens(msg: any): number {
	let chars = 0;
	if (typeof msg.content === "string") {
		chars = msg.content.length;
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (typeof block === "string") chars += block.length;
			else if (block?.text) chars += block.text.length;
			else if (block?.thinking) chars += block.thinking.length;
			else if (block?.type === "toolCall") {
				chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length;
			}
		}
	}
	if (msg.summary) chars += msg.summary.length;
	return Math.ceil(chars / 4);
}

// ============================================================================
// Entry content extraction (for search)
// ============================================================================

function truncateSearchText(text: string): { content: string; truncated: boolean } {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return { content: truncation.content, truncated: truncation.truncated };
}

function contentPayload(content: string): Record<string, unknown> {
	const truncated = truncateSearchText(content);
	return { content: truncated.content, truncated: truncated.truncated };
}

function recordPayload(record: TapeRecord): Record<string, unknown> {
	const truncated = truncateSearchText(record.summary);
	return {
		entryId: record.entryId,
		timestamp: record.timestamp,
		name: record.name,
		summary: truncated.content,
		sessionFile: record.sessionFile,
		sessionCwd: record.sessionCwd,
		sourceSessionFile: record.sourceSessionFile,
		truncated: truncated.truncated,
	};
}

function stringifyContentBlocks(content: any[]): string {
	return content
		.map((block: any) => {
			if (typeof block === "string") return block;
			if (block?.text) return block.text;
			if (block?.thinking) return block.thinking;
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function searchItemForRecord(record: TapeRecord): SearchItem {
	return {
		kind: record.kind,
		role: record.kind,
		searchableText: `${record.name}\n${record.summary}`,
		payload: recordPayload(record),
		timestamp: record.timestamp,
		sessionFile: record.sessionFile,
		sessionCwd: record.sessionCwd,
		sourceSessionFile: record.sourceSessionFile,
	};
}

function extractSearchItems(entry: any, sessionFile?: string, sessionCwd?: string): SearchItem[] {
	const anchor = anchorFromEntry(entry, sessionFile, sessionCwd);
	if (anchor) return [searchItemForRecord(anchor)];

	const compact = compactFromEntry(entry, sessionFile, sessionCwd);
	if (compact) return [searchItemForRecord(compact)];

	const timestamp = normalizeTimestamp(entry.timestamp);
	if (entry.type === "message") {
		const msg = entry.message;
		if (!msg) return [];

		if (msg.role === "toolResult") {
			if (SEARCH_INTERNAL_TOOL_NAMES.has(msg.toolName)) return [];
			let content = "";
			if (typeof msg.content === "string") {
				content = msg.content;
			} else if (Array.isArray(msg.content)) {
				content = stringifyContentBlocks(msg.content);
			}
			const role = msg.toolName ? `toolResult:${msg.toolName}` : "toolResult";
			return content ? [{ kind: "tool_result", role, searchableText: content, payload: contentPayload(content), timestamp, sessionFile, sessionCwd }] : [];
		}

		if (msg.role === "assistant") {
			const items: SearchItem[] = [];
			if (typeof msg.content === "string") {
				if (msg.content) items.push({ kind: "message", role: "assistant", searchableText: msg.content, payload: contentPayload(msg.content), timestamp, sessionFile, sessionCwd });
			} else if (Array.isArray(msg.content)) {
				const textContent = stringifyContentBlocks(msg.content);
				if (textContent) items.push({ kind: "message", role: "assistant", searchableText: textContent, payload: contentPayload(textContent), timestamp, sessionFile, sessionCwd });

				const toolCalls = msg.content
					.filter((block: any) => block?.type === "toolCall" && !SEARCH_INTERNAL_TOOL_NAMES.has(block.name))
					.map((block: any) => `${block.name}(${JSON.stringify(block.arguments)})`)
					.join(" ");
				if (toolCalls) items.push({ kind: "tool_call", role: "assistant", searchableText: toolCalls, payload: contentPayload(toolCalls), timestamp, sessionFile, sessionCwd });
			}
			return items;
		}

		const role = msg.role ?? "unknown";
		let content = "";
		if (typeof msg.content === "string") {
			content = msg.content;
		} else if (Array.isArray(msg.content)) {
			content = stringifyContentBlocks(msg.content);
		}
		if (msg.summary) content = msg.summary;
		return content ? [{ kind: "message", role, searchableText: content, payload: contentPayload(content), timestamp, sessionFile, sessionCwd }] : [];
	}
	if (entry.type === "custom_message" && typeof entry.content === "string" && entry.content) {
		return [{ kind: "custom", role: "custom", searchableText: entry.content, payload: contentPayload(entry.content), timestamp, sessionFile, sessionCwd }];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [{ kind: "summary", role: "branchSummary", searchableText: entry.summary, payload: contentPayload(entry.summary), timestamp, sessionFile, sessionCwd }];
	}
	return [];
}

function normalizeSearchKinds(kinds: unknown): SearchKind[] {
	if (!Array.isArray(kinds) || kinds.length === 0) return [...DEFAULT_SEARCH_KINDS];
	const normalized: SearchKind[] = [];
	const seen = new Set<SearchKind>();
	for (const kind of kinds) {
		if (typeof kind !== "string" || !SEARCH_KINDS_SET.has(kind)) continue;
		const searchKind = kind as SearchKind;
		if (seen.has(searchKind)) continue;
		seen.add(searchKind);
		normalized.push(searchKind);
	}
	return normalized;
}

function parseQuery(query: string): QueryExpr {
	return query
		.toLowerCase()
		.split("|")
		.map((part) => part.trim().split(/\s+/).filter(Boolean))
		.filter((part) => part.length > 0);
}

function matchingQueryTerm(content: string, query: QueryExpr): string | undefined {
	const lower = content.toLowerCase();
	for (const andTerms of query) {
		if (!andTerms.every((term) => lower.includes(term))) continue;
		return andTerms.find((term) => lower.includes(term));
	}
	return undefined;
}

function matchesQuery(text: string, query: QueryExpr): boolean {
	if (query.length === 0) return true;
	return matchingQueryTerm(text, query) !== undefined;
}

function makePreview(content: string, query: QueryExpr): string {
	const term = matchingQueryTerm(content, query);
	const lower = content.toLowerCase();
	const matchIdx = term ? lower.indexOf(term) : 0;
	const start = Math.max(0, matchIdx - 50);
	const end = Math.min(content.length, start + SEARCH_PREVIEW_LENGTH);
	let preview = content.slice(start, end).replace(/\n/g, " ");
	if (start > 0) preview = "..." + preview;
	if (end < content.length) preview += "...";
	return preview;
}

function matchEntries(entries: any[], query: QueryExpr, kinds: SearchKind[], timeFilter: TimeFilter, sessionFile?: string, sessionCwd?: string): SearchResult[] {
	const allowedKinds = new Set<SearchKind>(kinds);
	const results: SearchResult[] = [];

	for (const entry of entries) {
		const entryId = entry.id ?? "";
		for (const item of extractSearchItems(entry, sessionFile, sessionCwd)) {
			if (!allowedKinds.has(item.kind)) continue;
			if (!matchesTimeFilter(item.timestamp, timeFilter)) continue;
			if (!matchesQuery(item.searchableText, query)) continue;

			results.push({
				entryId,
				timestamp: item.timestamp,
				kind: item.kind,
				role: item.role,
				preview: makePreview(item.searchableText, query),
				payload: item.payload,
				sessionFile: item.sessionFile,
				sessionCwd: item.sessionCwd,
				sourceSessionFile: item.sourceSessionFile,
			});
			break;
		}
	}

	return results;
}

function recordDedupeKey(record: TapeRecord): string {
	if (record.kind === "anchor") {
		return `${record.kind}:${record.sourceSessionFile ?? record.sessionFile ?? ""}:${record.entryId}`;
	}
	return `${record.kind}:${record.entryId}:${record.timestamp}:${record.summary}`;
}

function searchResultDedupeKey(result: SearchResult): string {
	if (result.kind === "anchor") {
		return `${result.kind}:${result.sourceSessionFile ?? result.sessionFile ?? ""}:${result.entryId}`;
	}
	const summary = typeof result.payload.summary === "string" ? result.payload.summary : result.preview;
	return `${result.kind}:${result.entryId}:${result.timestamp}:${summary}`;
}

function dedupeTapeRecords(records: TapeRecord[]): TapeRecord[] {
	const seen = new Set<string>();
	return records.filter((record) => {
		const key = recordDedupeKey(record);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	return results.filter((result) => {
		const key = searchResultDedupeKey(result);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// ============================================================================
// firstKeptEntryId calculation
// ============================================================================

function calculateFirstKeptEntryId(branchEntries: any[], keepRecentTokens: number): string | undefined {
	const cutPoint = findCutPoint(branchEntries, 0, branchEntries.length, keepRecentTokens);
	const keepFromIdx = cutPoint.isSplitTurn && cutPoint.turnStartIndex >= 0
		? cutPoint.turnStartIndex
		: cutPoint.firstKeptEntryIndex;
	for (let i = keepFromIdx; i < branchEntries.length; i++) {
		const entry = branchEntries[i];
		if (entry?.type === "message") return entry.id;
	}
	return undefined;
}

function entriesFromMessages(messages: any[]): any[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `context-message-${index}`,
		parentId: index > 0 ? `context-message-${index - 1}` : null,
		timestamp: message?.timestamp ?? Date.now(),
		message,
	}));
}

// ============================================================================
// Context construction
// ============================================================================

function findLatestAnchorIndex(messages: any[]): { index: number; anchor: TapeAnchorData } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const anchor = anchorFromMessage(messages[i]);
		if (anchor) return { index: i, anchor };
	}
	return null;
}

function makeSummaryMessage(anchor: TapeAnchorData): any {
	return {
		role: "custom",
		customType: "tape-summary",
		content: `[Previous conversation summary — ${anchor.name}]\n\n${anchor.summary}`,
		display: true,
		timestamp: new Date(anchor.createdAt).getTime(),
	};
}

// ============================================================================
// Rendering
// ============================================================================

function firstSummaryLine(summary: string): string {
	let section: string | undefined;
	let fallback = "";
	for (const rawLine of summary.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (!fallback) fallback = line;
		const heading = line.match(/^#{1,6}\s+(.+)$/);
		if (heading) {
			section = heading[1].replace(/[:：]\s*$/, "");
			continue;
		}
		const text = line
			.replace(/^[-*+]\s+\[[ x]\]\s+/i, "")
			.replace(/^[-*+]\s+/, "")
			.replace(/^\d+\.\s+/, "")
			.trim();
		return `${section ? `${section}: ` : ""}${text}`.slice(0, 100);
	}
	return fallback.slice(0, 100);
}

function sessionLabel(record: TapeRecord | SearchResult, currentSessionFile?: string): string {
	if (currentSessionFile && record.sessionFile === currentSessionFile) return "(current)";
	return path.basename(record.sessionFile ?? "unknown").replace(".jsonl", "");
}

function renderRecordRow(r: TapeRecord, currentSessionFile: string | undefined, indent = ""): string[] {
	return [
		`${indent}${r.name} [${r.entryId.slice(0, 8)}] ${formatTimestampSecond(r.timestamp)} — ${sessionLabel(r, currentSessionFile)}`,
		`${indent}  ${firstSummaryLine(r.summary)}`,
	];
}

function renderViewResults(records: Array<{ record: TapeRecord; onBranch: boolean }>, total: number, offset: number, currentSessionFile?: string): string {
	if (records.length === 0) {
		return total > 0 ? `No records at offset ${offset} (total ${total}).` : "No records in this session.";
	}

	const lines: string[] = [];
	let inOffBranch = false;
	for (const item of records) {
		const r = item.record;
		if (!item.onBranch && !inOffBranch) {
			if (lines.length > 0) lines.push("");
			lines.push("off-branch:");
			inOffBranch = true;
		} else if (lines.length > 0) {
			lines.push("");
		}
		lines.push(...renderRecordRow(r, currentSessionFile, item.onBranch ? "" : "  "));
	}

	return `records (${records.length}/${total}, offset ${offset})\n${lines.join("\n")}`;
}

function renderCrossSessionView(records: TapeRecord[], total: number, offset: number, scope: string, currentSessionFile?: string): string {
	if (records.length === 0) {
		return total > 0 ? `No records at offset ${offset} (total ${total}, scope ${scope}).` : `No records found (scope: ${scope}).`;
	}

	const lines: string[] = [];
	for (const r of records) {
		if (lines.length > 0) lines.push("");
		lines.push(...renderRecordRow(r, currentSessionFile));
	}

	return `records (${records.length}/${total}, offset ${offset}, scope ${scope})\n${lines.join("\n")}`;
}

function renderSearchResults(results: SearchResult[], total: number, offset: number, query: string, kinds: SearchKind[], timeFilterLabel: string, currentSessionFile?: string, showSessionLabel = false): string {
	const isDefaultKinds = kinds.length === DEFAULT_SEARCH_KINDS_SET.size && kinds.every((k) => DEFAULT_SEARCH_KINDS_SET.has(k));
	const kindSuffix = isDefaultKinds ? "" : ` kinds=${kinds.join(",")}`;
	const queryLabel = query ? `"${query}"` : "<all>";
	const suffix = `${kindSuffix}${timeFilterLabel}`;
	if (results.length === 0) return `No entries matching ${queryLabel}${suffix} (offset ${offset}).`;
	const lines = results.map((r) => {
		const metadata = [
			...(showSessionLabel ? [`session=${sessionLabel(r, currentSessionFile)}`] : []),
			`time=${formatTimestampSecond(r.timestamp)}`,
		].join(" ");
		return `- [${r.entryId.slice(0, 8)}] ${r.kind}/${r.role} ${metadata}\n  ${r.preview}`;
	});
	return `search ${queryLabel}${suffix} (${results.length}/${total}, offset ${offset})\n${lines.join("\n\n")}`;
}

function entryViewText(entry: any, sessionFile?: string, sessionCwd?: string): string {
	const items = extractSearchItems(entry, sessionFile, sessionCwd);
	if (items.length > 0) {
		return items.map((item) => `## ${item.kind}/${item.role}\n${item.searchableText}`).join("\n\n");
	}
	return JSON.stringify(entry, null, 2);
}

function renderEntryView(entry: any, sessionFile: string | undefined, sessionCwd: string | undefined, offset: number, limit: number): string {
	const text = entryViewText(entry, sessionFile, sessionCwd);
	const lines = text.split("\n");
	const start = Math.min(offset, lines.length);
	const end = Math.min(lines.length, start + limit);
	const body = lines.slice(start, end).join("\n");
	const suffix = end < lines.length ? `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end} to continue.]` : "";
	return `entry [${String(entry.id ?? "").slice(0, 8)}] ${formatTimestampSecond(normalizeTimestamp(entry.timestamp))}\n${body}${suffix}`;
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "tape",
		label: "Tape",
		description: [
			"Tape-style context management.",
			"anchor: create a semantic boundary with summary.",
			"search: find old entries by keyword with optional kind and time filters.",
			"info: show current tape boundary and context usage.",
			"view: list anchors and compact records, or display an entry by entryId.",
		].join(" "),
		promptSnippet: "Manage semantic context with anchors and searchable history",
		promptGuidelines: [
			"Use tape(action='anchor', name=..., summary=...) when switching topics or after a major task completes.",
			"When context usage is high, use tape(action='anchor') to checkpoint before continuing.",
			"Use tape(action='view') to discover anchors and compact records, or tape(action='view', entryId=...) to inspect a search result.",
			"Use tape(action='search', query=...) to recover old messages, tool results, or prior context when returning to an older topic.",
			"Use tape(action='info') to check anchor count and context usage.",
			"Prefer pi-style structured summaries: Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context.",
		],
		parameters: Type.Object({
			action: StringEnum(["info", "anchor", "view", "search"] as const, {
				description: "Action to perform",
			}),
			name: Type.Optional(Type.String({ description: "Anchor name (must be unique). Required for anchor." })),
			summary: Type.Optional(Type.String({ description: "Retrospective state summary. Required for anchor." })),
			entryId: Type.Optional(Type.String({ description: "Entry ID/prefix to display with action='view'." })),
			sessionFile: Type.Optional(Type.String({ description: "Session file path for entry lookup, usually from search results." })),
			query: Type.Optional(Type.String({ description: "Search query. Space means AND; | means OR. Optional when start/end is set." })),
			start: Type.Optional(Type.String({ description: "Inclusive timestamp lower bound for search." })),
			end: Type.Optional(Type.String({ description: "Inclusive timestamp upper bound for search." })),
			kinds: Type.Optional(Type.Array(StringEnum(SEARCH_KINDS, {
				description: "Entry kinds to search. Default: message + tool_result.",
			}))),
			scope: Type.Optional(StringEnum(["branch", "session", "cwd", "all"] as const, {
				description: "Scope. Default: session for search, cwd for view.",
			})),
			limit: Type.Optional(Type.Number({ description: "Max results/lines. Default: 20 for view records, 200 for entry view, 10 for search." })),
			offset: Type.Optional(Type.Number({ description: "Skip N records/lines. Default: 0." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const branchEntries = ctx.sessionManager.getBranch() as any[];
			const sessionEntries = ctx.sessionManager.getEntries() as any[];
			const sessionFile = ctx.sessionManager.getSessionFile();
			const currentBranchAnchors = anchorRecordsFromEntries(branchEntries, sessionFile, ctx.cwd);

			switch (params.action) {
				// ── info ─────────────────────────────────────────
				case "info": {
					const sessionAnchors = anchorRecordsFromEntries(sessionEntries, sessionFile, ctx.cwd);
					const latest = currentBranchAnchors.at(-1);
					const usage = ctx.getContextUsage?.();
					const lines = [
						`branch anchors: ${currentBranchAnchors.length}`,
						`session anchors: ${sessionAnchors.length}`,
						`latest boundary: ${latest ? latest.name : "(none)"}`,
					];
					if (usage?.tokens != null) {
						lines.push(`context: ${usage.tokens}/${usage.contextWindow}`);
					}
					if (latest) {
						const anchorIdx = branchEntries.findIndex((e: any) => e.id === latest.entryId);
						if (anchorIdx >= 0) {
							lines.push(`entries after boundary: ${branchEntries.length - anchorIdx - 1}`);
						}
					}
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { branchAnchors: currentBranchAnchors.length, sessionAnchors: sessionAnchors.length, latest, usage },
					};
				}

				// ── anchor ──────────────────────────────────────
				case "anchor": {
					if (!params.name || !params.summary) {
						return { content: [{ type: "text", text: "`name` and `summary` are required for anchor." }], details: {} };
					}
					if (params.name.startsWith("compact/")) {
						return { content: [{ type: "text", text: "Anchor names starting with `compact/` are reserved for compact records." }], details: {} };
					}
					const existing = currentBranchAnchors.find((a) => a.name === params.name);
					if (existing) {
						return { content: [{ type: "text", text: `Anchor "${params.name}" already exists on this branch at [${existing.entryId.slice(0, 8)}]. Choose a new name.` }], details: {} };
					}

					const keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS;
					const firstKeptEntryId = calculateFirstKeptEntryId(branchEntries, keepRecentTokens);

					const tapeAnchor: TapeAnchorData = {
						version: 1,
						name: params.name,
						summary: params.summary,
						keepRecentTokens,
						firstKeptEntryId,
						createdAt: new Date().toISOString(),
						source: {
							cwd: ctx.cwd,
							sessionFile,
							leafId: ctx.sessionManager.getLeafId() ?? undefined,
						},
					};

					return {
						content: [{ type: "text", text: `[Anchor: ${params.name}]\n${params.summary}` }],
						details: { tapeAnchor },
					};
				}

				// ── view ────────────────────────────────────────
				case "view": {
					const scope = params.scope ?? "cwd";
					const limit = Math.max(0, Math.trunc(params.limit ?? (params.entryId ? 200 : 20)));
					const offset = Math.max(0, Math.trunc(params.offset ?? 0));

					if (params.entryId) {
						const entryId = params.entryId;
						const candidates: Array<{ entry: any; file?: string; cwd?: string }> = [];
						const addMatches = (entries: any[], file?: string, cwd?: string) => {
							for (const entry of entries) {
								if (typeof entry?.id === "string" && entry.id.startsWith(entryId)) candidates.push({ entry, file, cwd });
							}
						};

						if (params.sessionFile) {
							const parsed = sessionEntriesForScan({ file: params.sessionFile }, sessionFile, sessionEntries, ctx.cwd);
							if (parsed) addMatches(parsed.entries, parsed.file, parsed.cwd);
						} else if (scope === "branch") {
							addMatches(branchEntries, sessionFile, ctx.cwd);
						} else if (scope === "session") {
							addMatches(sessionEntries, sessionFile, ctx.cwd);
						} else {
							for (const item of listSessionFiles()) {
								if (signal?.aborted) break;
								const parsed = sessionEntriesForScan(item, sessionFile, sessionEntries, ctx.cwd);
								if (!parsed) continue;
								if (scope === "cwd" && parsed.cwd !== ctx.cwd) continue;
								addMatches(parsed.entries, parsed.file, parsed.cwd);
							}
						}

						if (candidates.length === 0) {
							return { content: [{ type: "text", text: `No entry matching ${entryId}.` }], details: { entryId } };
						}
						if (candidates.length > 1) {
							const lines = candidates.slice(0, 10).map((c) => `- [${c.entry.id.slice(0, 8)}] session=${sessionLabel({ sessionFile: c.file } as SearchResult, sessionFile)} time=${formatTimestampSecond(normalizeTimestamp(c.entry.timestamp))}`);
							return { content: [{ type: "text", text: `Entry prefix ${entryId} is ambiguous (${candidates.length} matches):\n${lines.join("\n")}` }], details: { entryId, matches: candidates.length } };
						}

						const found = candidates[0];
						return {
							content: [{ type: "text", text: renderEntryView(found.entry, found.file, found.cwd, offset, Math.max(1, limit)) }],
							details: { entryId: found.entry.id, sessionFile: found.file, sessionCwd: found.cwd, offset, limit },
						};
					}

					if (scope === "branch" || scope === "session") {
						const sessionRecords = tapeRecordsFromEntries(sessionEntries, sessionFile, ctx.cwd);
						const currentBranchIds = new Set(branchEntries.map((e: any) => e.id));
						const onBranch = sessionRecords.filter((a) => currentBranchIds.has(a.entryId)).reverse();
						let ordered: Array<{ record: TapeRecord; onBranch: boolean }>;
						if (scope === "branch") {
							ordered = onBranch.map((record) => ({ record, onBranch: true }));
						} else {
							const offBranch = sessionRecords.filter((a) => !currentBranchIds.has(a.entryId)).reverse();
							ordered = [
								...onBranch.map((record) => ({ record, onBranch: true })),
								...offBranch.map((record) => ({ record, onBranch: false })),
							];
						}

						if (ordered.length === 0) {
							return { content: [{ type: "text", text: "No records found." }], details: { records: 0 } };
						}

						const shown = ordered.slice(offset, offset + limit);
						return {
							content: [{ type: "text", text: renderViewResults(shown, ordered.length, offset, sessionFile) }],
							details: { total: ordered.length, shown: shown.length, offset, limit },
						};
					}

					// cwd or all — scan session files
					const allRecords: TapeRecord[] = [];
					for (const item of listSessionFiles()) {
						if (signal?.aborted) break;
						const parsed = sessionEntriesForScan(item, sessionFile, sessionEntries, ctx.cwd);
						if (!parsed) continue;
						if (scope === "cwd" && parsed.cwd !== ctx.cwd) continue;
						allRecords.push(...tapeRecordsFromEntries(parsed.entries, parsed.file, parsed.cwd));
					}

					allRecords.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
					const dedupedRecords = dedupeTapeRecords(allRecords);
					const total = dedupedRecords.length;
					const page = dedupedRecords.slice(offset, offset + limit);

					return {
						content: [{ type: "text", text: renderCrossSessionView(page, total, offset, scope, sessionFile) }],
						details: { total, shown: page.length, offset, limit, scope },
					};
				}

				// ── search ──────────────────────────────────────
				case "search": {
					const query = params.query ?? "";
					const start = parseFilterTimestamp(params.start, "start");
					if (start.error) return { content: [{ type: "text", text: start.error }], details: {} };
					const end = parseFilterTimestamp(params.end, "end");
					if (end.error) return { content: [{ type: "text", text: end.error }], details: {} };
					if (!query.trim() && start.value == null && end.value == null) {
						return { content: [{ type: "text", text: "`query`, `start`, or `end` is required for search." }], details: {} };
					}

					const scope = params.scope ?? "session";
					const kinds = normalizeSearchKinds(params.kinds);
					const queryExpr = parseQuery(query);
					const timeFilter = { start: start.value, end: end.value };
					const timeFilterLabel = `${params.start ? ` start=${params.start}` : ""}${params.end ? ` end=${params.end}` : ""}`;
					const limit = Math.max(0, Math.trunc(params.limit ?? 10));
					const offset = Math.max(0, Math.trunc(params.offset ?? 0));

					let allMatches: SearchResult[];

					if (scope === "branch") {
						allMatches = matchEntries(branchEntries, queryExpr, kinds, timeFilter, sessionFile, ctx.cwd);
					} else if (scope === "session") {
						allMatches = matchEntries(sessionEntries, queryExpr, kinds, timeFilter, sessionFile, ctx.cwd);
					} else {
						allMatches = [];
						for (const item of listSessionFiles()) {
							if (signal?.aborted) break;
							const parsed = sessionEntriesForScan(item, sessionFile, sessionEntries, ctx.cwd);
							if (!parsed) continue;
							if (scope === "cwd" && parsed.cwd !== ctx.cwd) continue;
							allMatches.push(...matchEntries(parsed.entries, queryExpr, kinds, timeFilter, parsed.file, parsed.cwd));
						}
					}

					// Newest first
					allMatches.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
					const dedupedMatches = dedupeSearchResults(allMatches);
					const total = dedupedMatches.length;
					const page = dedupedMatches.slice(offset, offset + limit);

					return {
						content: [{ type: "text", text: renderSearchResults(page, total, offset, query, kinds, timeFilterLabel, sessionFile, scope === "cwd" || scope === "all") }],
						details: { results: page, total, scope, kinds, query, start: params.start, end: params.end, offset, limit },
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
			}
		},
	});

	// ── Context hook: rebuild context from latest anchor ─────────────
	pi.on("context", async (event) => {
		const messages = event.messages as any[];
		if (!messages || messages.length === 0) return;

		const latest = findLatestAnchorIndex(messages);
		if (!latest) return;

		const { index: anchorIdx, anchor } = latest;
		const keepTokens = anchor.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;

		// Find where the anchor starts (include its assistant toolCall message)
		let anchorStartIdx = anchorIdx;
		if (anchorIdx > 0 && messages[anchorIdx - 1]?.role === "assistant") {
			anchorStartIdx = anchorIdx - 1;
		}

		// Calculate a compact-compatible cut point before the anchor.
		// This keeps the transcript valid by never starting from a toolResult.
		const entries = entriesFromMessages(messages);
		const cutPoint = findCutPoint(entries, 0, anchorStartIdx, keepTokens);
		const keepFromIdx = cutPoint.isSplitTurn && cutPoint.turnStartIndex >= 0
			? cutPoint.turnStartIndex
			: cutPoint.firstKeptEntryIndex;

		// If everything fits, no need to trim
		if (keepFromIdx === 0) return;

		const summaryMsg = makeSummaryMessage(anchor);
		const kept = messages.slice(keepFromIdx);

		return { messages: [summaryMsg, ...kept] };
	});
}
