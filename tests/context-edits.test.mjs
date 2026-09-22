import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { anchorMessage, loadTape, loadTapeModule, makeAgentDir, textMessage } from "./harness.mjs";

makeAgentDir();
const { prepareProjectedAnchorCompaction } = await loadTapeModule();
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

	test(`compaction bridge receives context ${replacement ? "replacement" : "omission"} and edited retained messages`, async (t) => {
		const { session, editedId, keptId } = fixture();
		const omittedId = session.appendMessage(textMessage("user", "Omitted trailing content."));
		session.appendContextEdit(editedId, replacement);
		session.appendContextEdit(keptId, { content: "Corrected retained content." });
		session.appendContextEdit(omittedId, null);
		const key = Symbol.for("pi-tape.projected-compaction.v1");
		const previous = globalThis[key];
		t.after(() => {
			if (previous === undefined) delete globalThis[key];
			else globalThis[key] = previous;
		});
		let captured;
		const result = { compaction: { summary: "Bridge summary.", firstKeptEntryId: keptId, tokensBefore: 1000 } };
		globalThis[key] = { compact(input) { captured = input; return result; } };
		const { handlers } = await loadTape();
		assert.equal(await handlers.session_before_compact({
			branchEntries: session.getBranch(),
			preparation: { settings, tokensBefore: 1000, fileOps },
		}, { model: { provider: "test", id: "test" }, sessionManager: session }), result);
		assert.equal(captured.preparation.firstKeptEntryId, keptId);
		assert.doesNotMatch(JSON.stringify(captured.messages), /Original content must not return|Omitted trailing content|Latest input/);
		if (replacement) assert.match(JSON.stringify(captured.messages), /Corrected content/);
		assert.equal(captured.messages.at(-1).content, "Corrected retained content.");
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
	const { handlers } = await loadTape();
	const result = await handlers.context({ messages: session.buildSessionContext().messages }, { sessionManager: session });
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
	const { handlers } = await loadTape();
	assert.equal(await handlers.context({ messages: projection.messages }, { sessionManager: session }), undefined);

	const omittedAnchorId = session.appendMessage(anchorMessage({
		name: "omitted-after-compact", summary: "Omitted checkpoint.", cwd: "/work",
		createdAt: "2026-09-22T00:00:00Z", keepRecentTokens: 1,
	}));
	session.appendContextEdit(omittedAnchorId, null);
	assert.equal(prepareProjectedAnchorCompaction(session.getBranch(), settings, 1000, fileOps), undefined);
	assert.equal(await handlers.context({ messages: session.buildSessionContext().messages }, { sessionManager: session }), undefined);
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

test("an omitted only anchor does not supply a compaction boundary", async () => {
	const { session, anchorId } = fixture();
	session.appendContextEdit(anchorId, null);
	assert.equal(prepareProjectedAnchorCompaction(session.getBranch(), settings, 1000, fileOps), undefined);
	const { handlers } = await loadTape();
	assert.equal(await handlers.context({ messages: session.buildSessionContext().messages }, { sessionManager: session }), undefined);
});
