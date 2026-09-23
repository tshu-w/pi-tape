import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorEntry, loadTape, loadTapeModule, makeAgentDir, textMessage } from "./harness.mjs";

makeAgentDir();
const { prepareProjectedAnchorCompaction } = await loadTapeModule();

function messageEntry(id, message, timestamp = "2026-07-16T03:00:00.000Z") {
	return { type: "message", id, parentId: null, timestamp, message };
}

const settings = { enabled: true, reserveTokens: 32768, keepRecentTokens: 20 };
const fileOps = { read: new Set(), written: new Set(), edited: new Set() };
const discarded = "old".repeat(10_000);
const recent = "recent".repeat(100);

test("projected compaction summarizes the active view and keeps only entries after the anchor", () => {
	const branchEntries = [
		messageEntry("old-user", textMessage("user", discarded)),
		messageEntry("recent-user", textMessage("user", recent), "2026-07-16T03:10:00.000Z"),
		messageEntry("anchor-call", { role: "assistant", content: [], timestamp: Date.now() }),
		anchorEntry({
			id: "anchor-result",
			name: "checkpoint",
			summary: "Authoritative checkpoint.",
			cwd: "/x",
			createdAt: "2026-07-16T03:20:00.000Z",
			keepRecentTokens: 20,
		}),
		messageEntry("post-old", textMessage("user", recent), "2026-07-16T03:21:00.000Z"),
		messageEntry("post-kept", textMessage("user", "kept"), "2026-07-16T03:22:00.000Z"),
	];
	for (let i = 0; i < branchEntries.length; i++) {
		branchEntries[i].parentId = i > 0 ? branchEntries[i - 1].id : null;
	}

	const result = prepareProjectedAnchorCompaction(branchEntries, settings, 57011, fileOps);

	assert.equal(result.firstKeptEntryId, "post-old");
	assert.equal(result.tokensBefore, 57011);
	assert.equal(result.previousSummary, undefined);
	assert.equal(result.messagesToSummarize[0].customType, "tape-summary");
	assert.match(result.messagesToSummarize[0].content, /Authoritative checkpoint/);
	assert.ok(result.messagesToSummarize.some((message) => message.content?.[0]?.text === recent));
	assert.equal(result.messagesToSummarize.some((message) => message.content?.[0]?.text === discarded), false);
	assert.equal(result.messagesToSummarize.some((message) => message?.details?.tapeAnchor), false);
	assert.equal(result.messagesToSummarize.some((message) => message?.toolName === "tape"), false);
});

test("projected compaction can compact immediately after an anchor", () => {
	const branchEntries = [
		messageEntry("old-user", textMessage("user", discarded)),
		messageEntry("anchor-call", { role: "assistant", content: [], timestamp: Date.now() }),
		anchorEntry({
			id: "anchor-result",
			name: "checkpoint",
			summary: "Checkpoint.",
			cwd: "/x",
			createdAt: "2026-07-16T03:20:00.000Z",
			keepRecentTokens: 20,
		}),
	];
	for (let i = 0; i < branchEntries.length; i++) {
		branchEntries[i].parentId = i > 0 ? branchEntries[i - 1].id : null;
	}

	const result = prepareProjectedAnchorCompaction(branchEntries, settings, 1000, fileOps);
	assert.equal(result.firstKeptEntryId, "anchor-call");
	assert.equal(result.messagesToSummarize[0].customType, "tape-summary");
});

test("projected compaction finds the anchor tool call across parallel results", () => {
	const assistant = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "parallel-call", name: "read", arguments: { path: "README.md" } },
			{ type: "toolCall", id: "anchor-call-id", name: "tape", arguments: { action: "anchor" } },
		],
		timestamp: Date.now(),
	};
	const anchor = anchorEntry({
		id: "anchor-result",
		name: "checkpoint",
		summary: "Checkpoint.",
		cwd: "/x",
		createdAt: "2026-07-16T03:20:00.000Z",
		keepRecentTokens: 20,
	});
	anchor.message.toolCallId = "anchor-call-id";
	const branchEntries = [
		messageEntry("old-user", textMessage("user", discarded)),
		messageEntry("assistant-calls", assistant),
		messageEntry("parallel-result", { role: "toolResult", toolCallId: "parallel-call", toolName: "read", content: [{ type: "text", text: recent }], timestamp: Date.now() }),
		anchor,
	];
	for (let i = 0; i < branchEntries.length; i++) branchEntries[i].parentId = i > 0 ? branchEntries[i - 1].id : null;

	const result = prepareProjectedAnchorCompaction(branchEntries, settings, 1000, fileOps);
	assert.equal(result.firstKeptEntryId, "assistant-calls");
	assert.equal(result.messagesToSummarize.some((message) => message.toolCallId === "parallel-call"), false);
});

