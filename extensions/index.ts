import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { buildSessionProjection, getAgentDir, keyText, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderToolCall } from "./render-call.js";
import { executeHistory, historyParameterProperties, type HistoryParams } from "./history.js";
import { legacyContext, legacyVisibleEntryIds, prepareProjectedAnchorCompaction } from "./legacy.js";
import { keptEntryId, nativeSettings, summarize } from "./compaction.js";
import { createMemory } from "./memory.js";
import {
	DREAM_ENV, dreamAgentEnd, dreamAgentSettled, dreamPromptSection, dreamSessionShutdown,
	dreamSessionStart, dreamToolCall, getDreamSettingsWarnings, maybeStartDream, registerDreamRenderer, showDreamNotice,
} from "./dream.js";

export { prepareProjectedAnchorCompaction } from "./legacy.js";

function compactSetting(): { compactAt?: number; warning?: string } {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8"));
		const section = settings["pi-tape"];
		if (section !== undefined && (!section || typeof section !== "object" || Array.isArray(section))) {
			return { warning: "Invalid pi-tape settings; turn-end threshold disabled." };
		}
		const value = section?.compactAt;
		if (value === undefined) return {};
		if (Number.isSafeInteger(value) && value > 0) return { compactAt: value };
		return { warning: "Invalid pi-tape.compactAt; turn-end threshold disabled." };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		return { warning: "Invalid pi-tape settings; turn-end threshold disabled." };
	}
}

