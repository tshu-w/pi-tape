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
	sessionEntryToContextMessages,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderToolCall } from "./render-call.js";
import { withToolOutputContract } from "./tool-output.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_KEEP_RECENT_TOKENS = 20000;
const NOTES_BUDGET_LINES = 150;
const NOTES_MAX_LINES = 400;
const NOTES_MAX_BYTES = 16 * 1024;
const RECENT_ANCHORS_LIMIT = 10;
const SEARCH_PREVIEW_LENGTH = 200;
const DEFAULT_SEARCH_KINDS = ["message", "tool_result"] as const;
const SEARCH_KINDS = ["message", "tool_result", "tool_call", "anchor", "compact", "summary", "custom"] as const;
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
	if (Number.isNaN(parsed)) return { error: `\`${name}\` is not a valid timestamp: ${value}` };
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
		if (signal?.aborted) break;

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

	if (!signal?.aborted && (dirty || Object.keys(next).length !== Object.keys(index).length)) {
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
			const role = msg.toolName ? `toolResult:${msg.toolName}` : "toolResult";
			return content ? [{ kind: "tool_result", role, searchableText: content, timestamp, sessionFile, sessionCwd }] : [];
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
			const term = matchingQueryTerm(item.searchableText, query);
			if (query.length > 0 && term === undefined) continue;

			results.push({
				entryId,
				timestamp: item.timestamp,
				kind: item.kind,
				role: item.role,
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
		return `${section ? `${section}: ` : ""}${text}`.slice(0, 100);
	}
	return fallback.slice(0, 100);
}

function sessionLabel(record: { sessionFile?: string }, currentSessionFile?: string): string {
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
			...(showSessionLabel ? [`session=${sessionLabel(r, currentSessionFile)}`, `sessionFile=${JSON.stringify(r.sessionFile ?? "")}`] : []),
			`time=${formatTimestampSecond(r.timestamp)}`,
		].join(" ");
		return `- [${r.entryId.slice(0, 8)}] ${r.kind}/${r.role} ${metadata}\n  ${r.preview}`;
	});
	return `search ${queryLabel}${suffix} (${results.length}/${total}, offset ${offset})\n${lines.join("\n\n")}`;
}

function entryViewText(entry: any): string {
	const items = extractSearchItems(entry);
	if (items.length > 0) {
		return items.map((item) => `## ${item.kind}/${item.role}\n${item.searchableText}`).join("\n\n");
	}
	return JSON.stringify(entry, null, 2);
}

function renderEntryView(entry: any, offset: number, limit: number): string {
	const text = entryViewText(entry);
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
	pi.registerTool(withToolOutputContract({
		name: "tape",
		label: "Tape",
		description: [
			"Tape-style context management.",
			"anchor: create a semantic boundary with summary.",
			"search: find old entries by keyword with optional kind and time filters.",
			"info: show current tape boundary, notes status, and context usage.",
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
			name: Type.Optional(Type.String({ description: "Anchor name (unique per branch). Required for anchor." })),
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
		renderCall(args, theme, context) {
			return renderToolCall("tape", args, theme, !context.isPartial);
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			const branchEntries = ctx.sessionManager.getBranch() as any[];
			const sessionEntries = ctx.sessionManager.getEntries() as any[];
			const sessionDir = ctx.sessionManager.getSessionDir();
			const sessionFile = ctx.sessionManager.getSessionFile();

			switch (params.action) {
				// ── info ─────────────────────────────────────────
				case "info": {
					const currentBranchAnchors = anchorRecordsFromEntries(branchEntries, sessionFile, ctx.cwd);
					const sessionAnchors = anchorRecordsFromEntries(sessionEntries, sessionFile, ctx.cwd);
					const latest = currentBranchAnchors.at(-1);
					const usage = ctx.getContextUsage?.();
					const globalNotes = readNotesFile(globalNotesPath());
					const projectNotes = readNotesFile(projectNotesPath(ctx.cwd));
					const lines = [
						`branch anchors: ${currentBranchAnchors.length}`,
						`session anchors: ${sessionAnchors.length}`,
						`latest boundary: ${latest ? latest.name : "(none)"}`,
						`notes (global): ${globalNotes.exists ? notesStatusLabel(globalNotes) : `none — ${displayPath(globalNotes.path)}`}`,
						`notes (project): ${projectNotes.exists ? notesStatusLabel(projectNotes) : `none — ${displayPath(projectNotes.path)}`}`,
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
						details: {
						branchAnchors: currentBranchAnchors.length,
						sessionAnchors: sessionAnchors.length,
						latest: latest ? { entryId: latest.entryId, name: latest.name, timestamp: latest.timestamp } : undefined,
						usage,
					},
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
					const currentBranchAnchors = anchorRecordsFromEntries(branchEntries, sessionFile, ctx.cwd);
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

					const priorAnchors = currentBranchAnchors.slice(-RECENT_ANCHORS_LIMIT).reverse();
					const priorLine = priorAnchors.length > 0
						? `\n\nrecent anchors (this session): ${priorAnchors.map(anchorItemLabel).join(" · ")}`
						: "";

					return {
						content: [{ type: "text", text: `[Anchor: ${params.name}]\n${params.summary}${priorLine}` }],
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
							for (const item of listSessionFiles(sessionDir, sessionFile)) {
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
							const lines = candidates.slice(0, 10).map((c) => `- [${c.entry.id.slice(0, 8)}] session=${sessionLabel({ sessionFile: c.file }, sessionFile)} time=${formatTimestampSecond(normalizeTimestamp(c.entry.timestamp))}`);
							return { content: [{ type: "text", text: `Entry prefix ${entryId} is ambiguous (${candidates.length} matches):\n${lines.join("\n")}` }], details: { entryId, matches: candidates.length } };
						}

						const found = candidates[0];
						return {
							content: [{ type: "text", text: renderEntryView(found.entry, offset, Math.max(1, limit)) }],
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

					// cwd or all — scan session files (index-cached)
					const allRecords = scanTapeRecords(scope, ctx.cwd, sessionDir, sessionFile, sessionEntries, signal);

					allRecords.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
					const dedupedRecords = dedupeRecords(allRecords);
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
						for (const item of listSessionFiles(sessionDir, sessionFile)) {
							if (signal?.aborted) break;
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
						content: [{ type: "text", text: renderSearchResults(page, total, offset, query, kinds, timeFilterLabel, sessionFile, scope === "cwd" || scope === "all") }],
						details: { results: page, total, offset, limit },
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
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
