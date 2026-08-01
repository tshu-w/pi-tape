/**
 * pi-tape — Tape-style context management for pi.
 *
 * Anchors are stored as tool results with `details.tapeAnchor`, so they
 * persist in the session file without separate storage. A context hook
 * rebuilds the model context from the latest anchor: its summary is
 * injected as history, followed by a recent-message window cut at
 * compact-compatible points (never starting from a toolResult).
 *
 * Native compaction coexists with anchors — whichever boundary is later
 * effectively wins. An active anchor rebuilds model context; native
 * compaction (manual or automatic) summarizes that projected context rather
 * than the raw branch.
 *
 * Recall follows grep -> read: search returns bounded previews; full
 * content is read via view(entryId) with line pagination. Tape's own
 * tool calls/results are excluded from search indexing to avoid echoes.
 *
 * Notes are the mutable half of the memory model: the tape is an
 * append-only log of what happened, notes files hold durable
 * cross-session facts the model maintains with standard file tools.
 * Notes (global + per-project) and a session-start snapshot of recent
 * cwd anchors are appended to the system prompt via before_agent_start.
 * The snapshot is frozen per session so creating an anchor never
 * changes the system prompt (and never invalidates the prompt-cache
 * prefix); anchors created this session are surfaced by the anchor
 * tool result itself, which survives the context rebuild.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	buildContextEntries,
	compact,
	findCutPoint,
	getAgentDir,
	keyText,
	sessionEntryToContextMessages,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderToolCall } from "./render-call.js";
import { withToolOutputContract } from "./tool-output.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_KEEP_RECENT_TOKENS = 20000;
const ANCHOR_NAME_MAX_LENGTH = 80;
const ANCHOR_NAME_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;
const NOTES_BUDGET_LINES = 150;
const NOTES_MAX_LINES = 400;
const NOTES_MAX_BYTES = 16 * 1024;
const RECENT_ANCHORS_LIMIT = 10;
const SEARCH_PREVIEW_LENGTH = 200;
const COLLAPSED_LIST_ITEMS = 5;
const COLLAPSED_TEXT_LINES = 15;
const DEFAULT_SEARCH_KINDS = ["message", "tool_result"] as const;
const SEARCH_KINDS = ["message", "tool_result", "tool_call", "anchor", "compact", "summary", "custom"] as const;
const SEARCH_INTERNAL_TOOL_NAMES = new Set(["tape"]);

// ============================================================================
// Types
// ============================================================================

interface TapeAnchorData {
	version: 1;
	name: string;
	summary: string;
	keepRecentTokens: number;
	createdAt: string;
	source: {
		cwd: string;
		sessionFile?: string;
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
	toolName?: string;
	searchableText: string;
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
	toolName?: string;
	preview: string;
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

function sessionFilesInDir(dir: string): Array<{ file: string; mtime: number }> {
	if (!fs.existsSync(dir)) return [];
	const files: Array<{ file: string; mtime: number }> = [];
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const file = path.join(dir, name);
		try {
			files.push({ file, mtime: fs.statSync(file).mtimeMs });
		} catch { /* skip */ }
	}
	return files;
}