export default function (pi: ExtensionAPI) {
	const memory = createMemory(pi);
	let requested = false;
	let requestSnapshot: { messages: any[]; entryIds: Set<string> } | undefined;
	const projectedMessages = (ctx: ExtensionContext, projection = buildSessionProjection(ctx.sessionManager.getBranch()), edited = false) => {
		const branch = ctx.sessionManager.getBranch();
		const messages = memory.context(legacyContext(projection.messages, branch, projection), ctx);
		if (!requestSnapshot || edited) return messages;
		const prefix = projection.entries.filter(entry => requestSnapshot!.entryIds.has(entry.sourceEntry.id));
		// Context edits intentionally replace earlier input, so the new projection wins.
		const newEntries = branch.filter(entry => !requestSnapshot!.entryIds.has(entry.id));
		if (newEntries.some(entry => entry.type === "context_edit" || entry.type === "compaction")) return messages;
		if (!prefix.length) return messages;
		const suffix = projection.entries.filter(entry => !requestSnapshot!.entryIds.has(entry.sourceEntry.id)).flatMap(entry => entry.messages);
		return memory.context([...requestSnapshot.messages, ...suffix], ctx);
	};
	const cutFor = (ctx: ExtensionContext, projection = buildSessionProjection(ctx.sessionManager.getBranch())) => keptEntryId(
		projection.entries, legacyVisibleEntryIds(ctx.sessionManager.getBranch(), projection), nativeSettings(pi).getCompactionSettings(ctx.model).keepRecentTokens,
	);

	pi.registerTool({
		name: "tape",
		label: "Tape",
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		description: "Compact the context and search history. `compact` replaces the conversation so far with a summary; `search` finds entries by text, kind, or time; `view` displays an entry, or the entries around it.",
		promptSnippet: "Compact context and search history",
		promptGuidelines: [
			"Use tape(action='compact') when a piece of work is finished or its details no longer need to stay in context.",
			"Use tape(action='search', query=...) to find what the summary leaves out.",
		],
		parameters: Type.Object({
			action: StringEnum(["compact", "search", "view"] as const, { description: "Action to perform" }),
			...historyParameterProperties,
		}),
		renderCall(args, theme, context) {
			const ready = !context.isPartial;
			return renderToolCall("tape", args, theme, ready, ready && !context.isError, context.lastComponent);
		},
		renderResult(result, { expanded }, theme, context) {
			const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
			if (context.isError) return new Text(theme.fg("error", text), 0, 0);
			const details = result.details as any;
			let body = text;
			let suffix = "";
			let visible = text;
			let hidden = "";
			let collapsed = false;
			if (Array.isArray(details?.results) && details.results.length) {
				const blocks = text.split("\n\n");
				body = blocks.slice(0, details.results.length).join("\n\n");
				suffix = text.slice(body.length);
				visible = blocks.slice(0, Math.min(5, details.results.length)).join("\n\n");
				hidden = blocks.slice(5, details.results.length).join("\n\n");
				collapsed = details.results.length > 5;
			} else if (typeof details?.shownLines === "number") {
				const lines = text.split("\n");
				body = lines.slice(0, details.shownLines + 1).join("\n");
				suffix = text.slice(body.length);
				visible = lines.slice(0, Math.min(15, details.shownLines) + 1).join("\n");
				hidden = lines.slice(16, details.shownLines + 1).join("\n");
				collapsed = details.shownLines > 15;
			}
			const styledSuffix = suffix.split(/(\n\n)/).map(part => {
				if (!part || /^\n+$/.test(part)) return part;
				const warning = details?.truncation?.truncated && (part.startsWith("[Showing lines ") || part.trimStart().startsWith("[Line ") || part.startsWith("[Output truncated:"));
				return theme.fg(warning ? "warning" : "dim", part);
			}).join("");
			if (expanded || !collapsed) return new Text(theme.fg("toolOutput", body) + styledSuffix, 0, 0);
			return {
				render(width: number) {
					const count = Math.max(hidden.split("\n").length, new Text(hidden, 0, 0).render(width).length);
					const hint = theme.fg("muted", `... (${count} more lines, ${(context as { keyText?: typeof keyText }).keyText?.("app.tools.expand") ?? keyText("app.tools.expand")} to expand)`);
					return new Text(`${theme.fg("toolOutput", visible)}\n\n${hint}${styledSuffix}`, 0, 0).render(width);
				},
				invalidate() {},
			};
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (params.action !== "compact") {
				const branch = ctx.sessionManager.getBranch();
				const projection = buildSessionProjection(branch);
				return executeHistory(params as HistoryParams, signal, ctx, { entryIds: legacyVisibleEntryIds(branch, projection), entries: projection.entries });
			}
			for (const [name, value] of Object.entries(params)) {
				if (name !== "action" && value !== undefined) throw new Error(`\`${name}\` is not valid for compact.`);
			}
			if (!cutFor(ctx)) throw new Error("Nothing to compact.");
			requested = true;
			return { content: [{ type: "text", text: "Compacting the context after this turn." }], details: {} };
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		memory.beforeAgentStart(event, ctx);
		const dream = dreamPromptSection();
		if (dream) event.systemPromptOptions.sections.dream = dream;
	});
	pi.on("tool_call", (event, ctx) => dreamToolCall(event, ctx));
	pi.on("tool_result", (event, ctx) => memory.toolResult(event, ctx));
	pi.on("context_with_system", (event, ctx) => {
		const messages = memory.context(legacyContext(event.messages, ctx.sessionManager.getBranch()), ctx);
		requestSnapshot = { messages: structuredClone(messages), entryIds: new Set(ctx.sessionManager.getBranch().map(entry => entry.id)) };
		return messages === event.messages ? undefined : { messages };
	});

	pi.on("turn_end", async (event, ctx) => {
		const explicit = requested;
		requested = false;
		if (event.outcome !== "completed") return;
		const settings = nativeSettings(pi).getCompactionSettings(ctx.model);
		const compactAt = compactSetting().compactAt;
		if (!explicit && (!settings.enabled || compactAt === undefined || (ctx.getContextUsage()?.tokens ?? 0) < compactAt)) return;
		if (event.entries.some(entry => entry.type === "compaction")) return;
		const projection = { ...buildSessionProjection(ctx.sessionManager.getBranch()), entries: event.context.contextEntries, messages: event.context.contextMessages };
		const firstKeptEntryId = cutFor(ctx, projection);
		if (!firstKeptEntryId) return;
		const controller = new AbortController();
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
		const keybindings = ctx.mode === "tui" ? getKeybindings() : undefined;
		const unsubscribe = ctx.mode === "tui" ? ctx.ui.onTerminalInput(data => {
			if (matchesKey(data, "escape") || keybindings!.matches(data, "app.interrupt")) {
				controller.abort();
				return { consume: true };
			}
		}) : undefined;
		if (ctx.hasUI) ctx.ui.setWorkingMessage(`Compacting context... (${keybindings?.getKeys("app.interrupt").join("/") || "esc"} to cancel)`);
		try {
			const result = await summarize(pi, ctx, projectedMessages(ctx, projection, event.entries.some(entry => entry.type === "context_edit")), signal);
			requestSnapshot = undefined;
			return { entries: [...event.entries, { type: "compaction" as const, ...result, firstKeptEntryId }] };
		} catch (error) {
			if (!signal.aborted) ctx.ui.notify(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			unsubscribe?.();
			if (ctx.hasUI) ctx.ui.setWorkingMessage();
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Old anchors remain an effective boundary until replaced by a native compaction.
		const legacy = prepareProjectedAnchorCompaction(event.branchEntries, event.preparation.settings, ctx.getContextUsage()?.tokens ?? event.preparation.tokensBefore, event.preparation.fileOps);
		if (legacy) Object.assign(event.preparation, legacy);
		if (event.reason === "overflow") return;
		try {
			const result = await summarize(pi, ctx, projectedMessages(ctx), event.signal, event.customInstructions);
			return { compaction: { ...result, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
		} catch (error) {
			if (!event.signal.aborted) ctx.ui.notify(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return { cancel: true };
		}
	});
	pi.on("session_compact", () => { requestSnapshot = undefined; });
	pi.on("session_tree", () => { requestSnapshot = undefined; requested = false; });

	registerDreamRenderer(pi);
	let noticeCtx: ExtensionContext | undefined;
	const showNotice = () => {
		if (!noticeCtx?.isIdle()) return;
		try { showDreamNotice(pi); } catch { /* Dream state must not interrupt the session. */ }
	};
	const startDream = () => {
		if (noticeCtx) void maybeStartDream(noticeCtx.mode, Date.now(), showNotice).catch(() => {});
	};
	pi.on("session_start", (_event, ctx) => {
		requestSnapshot = undefined;
		requested = false;
		for (const warning of [compactSetting().warning, ...getDreamSettingsWarnings()]) {
			if (warning) ctx.ui.notify(warning, "warning");
		}
		dreamSessionStart();
		if (ctx.mode !== "tui" || process.env[DREAM_ENV]) return;
		noticeCtx = ctx;
		showNotice();
		startDream();
	});
	pi.on("agent_settled", () => { dreamAgentSettled(); showNotice(); startDream(); });
	pi.on("agent_end", event => dreamAgentEnd(event.messages));
	pi.on("session_shutdown", () => { noticeCtx = undefined; dreamSessionShutdown(); });
}
