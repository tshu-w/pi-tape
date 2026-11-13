import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { buildSessionProjection, findCutPoint, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

const DEFAULT_KEEP_RECENT_TOKENS = 20000;
interface TapeAnchorData { name: string; summary: string; createdAt: string; keepRecentTokens?: number }
function anchorFromMessage(message: any): TapeAnchorData | null {
 const data = message?.details?.tapeAnchor;
 return message?.role === "toolResult" && message?.toolName === "tape" && data?.version === 1 && data.name && data.summary ? data : null;
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

function findActiveAnchorBoundary(entries: any[], projection = buildSessionProjection(entries)): ActiveAnchorBoundary | null {
	const projected = new Map(projection.entries.map(({ sourceEntry, messages }) => [sourceEntry.id, messages]));
	let active: ActiveAnchorBoundary | null = null;
	for (const entry of entries) {
		if (entry.type === "compaction") {
			active = null;
			continue;
		}
		for (const message of projected.get(entry.id) ?? []) {
			const anchor = anchorFromMessage(message);
			if (anchor) active = { entry, anchor };
		}
	}
	return active;
}

function projectedContextEntries(branchEntries: SessionEntry[], projection = buildSessionProjection(branchEntries)): SessionEntry[] {
	return projection.entries.flatMap<SessionEntry>(({ sourceEntry, messages }) => {
		// Keep native compaction checkpoints atomic and ineligible as cut points.
		if (sourceEntry.type === "compaction") return messages.length > 0 ? [sourceEntry] : [];
		return messages.map((message) => ({ ...sourceEntry, type: "message", message }));
	});
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

	const contextEntries = projectedContextEntries(branchEntries);
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


export function legacyContext(messages: any[], branch: any[], projection = buildSessionProjection(branch)): any[] {
 const active = findActiveAnchorBoundary(branch, projection);
 if (!active) return messages;
 const latest = findLatestAnchorIndex(messages);
 if (!latest || latest.anchor.name !== active.anchor.name || latest.anchor.createdAt !== active.anchor.createdAt) return messages;
 const anchorStart = findAnchorToolCallStartIndex(messages, latest.index);
 const cut = findCutPoint(entriesFromMessages(messages), 0, anchorStart, latest.anchor.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS);
 const keep = cut.isSplitTurn && cut.turnStartIndex >= 0 ? cut.turnStartIndex : cut.firstKeptEntryIndex;
 if (keep === 0) return messages;
 const system = getCurrentSystemMessage(messages.slice(0, keep));
 return [...(system ? [system] : []), makeSummaryMessage(latest.anchor), ...messages.slice(keep)];
}

export function legacyVisibleEntryIds(branch: any[], projection = buildSessionProjection(branch)): Set<string> {
 const entries = projectedContextEntries(branch, projection);
 const active = findActiveAnchorBoundary(branch, projection);
 if (!active) return new Set(entries.map(entry => entry.id));
 const anchorIndex = entries.findIndex(entry => entry.id === active.entry.id);
 const start = findAnchorToolCallStartEntryIndex(entries, anchorIndex);
 const cut = findCutPoint(entries, 0, start, active.anchor.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS);
 const keep = cut.isSplitTurn && cut.turnStartIndex >= 0 ? cut.turnStartIndex : cut.firstKeptEntryIndex;
 return new Set(entries.slice(keep).map(entry => entry.id));
}