function listSessionFiles(sessionDir?: string, sessionFile?: string): Array<{ file: string; mtime: number }> {
	const defaultRoot = getSessionsDir();
	const resolvedSessionDir = sessionDir ? resolvedFilePath(sessionDir) : undefined;
	const usesDefaultLayout = resolvedSessionDir && path.dirname(resolvedSessionDir) === resolvedFilePath(defaultRoot);
	const files = new Map<string, { file: string; mtime: number }>();
	const add = (item: { file: string; mtime: number }) => files.set(resolvedFilePath(item.file), item);

	// The default root remains part of scope=all/cwd even when the active
	// session uses a custom directory; add that custom directory as a second
	// source rather than replacing the user's regular history.
	if (fs.existsSync(defaultRoot)) {
		for (const dirent of fs.readdirSync(defaultRoot, { withFileTypes: true })) {
			if (!dirent.isDirectory()) continue;
			for (const item of sessionFilesInDir(path.join(defaultRoot, dirent.name))) add(item);
		}
	}
	if (resolvedSessionDir && !usesDefaultLayout) {
		for (const item of sessionFilesInDir(resolvedSessionDir)) add(item);
	}

	if (sessionFile) add({ file: sessionFile, mtime: Number.POSITIVE_INFINITY });
	return [...files.values()].sort((a, b) => b.mtime - a.mtime);
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

function isManagedSessionFile(file: string, sessionDir?: string, sessionFile?: string): boolean {
	if (isCurrentSessionFile(file, sessionFile)) return true;
	if (path.extname(file) !== ".jsonl") return false;
	const resolvedFile = resolvedFilePath(file);
	return [getSessionsDir(), sessionDir].some((dir) => {
		if (!dir) return false;
		const relative = path.relative(resolvedFilePath(dir), resolvedFile);
		return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	});
}

function sessionEntriesForScan(item: { file: string }, sessionFile: string | undefined, sessionEntries: any[], cwd: string): { file: string; cwd?: string; entries: any[] } | null {
	if (isCurrentSessionFile(item.file, sessionFile)) return { file: sessionFile!, cwd, entries: sessionEntries };
	const parsed = parseSessionFile(item.file);
	return parsed ? { file: item.file, ...parsed } : null;
}

// ============================================================================
// Notes files (durable cross-session state)
// ============================================================================

interface NotesFile {
	path: string;
	exists: boolean;
	content: string;
	lines: number;
	truncated: boolean;
}

function cwdSlug(cwd: string): string {
	// TODO: Use collision-resistant paths when project-notes storage is redesigned.
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function globalNotesPath(): string {
	return path.join(getAgentDir(), "tape", "notes.md");
}

function projectNotesPath(cwd: string): string {
	return path.join(getAgentDir(), "tape", cwdSlug(cwd), "notes.md");
}

function displayPath(file: string): string {
	const home = os.homedir();
	return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

function readNotesFile(file: string): NotesFile {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return { path: file, exists: false, content: "", lines: 0, truncated: false };
	}
	const trimmed = raw.trimEnd();
	const lines = trimmed ? trimmed.split("\n").length : 0;
	const truncation = truncateHead(trimmed, { maxLines: NOTES_MAX_LINES, maxBytes: NOTES_MAX_BYTES });
	return { path: file, exists: true, content: truncation.content, lines, truncated: truncation.truncated };
}

function notesStatusLabel(notes: NotesFile): string {
	const over = notes.lines > NOTES_BUDGET_LINES ? ", over budget" : "";
	return `${displayPath(notes.path)}, ${notes.lines}/${NOTES_BUDGET_LINES} lines${over}`;
}

const NOTES_USAGE = [
	"Agent-maintained cross-session notes included in every system prompt. One fact per line; keep each line short; edit the files directly.",
	'Record only: (a) user preferences and corrections — write immediately with a "(user)" prefix; (b) verified environment or external facts that would change future decisions or prevent repeated failure, and have no authoritative home elsewhere.',
	"Never record task state — it belongs in anchors. Project results and findings belong in project docs.",
	"Durable lessons about behavior or procedure belong in the narrowest authoritative source (AGENTS.md, a skill, or a script), not here; keep one source per rule.",
	"Default to the global file; project file only for repo-specific facts. Defer to AGENTS.md on conflict; delete disproven or promoted entries.",
].join("\n");

function renderNotesBlock(cwd: string, recentAnchors: TapeRecord[]): string {
	const globalNotes = readNotesFile(globalNotesPath());
	const projectNotes = readNotesFile(projectNotesPath(cwd));
	const lines: string[] = ["<tape-notes>", NOTES_USAGE];

	if (globalNotes.exists) {
		lines.push(`global (${notesStatusLabel(globalNotes)}):`, globalNotes.content);
	} else {
		lines.push(`global notes: none yet — create ${displayPath(globalNotes.path)}`);
	}
	if (projectNotes.exists) {
		lines.push(`project (${notesStatusLabel(projectNotes)}):`, projectNotes.content);
	} else {
		lines.push(`project notes: none yet — create ${displayPath(projectNotes.path)} for repo-specific facts`);
	}
	for (const notes of [globalNotes, projectNotes]) {
		if (notes.exists && notes.lines > NOTES_BUDGET_LINES) {
			lines.push(`note: ${displayPath(notes.path)} over budget (${notes.lines}/${NOTES_BUDGET_LINES} lines), consider distilling`);
		}
		if (notes.truncated) {
			lines.push(`note: ${displayPath(notes.path)} truncated at ${NOTES_MAX_LINES} lines/${NOTES_MAX_BYTES} bytes — distill required`);
		}
	}
	lines.push("</tape-notes>");

	if (recentAnchors.length > 0) {
		lines.push(`recent anchors (cwd, session-start snapshot): ${recentAnchors.map(anchorItemLabel).join(" · ")}`);
	}
	return lines.join("\n");
}

function anchorItemLabel(r: TapeRecord): string {
	return `[${r.name}] ${formatTimestampSecond(r.timestamp).slice(0, 10)}`;
}

// ============================================================================
// Timestamp helpers
// ============================================================================

function normalizeTimestamp(timestamp: unknown): string {
	if (typeof timestamp === "string") return timestamp;
	if (typeof timestamp === "number") return new Date(timestamp).toISOString();
	return "";
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
	if (Number.isNaN(parsed)) return { error: `\`${name}\` is not a valid timestamp. Use an ISO timestamp or YYYY-MM-DD.` };
	return { value: parsed };
}

function matchesTimeFilter(timestamp: string, filter: TimeFilter): boolean {
	if (filter.start == null && filter.end == null) return true;
	const ms = Date.parse(timestamp);
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
	return tapeRecordsFromEntries(entries, sessionFile, sessionCwd).filter((record) => record.kind === "anchor");
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
// Record index (mtime-keyed cache for cross-session record scans)
// ============================================================================

interface RecordIndexEntry {
	mtime: number;
	cwd?: string;
	records: TapeRecord[];
}

function recordIndexPath(): string {
	return path.join(getAgentDir(), "tape", "index.json");
}

function loadRecordIndex(): Record<string, RecordIndexEntry> {
	try {
		const parsed = JSON.parse(fs.readFileSync(recordIndexPath(), "utf-8"));
		if (parsed?.version === 1 && parsed.files && typeof parsed.files === "object") return parsed.files;
	} catch { /* missing or corrupt — rebuild lazily */ }
	return {};
}

function saveRecordIndex(files: Record<string, RecordIndexEntry>): void {
	const target = recordIndexPath();
	const tmp = `${target}.tmp`;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify({ version: 1, files }));
		fs.renameSync(tmp, target);
	} catch { /* cache only — losing it just means re-parsing */ }
}

/**
 * Collect anchor/compact records across session files. Closed session files
 * never change, so parsed records are cached in an index keyed by mtime and
 * only new or modified files are re-parsed. The current session is always
 * read live from memory. Full-text search is unaffected (it needs entries).
 */
function scanTapeRecords(scope: "cwd" | "all", cwd: string, sessionDir: string | undefined, sessionFile: string | undefined, sessionEntries: any[], signal?: AbortSignal): TapeRecord[] {
	const index = loadRecordIndex();
	const next: Record<string, RecordIndexEntry> = {};
	let dirty = false;
	const records: TapeRecord[] = [];

	for (const item of listSessionFiles(sessionDir, sessionFile)) {
		if (signal?.aborted) throw new Error("Tape operation cancelled.");

		if (isCurrentSessionFile(item.file, sessionFile)) {
			records.push(...tapeRecordsFromEntries(sessionEntries, sessionFile, cwd));
			continue;
		}

		let cached = index[item.file];
		if (!cached || cached.mtime !== item.mtime) {
			const parsed = parseSessionFile(item.file);
			if (!parsed) continue;
			cached = { mtime: item.mtime, cwd: parsed.cwd, records: tapeRecordsFromEntries(parsed.entries, item.file, parsed.cwd) };
			dirty = true;
		}
		next[item.file] = cached;

		if (scope === "cwd" && cached.cwd !== cwd) continue;
		records.push(...cached.records);
	}

	if (dirty || Object.keys(next).length !== Object.keys(index).length) {
		saveRecordIndex(next);
	}
	return records;
}

// ============================================================================
// Entry content extraction (for search)
// ============================================================================

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
			return content ? [{
				kind: "tool_result",
				role: "toolResult",
				toolName: msg.toolName,
				searchableText: content,
				timestamp,
				sessionFile,
				sessionCwd,
			}] : [];
		}

		if (msg.role === "assistant") {
			const items: SearchItem[] = [];
			if (typeof msg.content === "string") {
				if (msg.content) items.push({ kind: "message", role: "assistant", searchableText: msg.content, timestamp, sessionFile, sessionCwd });
			} else if (Array.isArray(msg.content)) {
				const textContent = stringifyContentBlocks(msg.content);
				if (textContent) items.push({ kind: "message", role: "assistant", searchableText: textContent, timestamp, sessionFile, sessionCwd });

				const toolCalls = msg.content
					.filter((block: any) => block?.type === "toolCall" && !SEARCH_INTERNAL_TOOL_NAMES.has(block.name))
					.map((block: any) => `${block.name}(${JSON.stringify(block.arguments)})`)
					.join(" ");
				if (toolCalls) items.push({ kind: "tool_call", role: "assistant", searchableText: toolCalls, timestamp, sessionFile, sessionCwd });
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
		return content ? [{ kind: "message", role, searchableText: content, timestamp, sessionFile, sessionCwd }] : [];
	}
	if (entry.type === "custom_message" && typeof entry.content === "string" && entry.content) {
		return [{ kind: "custom", role: "custom", searchableText: entry.content, timestamp, sessionFile, sessionCwd }];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [{ kind: "summary", role: "branchSummary", searchableText: entry.summary, timestamp, sessionFile, sessionCwd }];
	}
	return [];
}

