import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { anchorMessage, loadTape, loadTapeModule, makeAgentDir, textMessage } from "./harness.mjs";

makeAgentDir();
const { prepareProjectedAnchorCompaction } = await loadTapeModule();
const { createJiti } = await import("jiti");
const { legacyContext } = await createJiti(import.meta.url).import("../extensions/legacy.ts");
async function loadLegacy() { return { handlers: { context_with_system(event, ctx) { const messages = legacyContext(event.messages, ctx.sessionManager.getBranch()); return messages === event.messages ? undefined : { messages }; } } }; }
const settings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 };
const fileOps = { read: new Set(), written: new Set(), edited: new Set() };

function fixture() {
	const session = SessionManager.inMemory("/work");
	session.appendMessage(textMessage("user", "Old history. ".repeat(1000)));
	session.appendMessage(textMessage("user", "Recent history."));
	session.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "anchor-call", name: "tape", arguments: { action: "anchor" } }],
		timestamp: Date.now(),
	});
	const anchorId = session.appendMessage({
		...anchorMessage({ name: "checkpoint", summary: "Checkpoint summary.", cwd: "/work", createdAt: "2026-09-21T00:00:00Z", keepRecentTokens: 1 }),
		toolCallId: "anchor-call",
		isError: false,
	});
	const editedId = session.appendMessage(textMessage("user", "Original content must not return."));
	const keptId = session.appendMessage(textMessage("user", "Latest input. ".repeat(100)));
	return { session, anchorId, editedId, keptId };
}

for (const replacement of [null, { content: "Corrected content." }]) {
	test(`anchor compaction respects context ${replacement ? "replacement" : "omission"} and retains source IDs`, () => {
		const { session, editedId, keptId } = fixture();
		session.appendContextEdit(editedId, replacement);
		const branch = session.getBranch();
		const original = structuredClone(branch);
		const preparation = prepareProjectedAnchorCompaction(branch, settings, 1000, fileOps);
		assert.equal(preparation.firstKeptEntryId, keptId);
		const summary = JSON.stringify([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
		assert.doesNotMatch(summary, /Original content must not return/);
		if (replacement) assert.match(summary, /Corrected content/);
		assert.deepEqual(session.getBranch(), original, "projection must not rewrite history");
	});
}

test("an omitted latest anchor restores the previous visible anchor for context and compaction", async () => {
	const { session } = fixture();
	const omittedAnchorId = session.appendMessage(anchorMessage({
		name: "omitted-checkpoint", summary: "Omitted checkpoint.", cwd: "/work",
		createdAt: "2026-09-22T00:00:00Z", keepRecentTokens: 1,
	}));
	session.appendContextEdit(omittedAnchorId, null);
	const preparation = prepareProjectedAnchorCompaction(session.getBranch(), settings, 1000, fileOps);
	assert.ok(preparation);
	assert.match(preparation.messagesToSummarize[0].content, /summary — checkpoint/);
	const { handlers } = await loadLegacy();
	const result = await handlers.context_with_system({ messages: session.buildSessionContext().messages }, { sessionManager: session });
	assert.ok(result);
	assert.match(result.messages[0].content, /summary — checkpoint/);
	assert.doesNotMatch(JSON.stringify(result.messages), /Omitted checkpoint/);
});

test("a newer native compaction supersedes an older anchor retained in its projection", async () => {
	const { session, anchorId } = fixture();
	session.appendMessage({ role: "system", content: "System checkpoint.", timestamp: Date.now() });
	const compactId = session.appendCompaction("Native summary.", session.getBranch()[0].id, 1000);
	const projection = session.buildSessionProjection();
	assert.equal(projection.entries[0].sourceEntry.id, compactId);
	assert.equal(projection.entries[0].messages.length, 2);
	assert.ok(projection.entries.some(({ sourceEntry, messages }) => sourceEntry.id === anchorId && messages.length > 0));
	assert.equal(prepareProjectedAnchorCompaction(session.getBranch(), settings, 1000, fileOps), undefined);
	const { handlers } = await loadLegacy();
	assert.equal(await handlers.context_with_system({ messages: projection.messages }, { sessionManager: session }), undefined);

	const omittedAnchorId = session.appendMessage(anchorMessage({
		name: "omitted-after-compact", summary: "Omitted checkpoint.", cwd: "/work",
		createdAt: "2026-09-22T00:00:00Z", keepRecentTokens: 1,
	}));
	session.appendContextEdit(omittedAnchorId, null);
	assert.equal(prepareProjectedAnchorCompaction(session.getBranch(), settings, 1000, fileOps), undefined);
	assert.equal(await handlers.context_with_system({ messages: session.buildSessionContext().messages }, { sessionManager: session }), undefined);
});

test("a new anchor after a multi-message checkpoint preserves the retained source ID", () => {
	const { session } = fixture();
	session.appendMessage({ role: "system", content: "System checkpoint.", timestamp: Date.now() });
	session.appendCompaction("Native summary.", session.getBranch()[0].id, 1000);
	assert.equal(session.buildSessionProjection().entries[0].messages.length, 2);
	session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "new-call", name: "tape", arguments: { action: "anchor" } }], timestamp: Date.now() });
	session.appendMessage({
		...anchorMessage({ name: "new-checkpoint", summary: "New checkpoint.", cwd: "/work", createdAt: "2026-09-22T00:00:00Z", keepRecentTokens: 1 }),
		toolCallId: "new-call", isError: false,
	});
	const keptId = session.appendMessage(textMessage("user", "Keep this input."));
	const branch = session.getBranch();
	const original = structuredClone(branch);
	const preparation = prepareProjectedAnchorCompaction(branch, settings, 1000, fileOps);
	assert.equal(preparation.firstKeptEntryId, keptId);
	assert.match(preparation.messagesToSummarize[0].content, /summary — new-checkpoint/);
	assert.deepEqual(session.getBranch(), original);
});

