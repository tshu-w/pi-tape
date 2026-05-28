import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { findCutPoint, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_KEEP_RECENT_TOKENS = 20000;
const SEARCH_PREVIEW_LENGTH = 200;
const DEFAULT_SEARCH_KINDS = ["message", "tool_result"] as const;
const SEARCH_KINDS = ["message", "tool_result", "tool_call", "anchor", "summary", "custom"] as const;

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

interface AnchorRecord {
	entryId: string;
	name: string;
	summary: string;
	timestamp: string;
	sessionFile?: string;
	sessionCwd?: string;
}

type SearchKind = (typeof SEARCH_KINDS)[number];

interface SearchItem {
	kind: SearchKind;
	role: string;
	content: string;
}

interface SearchResult {
	entryId: string;
	timestamp: string;
	kinds: SearchKind[];
	role: string;
	preview: string;
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
	for (const subdir of fs.readdirSync(sessionsDir)) {
		const subdirPath = path.join(sessionsDir, subdir);
		let stat: fs.Stats;
		try { stat = fs.statSync(subdirPath); } catch { continue; }
		if (!stat.isDirectory()) continue;

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

// ============================================================================
// Anchor detection & extraction
// ============================================================================

function isTapeAnchorMessage(message: any): boolean {
	return message?.role === "toolResult" && message?.toolName === "tape" && !!message?.details?.tapeAnchor;
}

function anchorFromMessage(message: any): TapeAnchorData | null {
	const data = message?.details?.tapeAnchor;
	if (!data || data.version !== 1 || !data.name || !data.summary) return null;
	return data as TapeAnchorData;
}

function anchorFromEntry(entry: any, sessionFile?: string, sessionCwd?: string): AnchorRecord | null {
	if (entry?.type !== "message" || !isTapeAnchorMessage(entry.message)) return null;

	const anchor = anchorFromMessage(entry.message);
	if (!anchor) return null;

	return {
		entryId: entry.id,
		name: anchor.name,
		summary: anchor.summary,
		timestamp: entry.timestamp ?? anchor.createdAt,
		sessionFile,
		sessionCwd: sessionCwd ?? anchor.source?.cwd,
	};
}

function anchorsFromEntries(entries: any[], sessionFile?: string, sessionCwd?: string): AnchorRecord[] {
	const anchors: AnchorRecord[] = [];
	for (const entry of entries) {
		const anchor = anchorFromEntry(entry, sessionFile, sessionCwd);
		if (anchor) anchors.push(anchor);
	}
	return anchors;
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

function extractSearchItems(entry: any): SearchItem[] {
	if (entry.type === "message") {
		const msg = entry.message;
		if (!msg) return [];

		if (isTapeAnchorMessage(msg)) {
			const anchor = anchorFromMessage(msg);
			return anchor ? [{ kind: "anchor", role: "anchor", content: anchor.summary }] : [];
		}

		if (msg.role === "toolResult") {
			let content = "";
			if (typeof msg.content === "string") {
				content = msg.content;
			} else if (Array.isArray(msg.content)) {
				content = stringifyContentBlocks(msg.content);
			}
			const role = msg.toolName ? `toolResult:${msg.toolName}` : "toolResult";
			return content ? [{ kind: "tool_result", role, content }] : [];
		}

		if (msg.role === "assistant") {
			const items: SearchItem[] = [];
			if (typeof msg.content === "string") {
				if (msg.content) items.push({ kind: "message", role: "assistant", content: msg.content });
			} else if (Array.isArray(msg.content)) {
				const textContent = stringifyContentBlocks(msg.content);
				if (textContent) items.push({ kind: "message", role: "assistant", content: textContent });

				const toolCalls = msg.content
					.filter((block: any) => block?.type === "toolCall")
					.map((block: any) => `${block.name}(${JSON.stringify(block.arguments)})`)
					.join(" ");
				if (toolCalls) items.push({ kind: "tool_call", role: "assistant", content: toolCalls });
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
		return content ? [{ kind: "message", role, content }] : [];
	}
	if (entry.type === "custom_message" && typeof entry.content === "string" && entry.content) {
		return [{ kind: "custom", role: "custom", content: entry.content }];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [{ kind: "summary", role: "branchSummary", content: entry.summary }];
	}
	if (entry.type === "compaction" && entry.summary) {
		return [{ kind: "summary", role: "compaction", content: entry.summary }];
	}
	return [];
}

function normalizeSearchKinds(kinds: unknown): SearchKind[] {
	if (!Array.isArray(kinds) || kinds.length === 0) return [...DEFAULT_SEARCH_KINDS];
	const allowed = new Set<string>(SEARCH_KINDS);
	return kinds.filter((kind): kind is SearchKind => typeof kind === "string" && allowed.has(kind));
}

function matchEntries(entries: any[], query: string, kinds: SearchKind[]): SearchResult[] {
	const lower = query.toLowerCase();
	const allowedKinds = new Set<SearchKind>(kinds);
	const resultMap = new Map<string, SearchResult>();

	for (const entry of entries) {
		const entryId = entry.id ?? "";
		for (const item of extractSearchItems(entry)) {
			if (!allowedKinds.has(item.kind)) continue;
			if (!item.content.toLowerCase().includes(lower)) continue;

			const existing = resultMap.get(entryId);
			if (existing) {
				if (!existing.kinds.includes(item.kind)) existing.kinds.push(item.kind);
				continue;
			}

			const matchIdx = item.content.toLowerCase().indexOf(lower);
			const start = Math.max(0, matchIdx - 50);
			const end = Math.min(item.content.length, start + SEARCH_PREVIEW_LENGTH);
			let preview = item.content.slice(start, end).replace(/\n/g, " ");
			if (start > 0) preview = "..." + preview;
			if (end < item.content.length) preview += "...";

			resultMap.set(entryId, {
				entryId,
				timestamp: entry.timestamp ?? "",
				kinds: [item.kind],
				role: item.role,
				preview,
			});
		}
	}

	return Array.from(resultMap.values());
}

// ============================================================================
// firstKeptEntryId calculation
// ============================================================================

function calculateFirstKeptEntryId(branchEntries: any[], keepRecentTokens: number): string | undefined {
	const cutPoint = findCutPoint(branchEntries, 0, branchEntries.length, keepRecentTokens);
	return branchEntries[cutPoint.firstKeptEntryIndex]?.id;
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
		timestamp: Date.now(),
	};
}

// ============================================================================
// Rendering
// ============================================================================

function renderViewResults(anchors: Array<{ anchor: AnchorRecord; onBranch: boolean }>, total: number, offset: number): string {
	if (anchors.length === 0) return "No anchors in this session.";

	const lines: string[] = [];
	let inOffBranch = false;
	for (const item of anchors) {
		const a = item.anchor;
		if (!item.onBranch && !inOffBranch) {
			if (lines.length > 0) lines.push("");
			lines.push("off-branch:");
			inOffBranch = true;
		} else if (lines.length > 0) {
			lines.push("");
		}
		const indent = item.onBranch ? "" : "  ";
		const summaryPreview = (a.summary.split("\n")[0] ?? "").slice(0, 100);
		lines.push(`${indent}${a.name} [${a.entryId.slice(0, 8)}]`);
		lines.push(`${indent}  ${summaryPreview}`);
	}

	return `anchors (${anchors.length}/${total}, offset ${offset})\n${lines.join("\n")}`;
}

function renderSearchResults(results: SearchResult[], total: number, offset: number, query: string, kinds: SearchKind[]): string {
	const isDefaultKinds = kinds.length === DEFAULT_SEARCH_KINDS.length &&
		kinds.every((k, i) => k === DEFAULT_SEARCH_KINDS[i]);
	const kindSuffix = isDefaultKinds ? "" : ` kinds=${kinds.join(",")}`;
	if (results.length === 0) return `No entries matching "${query}"${kindSuffix} (offset ${offset}).`;
	const lines = results.map((r) => {
		const date = r.timestamp?.slice(0, 10) ?? "";
		const kindLabel = r.kinds.join(",");
		return `- [${r.entryId.slice(0, 8)}] ${kindLabel}/${r.role} (${date})\n  ${r.preview}`;
	});
	return `search "${query}"${kindSuffix} (${results.length}/${total}, offset ${offset})\n${lines.join("\n\n")}`;
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
			"search: find old entries by keyword with optional kind filters.",
			"info: show current tape boundary and context usage.",
			"view: list anchors in this session.",
		].join(" "),
		promptSnippet: "Manage semantic context with anchors and searchable history",
		promptGuidelines: [
			"Use tape(action='anchor', name=..., summary=...) when switching topics or after a major task completes.",
			"When context usage is high, use tape(action='anchor') to checkpoint before continuing.",
			"Use tape(action='search', query=...) to recover old messages, tool results, or prior context when returning to an older topic.",
			"Use tape(action='info') to check anchor count and context usage.",
			"Use tape(action='view') only when the user asks to list or choose from existing anchors.",
			"Prefer pi-style structured summaries: Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context.",
		],
		parameters: Type.Object({
			action: StringEnum(["info", "anchor", "view", "search"] as const, {
				description: "Action to perform",
			}),
			name: Type.Optional(Type.String({ description: "Anchor name (must be unique). Required for anchor." })),
			summary: Type.Optional(Type.String({ description: "Retrospective state summary. Required for anchor." })),
			query: Type.Optional(Type.String({ description: "Search keyword (case-insensitive). Required for search." })),
			kinds: Type.Optional(Type.Array(StringEnum(SEARCH_KINDS, {
				description: "Entry kinds to search. Default: message + tool_result.",
			}))),
			scope: Type.Optional(StringEnum(["branch", "session", "cwd", "all"] as const, {
				description: "Search scope. Default: session for search.",
			})),
			limit: Type.Optional(Type.Number({ description: "Max results. Default: 20 for view, 10 for search." })),
			offset: Type.Optional(Type.Number({ description: "Skip N results. Default: 0." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const branchEntries = ctx.sessionManager.getBranch() as any[];
			const sessionEntries = ctx.sessionManager.getEntries() as any[];
			const sessionFile = ctx.sessionManager.getSessionFile();
			const currentBranchAnchors = anchorsFromEntries(branchEntries, sessionFile, ctx.cwd);

			switch (params.action) {
				// ── info ─────────────────────────────────────────
				case "info": {
					const sessionAnchors = anchorsFromEntries(sessionEntries, sessionFile, ctx.cwd);
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
					const limit = Math.max(0, Math.trunc(params.limit ?? 20));
					const offset = Math.max(0, Math.trunc(params.offset ?? 0));
					const sessionAnchors = anchorsFromEntries(sessionEntries, sessionFile, ctx.cwd);

					if (sessionAnchors.length === 0) {
						return { content: [{ type: "text", text: "No anchors in this session." }], details: { anchors: 0 } };
					}

					const currentBranchIds = new Set(branchEntries.map((e: any) => e.id));
					const onBranch = sessionAnchors.filter((a) => currentBranchIds.has(a.entryId)).reverse();
					const offBranch = sessionAnchors.filter((a) => !currentBranchIds.has(a.entryId)).reverse();

					const ordered = [
						...onBranch.map((a) => ({ anchor: a, onBranch: true })),
						...offBranch.map((a) => ({ anchor: a, onBranch: false })),
					];
					const shown = ordered.slice(offset, offset + limit);

					return {
						content: [{ type: "text", text: renderViewResults(shown, sessionAnchors.length, offset) }],
						details: { total: sessionAnchors.length, shown: shown.length, offset, limit },
					};
				}

				// ── search ──────────────────────────────────────
				case "search": {
					if (!params.query) {
						return { content: [{ type: "text", text: "`query` is required for search." }], details: {} };
					}
					const scope = params.scope ?? "session";
					const kinds = normalizeSearchKinds(params.kinds);
					const limit = Math.max(0, Math.trunc(params.limit ?? 10));
					const offset = Math.max(0, Math.trunc(params.offset ?? 0));

					let allMatches: SearchResult[];

					if (scope === "branch") {
						allMatches = matchEntries(branchEntries, params.query, kinds);
					} else if (scope === "session") {
						allMatches = matchEntries(sessionEntries, params.query, kinds);
					} else {
						allMatches = [];
						for (const item of listSessionFiles()) {
							if (signal?.aborted) break;
							const parsed = parseSessionFile(item.file);
							if (!parsed) continue;
							if (scope === "cwd" && parsed.cwd !== ctx.cwd) continue;
							allMatches.push(...matchEntries(parsed.entries, params.query, kinds));
						}
					}

					// Newest first
					allMatches.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
					const total = allMatches.length;
					const page = allMatches.slice(offset, offset + limit);

					return {
						content: [{ type: "text", text: renderSearchResults(page, total, offset, params.query, kinds) }],
						details: { results: page, total, scope, kinds, offset, limit },
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
		const keepFromIdx = cutPoint.firstKeptEntryIndex;

		// If everything fits, no need to trim
		if (keepFromIdx === 0) return;

		const summaryMsg = makeSummaryMessage(anchor);
		const kept = messages.slice(keepFromIdx);

		return { messages: [summaryMsg, ...kept] };
	});
}