function normalizeSearchKinds(kinds?: SearchKind[]): SearchKind[] {
	return kinds?.length ? [...new Set(kinds)] : [...DEFAULT_SEARCH_KINDS];
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
		return andTerms[0];
	}
	return undefined;
}

function makePreview(content: string, term: string | undefined): string {
	const matchIdx = term ? content.toLowerCase().indexOf(term) : 0;
	let start = Math.max(0, matchIdx - 50);
	if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start] ?? "")) start--;
	let end = Math.min(content.length, start + SEARCH_PREVIEW_LENGTH);
	if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1] ?? "")) end++;
	let preview = content.slice(start, end).replace(/\n/g, " ");
	if (start > 0) preview = "…" + preview;
	if (end < content.length) preview += "…";
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
			const term = matchingQueryTerm(item.searchableText, query);
			if (query.length > 0 && term === undefined) continue;

			results.push({
				entryId,
				timestamp: item.timestamp,
				kind: item.kind,
				role: item.role,
				toolName: item.toolName,
				preview: makePreview(item.searchableText, term),
				sessionFile: item.sessionFile,
				sessionCwd: item.sessionCwd,
				sourceSessionFile: item.sourceSessionFile,
			});
			break;
		}
	}

	return results;
}

function dedupeRecords<T extends { kind: string; entryId: string; timestamp?: string; sessionFile?: string; sourceSessionFile?: string }>(records: T[]): T[] {
	const seen = new Set<string>();
	return records.filter((record) => {
		const key = record.kind === "anchor"
			? `${record.kind}:${record.sourceSessionFile ?? record.sessionFile ?? ""}:${record.entryId}`
			: `${record.kind}:${record.entryId}:${record.timestamp}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
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

function findAnchorToolCallStartIndex(messages: any[], anchorIndex: number): number {
	const toolCallId = messages[anchorIndex]?.toolCallId;
	for (let i = anchorIndex - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") {
			if (!toolCallId) return i;
			const hasMatchingCall = Array.isArray(message.content) && message.content.some(
				(block: any) => block?.type === "toolCall" && block.id === toolCallId,
			);
			return hasMatchingCall ? i : anchorIndex;
		}
		if (message?.role !== "toolResult") return anchorIndex;
	}
	return anchorIndex;
}

function findAnchorToolCallStartEntryIndex(entries: any[], anchorIndex: number): number {
	const flattened: Array<{ entryIndex: number; message: any }> = [];
	for (let i = 0; i <= anchorIndex; i++) {
		for (const message of sessionEntryToContextMessages(entries[i])) flattened.push({ entryIndex: i, message });
	}
	const flattenedAnchorIndex = flattened.findLastIndex(({ entryIndex, message }) => entryIndex === anchorIndex && !!anchorFromMessage(message));
	if (flattenedAnchorIndex < 0) return anchorIndex;
	const start = findAnchorToolCallStartIndex(flattened.map(({ message }) => message), flattenedAnchorIndex);
	return flattened[start]?.entryIndex ?? anchorIndex;
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

interface ActiveAnchorBoundary {
	entry: any;
	anchor: TapeAnchorData;
}

function findActiveAnchorBoundary(entries: any[]): ActiveAnchorBoundary | null {
	let active: ActiveAnchorBoundary | null = null;
	for (const entry of entries) {
		if (entry?.type === "compaction") {
			active = null;
			continue;
		}
		const anchor = entry?.type === "message" ? anchorFromMessage(entry.message) : null;
		if (anchor) active = { entry, anchor };
	}
	return active;
}

function messagesFromEntries(entries: any[], start: number, end: number): any[] {
	const messages: any[] = [];
	for (let i = start; i < end; i++) {
		messages.push(...sessionEntryToContextMessages(entries[i]));
	}
	return messages;
}

export function prepareProjectedAnchorCompaction(
	branchEntries: any[],
	settings: { keepRecentTokens: number; reserveTokens: number; enabled: boolean },
	tokensBefore: number,
	fileOps: any,
): any | undefined {
	const active = findActiveAnchorBoundary(branchEntries);
	if (!active) return undefined;

	const contextEntries = buildContextEntries(branchEntries);
	const anchorIndex = contextEntries.findIndex((entry: any) => entry?.id === active.entry.id);
	if (anchorIndex < 0) return undefined;

	const anchorStartIndex = findAnchorToolCallStartEntryIndex(contextEntries, anchorIndex);

	const historyCut = findCutPoint(contextEntries, 0, anchorStartIndex, active.anchor.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS);
	const historyKeepFrom = historyCut.isSplitTurn && historyCut.turnStartIndex >= 0
		? historyCut.turnStartIndex
		: historyCut.firstKeptEntryIndex;

	const postAnchorStart = anchorIndex + 1;
	const hasPostAnchorCutPoint = contextEntries.slice(postAnchorStart).some((entry: any) =>
		sessionEntryToContextMessages(entry).some((message: any) => message.role !== "toolResult"),
	);
	const recentCut = hasPostAnchorCutPoint
		? findCutPoint(contextEntries, postAnchorStart, contextEntries.length, settings.keepRecentTokens)
		: { firstKeptEntryIndex: anchorStartIndex, turnStartIndex: -1, isSplitTurn: false };
	const firstKeptEntry = contextEntries[recentCut.firstKeptEntryIndex];
	if (!firstKeptEntry?.id || sessionEntryToContextMessages(firstKeptEntry).every((message: any) => message.role === "toolResult")) return undefined;

	const historyEnd = recentCut.isSplitTurn ? recentCut.turnStartIndex : recentCut.firstKeptEntryIndex;
	const messagesToSummarize = [
		makeSummaryMessage(active.anchor),
		...messagesFromEntries(contextEntries, historyKeepFrom, anchorStartIndex),
		...messagesFromEntries(contextEntries, postAnchorStart, historyEnd),
	];
	const turnPrefixMessages = recentCut.isSplitTurn
		? messagesFromEntries(contextEntries, recentCut.turnStartIndex, recentCut.firstKeptEntryIndex)
		: [];

	return {
		firstKeptEntryId: firstKeptEntry.id,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: recentCut.isSplitTurn,
		tokensBefore,
		previousSummary: undefined,
		fileOps,
		settings,
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
		const preview = `${section ? `${section}: ` : ""}${text}`;
		return `${Array.from(preview).slice(0, 99).join("")}…`;
	}
	return fallback ? `${Array.from(fallback).slice(0, 99).join("")}…` : "";
}

function sessionLabel(record: { sessionFile?: string }, currentSessionFile?: string): string {
	if ((!currentSessionFile && !record.sessionFile) || (currentSessionFile && record.sessionFile === currentSessionFile)) {
		return "current";
	}
	return path.basename(record.sessionFile ?? "unknown").replace(".jsonl", "");
}

function renderRecordRow(r: TapeRecord, currentSessionFile: string | undefined, indent = ""): string[] {
	return [
		`${indent}- name=${r.name} entryId=${r.entryId.slice(0, 8)} time=${formatTimestampSecond(r.timestamp)} session=${sessionLabel(r, currentSessionFile)}`,
		`${indent}  summary: ${JSON.stringify(firstSummaryLine(r.summary))}`,
	];
}

function continuationNotice(unit: "records" | "results", total: number, offset: number, shown: number): string {
	const nextOffset = offset + shown;
	const remaining = total - nextOffset;
	return remaining > 0 ? `\n\n[${remaining} more ${unit}. Use offset=${nextOffset} to continue.]` : "";
}

function renderViewResults(records: Array<{ record: TapeRecord; onBranch: boolean }>, total: number, offset: number, currentSessionFile?: string): string {
	if (records.length === 0) {
		return total > 0 ? `No records at offset ${offset} (total ${total}).` : "No records found.";
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

	return `records (${records.length}/${total})\n\n${lines.join("\n")}` +
		continuationNotice("records", total, offset, records.length);
}

function renderCrossSessionView(records: TapeRecord[], total: number, offset: number, currentSessionFile?: string): string {
	if (records.length === 0) {
		return total > 0 ? `No records at offset ${offset} (total ${total}).` : "No records found.";
	}

	const lines: string[] = [];
	for (const r of records) {
		if (lines.length > 0) lines.push("");
		lines.push(...renderRecordRow(r, currentSessionFile));
	}

	return `records (${records.length}/${total})\n\n${lines.join("\n")}` +
		continuationNotice("records", total, offset, records.length);
}

function renderSearchResults(results: SearchResult[], total: number, offset: number, currentSessionFile?: string, showSessionFile = false): string {
	if (results.length === 0) {
		return total > 0 ? `No entries at offset ${offset} (total ${total}).` : "No entries found.";
	}
	const records = results.map((result) => {
		let header = `- entryId=${result.entryId.slice(0, 8)} kind=${result.kind}`;
		if (result.kind === "message") header += ` role=${result.role}`;
		if (result.toolName) header += ` tool=${result.toolName}`;
		header += ` time=${formatTimestampSecond(result.timestamp)}`;
		const lines = [header];
		if (showSessionFile) lines.push(`  sessionFile: ${result.sessionFile ?? ""}`);
		lines.push(`  preview: ${JSON.stringify(result.preview)}`);
		return lines.join("\n");
	});
	return `search results (${results.length}/${total})\n\n${records.join("\n\n")}` +
		continuationNotice("results", total, offset, results.length) +
		'\n\n[Use tape(action="view", entryId="<entryId>", sessionFile="<sessionFile>") to inspect a result.]';
}

function messageViewText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return message?.summary ?? "";
	return message.content
		.map((block: any) => {
			if (typeof block === "string") return block;
			if (block?.type === "text") return block.text ?? "";
			if (block?.type === "thinking") return block.thinking ?? "";
			if (block?.type === "toolCall") {
				return `toolCall name=${block.name} arguments=${JSON.stringify(block.arguments ?? {})}`;
			}
			if (block?.type === "image") return `image mimeType=${block.mimeType ?? "unknown"}`;
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function entryViewContent(entry: any): { attributes: string[]; text: string } {
	const anchor = anchorFromEntry(entry);
	if (anchor) return { attributes: ["type=anchor", `name=${anchor.name}`], text: anchor.summary };

	const compactRecord = compactFromEntry(entry);
	if (compactRecord) {
		return { attributes: ["type=compaction", `name=${compactRecord.name}`], text: compactRecord.summary };
	}

	if (entry?.type === "message" && entry.message) {
		const message = entry.message;
		const attributes = ["type=message", `role=${message.role ?? "unknown"}`];
		if (message.toolName) attributes.push(`tool=${message.toolName}`);
		return { attributes, text: messageViewText(message) || JSON.stringify(entry, null, 2) };
	}
	if (entry?.type === "branch_summary") {
		return { attributes: ["type=branch_summary"], text: entry.summary ?? "" };
	}
	if (entry?.type === "custom_message") {
		return { attributes: ["type=custom_message"], text: entry.content ?? "" };
	}
	return { attributes: [`type=${entry?.type ?? "unknown"}`], text: JSON.stringify(entry, null, 2) };
}

function renderEntryView(entry: any, offset: number, limit?: number): { text: string; totalLines: number; shownLines: number } {
	const view = entryViewContent(entry);
	const lines = view.text.split("\n");
	const start = offset - 1;
	if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of entry (${lines.length} lines total).`);
	const end = limit == null ? lines.length : Math.min(lines.length, start + limit);
	const body = lines.slice(start, end).join("\n");
	const suffix = end < lines.length ? `\n\n[Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]` : "";
	const header = `entryId=${String(entry.id ?? "").slice(0, 8)} ${view.attributes.join(" ")} time=${formatTimestampSecond(normalizeTimestamp(entry.timestamp))}`;
	return {
		text: `${header}\n\n${body}${suffix}`,
		totalLines: lines.length,
		shownLines: end - start,
	};
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerTool(withToolOutputContract({
		name: "tape",
		label: "Tape",
		description: [
			"Manage semantic context with anchors and searchable history.",
			"anchor: create a semantic boundary with a slug and retrospective summary.",
			"view: list anchors and compact records, or display an entry by entryId.",
			"search: find old entries by text with optional kind and time filters.",
			"info: show the active boundary, anchor counts, and context usage.",
		].join(" "),
		promptSnippet: "Manage semantic context with anchors and searchable history",
		promptGuidelines: [
			"Use tape(action='anchor', name=..., summary=...) when switching topics, after a major task completes, or before continuing when context usage is high.",
			"Use tape(action='view') to list records. To inspect a search result, pass its entryId and sessionFile when present.",
			"Use tape(action='search', query=...) to recover old messages, tool results, or prior context when returning to an older topic.",
			"Use tape(action='info') to check the active boundary and context usage.",
			"For tape anchor summaries, prefer: Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context.",
		],
		parameters: Type.Object({
			action: StringEnum(["info", "anchor", "view", "search"] as const, {
				description: "Action to perform",
			}),
			name: Type.Optional(Type.String({
				description: "Anchor slug, unique per branch (required for anchor; compact/ prefix is reserved)",
				minLength: 1,
				maxLength: ANCHOR_NAME_MAX_LENGTH,
				pattern: ANCHOR_NAME_PATTERN.source,
			})),
			summary: Type.Optional(Type.String({
				description: "Retrospective state summary (required for anchor)",
				minLength: 1,
				pattern: "\\S",
			})),
			entryId: Type.Optional(Type.String({ description: "Entry ID or prefix to display (view only)" })),
			sessionFile: Type.Optional(Type.String({ description: "Session file for entry lookup (requires entryId; usually returned by search)" })),
			query: Type.Optional(Type.String({ description: "Case-insensitive substring query; spaces mean AND, | means OR (optional when start/end is set)" })),
			start: Type.Optional(Type.String({ description: "Inclusive start time: ISO timestamp or YYYY-MM-DD (local day start)." })),
			end: Type.Optional(Type.String({ description: "Inclusive end time: ISO timestamp or YYYY-MM-DD (local day end)." })),
			kinds: Type.Optional(Type.Array(StringEnum(SEARCH_KINDS), {
				description: "Entry kinds to search (default: message + tool_result)",
			})),
			scope: Type.Optional(StringEnum(["branch", "session", "cwd", "all"] as const, {
				description: "Search/view scope (default: session for search, cwd for view)",
			})),
			limit: Type.Optional(Type.Integer({ description: "Maximum records, search results, or entry lines (defaults: 20 records, 10 results; no explicit entry limit)" })),
			offset: Type.Optional(Type.Integer({ description: "Pagination offset (lists: 0-based, default 0; entry lines: 1-based, default 1)" })),
		}),
		renderCall(args, theme, context) {
			const resultReady = !context.isPartial;
			return renderToolCall(
				"tape",
				args,
				theme,
				resultReady,
				resultReady && !context.isError,
				context.lastComponent,
			);
		},
		renderResult(result, { expanded }, theme, context) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			if (context.isError) return new Text(theme.fg("error", text), 0, 0);
			if (expanded) return new Text(theme.fg("toolOutput", text), 0, 0);

			if (context.args.action === "view" && context.args.entryId !== undefined) {
				const shownLines = (result.details as { shownLines?: number } | undefined)?.shownLines;
				const separator = text.indexOf("\n\n");
				if (shownLines === undefined || shownLines <= COLLAPSED_TEXT_LINES || separator < 0) {
					return new Text(theme.fg("toolOutput", text), 0, 0);
				}
				const header = text.slice(0, separator);
				const bodyLines = text.slice(separator + 2).split("\n").slice(0, COLLAPSED_TEXT_LINES);
				const hidden = shownLines - COLLAPSED_TEXT_LINES;
				const hint = theme.fg(
					"dim",
					`... (${hidden} entry ${hidden === 1 ? "line" : "lines"} hidden, ${keyText("app.tools.expand")} to expand)`,
				);
				return new Text(`${theme.fg("toolOutput", header)}\n\n${theme.fg("toolOutput", bodyLines.join("\n"))}\n\n${hint}`, 0, 0);
			}

			if (context.args.action === "anchor") {
				const summary = (result.details as { tapeAnchor?: { summary?: string } } | undefined)?.tapeAnchor?.summary;
				const summaryLines = summary?.split("\n");
				if (!summaryLines || summaryLines.length <= COLLAPSED_TEXT_LINES) {
					return new Text(theme.fg("toolOutput", text), 0, 0);
				}
				const header = text.split("\n", 1)[0]!;
				const hidden = summaryLines.length - COLLAPSED_TEXT_LINES;
				const hint = theme.fg(
					"dim",
					`... (${hidden} summary ${hidden === 1 ? "line" : "lines"} hidden, ${keyText("app.tools.expand")} to expand)`,
				);
				return new Text(
					`${theme.fg("toolOutput", header)}\n${theme.fg("toolOutput", summaryLines.slice(0, COLLAPSED_TEXT_LINES).join("\n"))}\n\n${hint}`,
					0,
					0,
				);
			}

			const sections = text.split("\n\n");
			let itemSections: string[];
			let itemLabel: "result" | "record";
			if (context.args.action === "search") {
				itemSections = sections.filter((section) => section.startsWith("- entryId="));
				itemLabel = "result";
			} else if (context.args.action === "view" && context.args.entryId === undefined) {
				itemSections = sections.filter((section) => /^(?:off-branch:\n)? {0,2}- name=/.test(section));
				itemLabel = "record";
			} else {
				return new Text(theme.fg("toolOutput", text), 0, 0);
			}

			if (itemSections.length <= COLLAPSED_LIST_ITEMS) {
				return new Text(theme.fg("toolOutput", text), 0, 0);
			}

			const visible = [sections[0]!, ...itemSections.slice(0, COLLAPSED_LIST_ITEMS)]
				.map((section) => theme.fg("toolOutput", section));
			const hidden = itemSections.length - COLLAPSED_LIST_ITEMS;
			visible.push(theme.fg(
				"dim",
				`... (${hidden} ${itemLabel}${hidden === 1 ? "" : "s"} hidden, ${keyText("app.tools.expand")} to expand)`,
			));
			return new Text(visible.join("\n\n"), 0, 0);
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Tape operation cancelled.");
			const branchEntries = ctx.sessionManager.getBranch() as any[];
			const sessionEntries = ctx.sessionManager.getEntries() as any[];
			const sessionDir = ctx.sessionManager.getSessionDir();
			const sessionFile = ctx.sessionManager.getSessionFile();

			switch (params.action) {
				// ── info ─────────────────────────────────────────
				case "info": {
					const currentBranchRecords = tapeRecordsFromEntries(branchEntries, sessionFile, ctx.cwd);
					const currentBranchAnchors = currentBranchRecords.filter((record) => record.kind === "anchor");
					const sessionAnchors = anchorRecordsFromEntries(sessionEntries, sessionFile, ctx.cwd);
					const boundary = currentBranchRecords.at(-1);
					const boundaryIndex = boundary ? branchEntries.findIndex((entry: any) => entry.id === boundary.entryId) : -1;
					const entriesAfterBoundary = boundaryIndex >= 0 ? branchEntries.length - boundaryIndex - 1 : null;
					const usage = ctx.getContextUsage?.() ?? null;
					const boundaryLabel = boundary
						? `${boundary.name} [${boundary.entryId.slice(0, 8)}] ${formatTimestampSecond(boundary.timestamp)}`
						: "(none)";
					const lines = [
						`active boundary: ${boundaryLabel}`,
						`branch anchors: ${currentBranchAnchors.length}`,
						`session anchors: ${sessionAnchors.length}`,
					];
					if (usage?.tokens != null) {
						lines.push(`context: ${usage.tokens}/${usage.contextWindow}`);
					}
					if (entriesAfterBoundary != null) {
						lines.push(`entries after boundary: ${entriesAfterBoundary}`);
					}
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: {
							branchAnchors: currentBranchAnchors.length,
							sessionAnchors: sessionAnchors.length,
							boundary: boundary ? {
								kind: boundary.kind,
								entryId: boundary.entryId,
								name: boundary.name,
								timestamp: boundary.timestamp,
							} : null,
							entriesAfterBoundary,
							usage,
						},
					};
				}

				// ── anchor ──────────────────────────────────────
				case "anchor": {
					if (!params.name || !params.summary) {
						throw new Error("`name` and `summary` are required for anchor.");
					}
					if (!params.summary.trim()) {
						throw new Error("`summary` must contain at least one non-whitespace character.");
					}
					if (params.name.length > ANCHOR_NAME_MAX_LENGTH || !ANCHOR_NAME_PATTERN.test(params.name)) {
						throw new Error(`Anchor name must be a lowercase slug of at most ${ANCHOR_NAME_MAX_LENGTH} characters; use hyphens or underscores within segments and / between segments.`);
					}
					if (params.name.startsWith("compact/")) {
						throw new Error("Anchor names starting with `compact/` are reserved for compact records.");
					}
					const currentBranchAnchors = anchorRecordsFromEntries(branchEntries, sessionFile, ctx.cwd);
					const existing = currentBranchAnchors.find((a) => a.name === params.name);
					if (existing) {
						throw new Error(`Anchor "${params.name}" already exists on this branch at [${existing.entryId.slice(0, 8)}]. Choose a new name.`);
					}

					const tapeAnchor: TapeAnchorData = {
						version: 1,
						name: params.name,
						summary: params.summary,
						keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
						createdAt: new Date().toISOString(),
						source: {
							cwd: ctx.cwd,
							sessionFile,
						},
					};

					const priorAnchors = currentBranchAnchors.slice(-RECENT_ANCHORS_LIMIT).reverse();
					const priorLine = priorAnchors.length > 0
						? `\n\nrecent anchors (this branch): ${priorAnchors.map(anchorItemLabel).join(" · ")}`
						: "";

					return {
						content: [{ type: "text", text: `Anchor created: ${params.name}\n${params.summary}${priorLine}` }],
						details: { tapeAnchor },
					};
				}

				// ── view ────────────────────────────────────────
				case "view": {
					const scope = params.scope ?? "cwd";
					if (params.entryId !== undefined && !params.entryId.trim()) {
						throw new Error("`entryId` must be a non-empty entry ID or prefix.");
					}
					if (params.sessionFile !== undefined && params.entryId === undefined) {
						throw new Error("`sessionFile` requires `entryId`.");
					}

					if (params.entryId !== undefined) {
						const entryId = params.entryId;
						const limit = params.limit === undefined ? undefined : Math.max(1, Math.trunc(params.limit));
						const offset = Math.max(1, Math.trunc(params.offset ?? 1));
						const candidates: Array<{ entry: any; file?: string; cwd?: string }> = [];
						const addMatches = (entries: any[], file?: string, cwd?: string) => {
							for (const entry of entries) {
								if (typeof entry?.id === "string" && entry.id.startsWith(entryId)) candidates.push({ entry, file, cwd });
							}
						};

						if (params.sessionFile) {
							if (!isManagedSessionFile(params.sessionFile, sessionDir, sessionFile)) {
								throw new Error("`sessionFile` must be the current session or a file from the configured session directories.");
							}
							const parsed = sessionEntriesForScan({ file: params.sessionFile }, sessionFile, sessionEntries, ctx.cwd);
							if (parsed) addMatches(parsed.entries, parsed.file, parsed.cwd);
						} else if (scope === "branch") {
							addMatches(branchEntries, sessionFile, ctx.cwd);
						} else if (scope === "session") {
							addMatches(sessionEntries, sessionFile, ctx.cwd);
						} else {
							for (const item of listSessionFiles(sessionDir, sessionFile)) {
								if (signal?.aborted) throw new Error("Tape operation cancelled.");
								const parsed = sessionEntriesForScan(item, sessionFile, sessionEntries, ctx.cwd);
								if (!parsed) continue;
								if (scope === "cwd" && parsed.cwd !== ctx.cwd) continue;
								addMatches(parsed.entries, parsed.file, parsed.cwd);
							}
						}

						if (candidates.length === 0) {
							throw new Error("No entry matches the provided `entryId` prefix.");
						}
						if (candidates.length > 1) {
							const lines = candidates.slice(0, 10).map((candidate) => {
								const candidateFile = candidate.file ? JSON.stringify(candidate.file) : "(current)";
								return `- entryId=${JSON.stringify(candidate.entry.id)} sessionFile=${candidateFile} time=${formatTimestampSecond(normalizeTimestamp(candidate.entry.timestamp))}`;
							});
							throw new Error(`The provided \`entryId\` prefix is ambiguous (${candidates.length} matches):\n${lines.join("\n")}\nChoose one candidate and retry with its full entryId and sessionFile when available.`);
						}

						const found = candidates[0];
						const rendered = renderEntryView(found.entry, offset, limit);
						return {
							content: [{ type: "text", text: rendered.text }],
							details: {
								entryId: found.entry.id,
								sessionFile: found.file,
								sessionCwd: found.cwd,
								totalLines: rendered.totalLines,
								shownLines: rendered.shownLines,
								offset,
								limit: limit ?? null,
							},
						};
					}

					const limit = Math.max(1, Math.trunc(params.limit ?? 20));
					const offset = Math.max(0, Math.trunc(params.offset ?? 0));

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

						const shown = ordered.slice(offset, offset + limit);
						return {
							content: [{ type: "text", text: renderViewResults(shown, ordered.length, offset, sessionFile) }],
							details: { total: ordered.length, shown: shown.length, offset, limit, scope },
						};
					}

					// cwd or all — scan session files (index-cached)
					const allRecords = scanTapeRecords(scope, ctx.cwd, sessionDir, sessionFile, sessionEntries, signal);

					allRecords.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
					const dedupedRecords = dedupeRecords(allRecords);
					const total = dedupedRecords.length;
					const page = dedupedRecords.slice(offset, offset + limit);

					return {
						content: [{ type: "text", text: renderCrossSessionView(page, total, offset, sessionFile) }],
						details: { total, shown: page.length, offset, limit, scope },
					};
				}

				// ── search ──────────────────────────────────────
				case "search": {
					const query = params.query ?? "";
					const start = parseFilterTimestamp(params.start, "start");
					if (start.error) throw new Error(start.error);
					const end = parseFilterTimestamp(params.end, "end");
					if (end.error) throw new Error(end.error);
					if (!query.trim() && start.value == null && end.value == null) {
						throw new Error("`query`, `start`, or `end` is required for search.");
					}

					const scope = params.scope ?? "session";
					const kinds = normalizeSearchKinds(params.kinds);
					const queryExpr = parseQuery(query);
					if (query.trim() && queryExpr.length === 0) {
						throw new Error("`query` must contain a search term.");
					}
					if (start.value != null && end.value != null && start.value > end.value) {
						throw new Error("`start` must be before or equal to `end`.");
					}
					const timeFilter = { start: start.value, end: end.value };
					const limit = Math.max(1, Math.trunc(params.limit ?? 10));
					const offset = Math.max(0, Math.trunc(params.offset ?? 0));

					let allMatches: SearchResult[];

					if (scope === "branch") {
						allMatches = matchEntries(branchEntries, queryExpr, kinds, timeFilter, sessionFile, ctx.cwd);
					} else if (scope === "session") {
						allMatches = matchEntries(sessionEntries, queryExpr, kinds, timeFilter, sessionFile, ctx.cwd);
					} else {
						allMatches = [];
						for (const item of listSessionFiles(sessionDir, sessionFile)) {
							if (signal?.aborted) throw new Error("Tape operation cancelled.");
							const parsed = sessionEntriesForScan(item, sessionFile, sessionEntries, ctx.cwd);
							if (!parsed) continue;
							if (scope === "cwd" && parsed.cwd !== ctx.cwd) continue;
							allMatches.push(...matchEntries(parsed.entries, queryExpr, kinds, timeFilter, parsed.file, parsed.cwd));
						}
					}

					// Newest first
					allMatches.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
					const dedupedMatches = dedupeRecords(allMatches);
					const total = dedupedMatches.length;
					const page = dedupedMatches.slice(offset, offset + limit);

					return {
						content: [{ type: "text", text: renderSearchResults(page, total, offset, sessionFile, scope === "cwd" || scope === "all") }],
						details: {
							results: page.map((result) => ({
								entryId: result.entryId,
								timestamp: result.timestamp,
								kind: result.kind,
								role: result.role,
								toolName: result.toolName,
								sessionFile: result.sessionFile,
								sessionCwd: result.sessionCwd,
							})),
							total,
							offset,
							limit,
						},
					};
				}

				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	}));

	// ── Notes + recent anchors: system prompt injection ──────────────
	// Cross-session anchors are scanned once per session (rescanned when the
	// session identity changes, e.g. /new or resume), backed by the mtime-keyed
	// record index so unchanged files are not re-parsed. The snapshot is
	// deliberately frozen: anchors created mid-session are shown by the
	// anchor tool result instead, so the system prompt — the head of the
	// prompt-cache prefix — stays byte-identical across turns. Notes files
	// are re-read each turn — unchanged content yields an identical prompt,
	// so prompt caching is unaffected.
	let anchorSnapshot: { sessionId: string; recent: TapeRecord[] } | null = null;

	pi.on("before_agent_start", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionDir = ctx.sessionManager.getSessionDir();
		const sessionFile = ctx.sessionManager.getSessionFile();

		if (anchorSnapshot === null || anchorSnapshot.sessionId !== sessionId) {
			const anchors = scanTapeRecords("cwd", ctx.cwd, sessionDir, sessionFile, ctx.sessionManager.getEntries() as any[], undefined)
				.filter((record) => record.kind === "anchor")
				.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
			anchorSnapshot = { sessionId, recent: dedupeRecords(anchors).slice(0, RECENT_ANCHORS_LIMIT) };
		}

		return { systemPrompt: `${event.systemPrompt}\n\n${renderNotesBlock(ctx.cwd, anchorSnapshot.recent)}` };
	});

	// ── Native compaction: summarize the projected anchor context ────
	// Core compaction prepares from the raw branch and does not run context
	// hooks. When an anchor is the active boundary, replace that preparation
	// with the same projected history the model actually sees.
	pi.on("session_before_compact", async (event, ctx) => {
		if (!ctx.model) return;

		const usageTokens = ctx.getContextUsage?.()?.tokens;
		const preparation = prepareProjectedAnchorCompaction(
			event.branchEntries as any[],
			event.preparation.settings,
			usageTokens ?? event.preparation.tokensBefore,
			event.preparation.fileOps,
		);
		if (!preparation) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) throw new Error(`Tape compaction auth failed: ${auth.error}`);

		const result = await compact(
			preparation,
			ctx.model,
			auth.apiKey,
			auth.headers,
			event.customInstructions,
			event.signal,
			pi.getThinkingLevel(),
			undefined, // ExtensionContext does not expose the active agent streamFn.
			auth.env,
		);
		return { compaction: result };
	});

	// ── Context hook: rebuild context from latest anchor ─────────────
	pi.on("context", async (event, ctx) => {
		const messages = event.messages as any[];
		if (!messages || messages.length === 0) return;

		const active = findActiveAnchorBoundary(ctx.sessionManager.getBranch() as any[]);
		if (!active) return;

		const latest = findLatestAnchorIndex(messages);
		if (!latest || latest.anchor.name !== active.anchor.name || latest.anchor.createdAt !== active.anchor.createdAt) return;

		const { index: anchorIdx, anchor } = latest;
		const keepTokens = anchor.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;

		// Include the whole assistant tool-call batch, even when sibling results
		// appear before the anchor result in parallel tool mode.
		const anchorStartIdx = findAnchorToolCallStartIndex(messages, anchorIdx);

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