test("threshold and overflow compaction use the active-anchor projection", async (t) => {
	const { handlers } = await loadTape();
	const branchEntries = [
		messageEntry("old-user", textMessage("user", discarded)),
		messageEntry("anchor-call", { role: "assistant", content: [], timestamp: Date.now() }),
		anchorEntry({
			id: "anchor-result",
			name: "checkpoint",
			summary: "Checkpoint.",
			cwd: "/x",
			createdAt: "2026-07-16T03:20:00.000Z",
			keepRecentTokens: 20,
		}),
	];
	for (let i = 0; i < branchEntries.length; i++) branchEntries[i].parentId = i > 0 ? branchEntries[i - 1].id : null;

	for (const reason of ["threshold", "overflow"]) {
		await t.test(reason, async () => {
			let authCalls = 0;
			const ctx = {
				model: { provider: "test", id: "test" },
				getContextUsage: () => ({ tokens: 1234 }),
				modelRegistry: {
					getApiKeyAndHeaders: async () => {
						authCalls++;
						return { ok: false, error: "test auth stop" };
					},
				},
			};
			await assert.rejects(
				handlers.session_before_compact({
					reason,
					branchEntries,
					preparation: { settings, tokensBefore: 1000, fileOps },
				}, ctx),
				/test auth stop/,
			);
			assert.equal(authCalls, 1);
		});
	}
});

test("projected compaction falls back when a native compaction is the newer boundary", () => {
	const branchEntries = [
		anchorEntry({
			id: "anchor-result",
			name: "checkpoint",
			summary: "Checkpoint.",
			cwd: "/x",
			createdAt: "2026-07-16T03:20:00.000Z",
		}),
		messageEntry("kept-user", textMessage("user", "kept"), "2026-07-16T03:22:00.000Z"),
		{
			type: "compaction",
			id: "new-compaction",
			parentId: "kept-user",
			timestamp: "2026-07-16T03:23:00.000Z",
			summary: "New native summary.",
			firstKeptEntryId: "kept-user",
			tokensBefore: 57011,
		},
	];

	assert.equal(prepareProjectedAnchorCompaction(branchEntries, settings, 1000, fileOps), undefined);
});

test("projected text compaction routes through the session's registered provider", async () => {
	const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
	const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
	const runtime = await ModelRuntime.create({ modelsPath: null, authPath: `${process.env.PI_CODING_AGENT_DIR}/auth.json`, refreshOnCreate: false });
	const registry = new ModelRegistry(runtime);
	let received;
	registry.registerProvider("test-extension", {
		api: "test-extension", apiKey: "test", baseUrl: "https://unused.test",
		models: [{ id: "summary", name: "Summary", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			received = context;
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant", content: [{ type: "text", text: "Extension-provider summary." }],
				api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
				usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return stream;
		},
	});
	const { handlers } = await loadTape();
	const branchEntries = [
		messageEntry("old-user", textMessage("user", discarded)),
		messageEntry("recent-user", textMessage("user", recent)),
		messageEntry("anchor-call", { role: "assistant", content: [], timestamp: Date.now() }),
		anchorEntry({ id: "anchor-result", name: "checkpoint", summary: "Current checkpoint.", cwd: "/x", createdAt: "2026-07-16T03:20:00.000Z", keepRecentTokens: 20 }),
	];
	for (let i = 0; i < branchEntries.length; i++) branchEntries[i].parentId = i > 0 ? branchEntries[i - 1].id : null;
	const result = await handlers.session_before_compact({
		branchEntries, preparation: { settings, tokensBefore: 1000, fileOps }, signal: new AbortController().signal,
	}, { model: registry.find("test-extension", "summary"), modelRegistry: registry, getContextUsage: () => ({ tokens: 1234 }) });
	assert.match(result.compaction.summary, /Extension-provider summary/);
	assert.match(JSON.stringify(received.messages), /Current checkpoint/);
	assert.equal(JSON.stringify(received.messages).includes(discarded), false);
});