test("an edited custom message keeps its original entry ID at the compaction cut", () => {
	const { session } = fixture();
	const customId = session.appendCustomMessageEntry("instruction", "Original custom content.", false);
	session.appendContextEdit(customId, { content: "Corrected custom content." });
	const preparation = prepareProjectedAnchorCompaction(session.getBranch(), settings, 1000, fileOps);
	assert.equal(preparation.firstKeptEntryId, customId);
	assert.doesNotMatch(JSON.stringify(preparation.messagesToSummarize), /Original custom content/);
});

test("context edits leave raw history search and view unchanged", async () => {
	const { session, editedId } = fixture();
	session.appendContextEdit(editedId, null);
	const { tools } = await loadTape();
	const ctx = { cwd: "/work", sessionManager: session };
	const search = await tools.tape.execute("search", { action: "search", query: "Original content", scope: "branch" }, undefined, undefined, ctx);
	assert.equal(search.details.results[0].entryId, editedId);
	const view = await tools.tape.execute("view", { action: "view", entryId: editedId }, undefined, undefined, ctx);
	assert.match(view.content[0].text, /Original content must not return/);
});

test("search excludes only records whose searchable body remains in the effective projection", async () => {
	const session = SessionManager.inMemory("/work");
	const changedId = session.appendMessage(textMessage("user", "changed original marker"));
	const sameId = session.appendMessage(textMessage("user", "same original marker"));
	const call = (id, command) => ({ type: "toolCall", id, name: "bash", arguments: { command } });
	const assistant = content => ({ role: "assistant", content, timestamp: Date.now(), stopReason: "toolUse" });
	const unchangedTextId = session.appendMessage(assistant([{ type: "text", text: "retained text marker" }, call("original-call", "old-command-marker")]));
	const unchangedCallId = session.appendMessage(assistant([{ type: "text", text: "old text marker" }, call("retained-call", "retained-command-marker")]));
	session.appendContextEdit(changedId, { content: "different replacement marker" });
	session.appendContextEdit(sameId, { content: "same original marker" });
	session.appendContextEdit(unchangedTextId, { content: [{ type: "thinking", thinking: "new private metadata" }, { type: "text", text: "retained text marker" }, call("replacement-call", "new-command-marker")] });
	session.appendContextEdit(unchangedCallId, { content: [{ type: "text", text: "new text marker" }, call("different-call-id", "retained-command-marker")] });
	const before = structuredClone(session.getEntries());
	const { tools } = await loadTape();
	const ctx = { cwd: "/work", sessionManager: session };
	const search = (query, kinds) => tools.tape.execute("search", { action: "search", query, kinds, scope: "branch" }, undefined, undefined, ctx);

	assert.deepEqual((await search("changed original marker", ["message"])).details.results.map(item => item.entryId), [changedId]);
	assert.equal((await search("same original marker", ["message"])).details.total, 0);
	assert.equal((await search("retained text marker", ["message"])).details.total, 0);
	assert.deepEqual((await search("old-command-marker", ["tool_call"])).details.results.map(item => item.entryId), [unchangedTextId]);
	assert.deepEqual((await search("old text marker", ["message"])).details.results.map(item => item.entryId), [unchangedCallId]);
	assert.equal((await search("retained-command-marker", ["tool_call"])).details.total, 0, "tool-call IDs do not change the searchable body");
	assert.equal((await search("different replacement marker", ["message"])).details.total, 0, "search still reads raw history");
	for (const entryId of [changedId, unchangedTextId, unchangedCallId]) {
		const viewed = await tools.tape.execute("view", { action: "view", entryId }, undefined, undefined, ctx);
		assert.match(viewed.content[0].text, /changed original marker|old-command-marker|old text marker/);
		assert.doesNotMatch(viewed.content[0].text, /different replacement|new-command-marker|new text marker|new private metadata/);
	}
	assert.deepEqual(session.getEntries(), before);
	assert.deepEqual(session.getBranch(), before);
});

test("an omitted only anchor does not supply a compaction boundary", async () => {
	const { session, anchorId } = fixture();
	session.appendContextEdit(anchorId, null);
	assert.equal(prepareProjectedAnchorCompaction(session.getBranch(), settings, 1000, fileOps), undefined);
	const { handlers } = await loadLegacy();
	assert.equal(await handlers.context_with_system({ messages: session.buildSessionContext().messages }, { sessionManager: session }), undefined);
});
