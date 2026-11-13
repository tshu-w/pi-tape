import { setTimeout as delay } from "node:timers/promises";
import { convertToLlm, findCutPoint, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { retryDelayMs } from "@earendil-works/pi-ai";

export const SUMMARY_TASK = `# Context compaction

The conversation above is about to be replaced by a summary you write now. The system prompt will remain. If the conversation starts with an earlier summary, it will be replaced too, so carry over what still matters from it.

Write it so you can keep working as if you remembered everything. Keep the user's requests, constraints, decisions, and corrections, in their words where it matters. Copy names, paths, ids, and numbers exactly. Say what is done and what is still open, and mark what the user has not confirmed as tentative.

Output only the summary. Do not continue the work or call tools.`;

export function nativeSettings(pi: ExtensionAPI) {
	return SettingsManager.inMemory(pi.getSettings());
}

export function keptEntryId(projected: Array<{ sourceEntry: any; messages: any[] }>, visible: Set<string>, keepRecentTokens: number): string | undefined {
	const entries = projected.flatMap(({ sourceEntry, messages }) => {
		if (!visible.has(sourceEntry.id) || sourceEntry.type === "compaction") return [];
		return messages.filter(message => message.role !== "system").map(message => ({ ...sourceEntry, type: "message", message }));
	});
	if (!entries.length) return undefined;
	const cut = findCutPoint(entries, 0, entries.length, keepRecentTokens);
	if (cut.firstKeptEntryIndex === 0) return undefined;
	return entries[cut.firstKeptEntryIndex]?.id;
}

export async function summarize(pi: ExtensionAPI, ctx: ExtensionContext, messages: any[], signal?: AbortSignal, instructions?: string) {
	if (!ctx.model) throw new Error("No model selected.");
	const task = SUMMARY_TASK + (instructions ? `\n\nAdditional focus: ${instructions}` : "");
	const timestamp = Date.now();
	const supportsSystem = (ctx.model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true;
	const suffix = supportsSystem
		? [{ role: "system" as const, content: task, timestamp }, { role: "user" as const, content: "Write the summary now.", timestamp }]
		: [{ role: "user" as const, content: `${task}\n\nWrite the summary now.`, timestamp }];
	const context = { messages: [...convertToLlm(messages), ...suffix] };
	const settings = nativeSettings(pi);
	const thinking = pi.getThinkingLevel();
	const retry = settings.getRetrySettings();
	const retries = retry.enabled ? retry.maxRetries : 0;
	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) throw new Error("Operation aborted");
		try {
			const options = {
				...settings.getProviderRetrySettings(),
				signal,
				sessionId: ctx.sessionManager.getSessionId(),
				reasoning: thinking === "off" ? undefined : thinking,
				disableContinuation: true,
			};
			const response = await ctx.modelRegistry.streamSimple(ctx.model, context, options).result();
			if (signal?.aborted || response.stopReason === "aborted") throw new Error("Operation aborted");
			if (response.stopReason === "error" || response.stopReason === "length") throw new Error(response.errorMessage || `Summary ended with ${response.stopReason}.`);
			if (response.content.some(block => block.type === "toolCall")) throw new Error("Summary called a tool.");
			const summary = response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			if (!summary.trim()) throw new Error("Summary was empty.");
			return { summary, usage: response.usage };
		} catch (error) {
			if (signal?.aborted || (error instanceof Error && error.message === "Operation aborted")) throw new Error("Operation aborted");
			if (attempt >= retries) throw error;
			try {
				await delay(retryDelayMs(retry, attempt + 1), undefined, { signal });
			} catch {
				throw new Error("Operation aborted");
			}
		}
	}
}
