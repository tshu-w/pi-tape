// Context rebuild invariants — the contract documented in the design header.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { anchorMessage, loadTape, makeAgentDir, textMessage } from "./harness.mjs";

const agentDir = makeAgentDir();
const { handlers } = await loadTape();
const entriesForMessages = (messages) => messages.map((message, index) => ({
	type: "message",
	id: `message-${index}`,
	parentId: index > 0 ? `message-${index - 1}` : null,
	timestamp: new Date(message.timestamp ?? Date.now()).toISOString(),
	message,
}));
const rebuild = (messages, branch = entriesForMessages(messages)) => handlers.context(
	{ type: "context", messages },
	{ sessionManager: { getBranch: () => branch } },
);

const big = "x".repeat(8000); // ~2000 tokens by pi's estimate
const anchor = (name, keepRecentTokens, createdAt = "2026-07-02T00:00:00.000Z") =>
	anchorMessage({ name, summary: `Summary of ${name}.`, cwd: "/x", createdAt, keepRecentTokens });

function longConversation(turns) {
	const messages = [];
	for (let i = 0; i < turns; i++) {
		messages.push(textMessage("user", big, 1000 + i * 2));
		messages.push(textMessage("assistant", big, 1001 + i * 2));
	}
	return messages;
}

test("no anchor → context untouched", async () => {
	assert.equal(await rebuild([textMessage("user", "hi")]), undefined);
});

test("everything fits → no trim", async () => {
	const messages = [textMessage("user", "hi"), anchor("a1", 20000), textMessage("user", "after")];
	assert.equal(await rebuild(messages), undefined);
});

test("rebuild: summary first, window cut, anchor retained", async () => {
	const messages = [...longConversation(20), anchor("a1", 2000), textMessage("user", "after")];
	const result = await rebuild(messages);
	assert.ok(result, "expected a rebuilt context");

	const [first, ...kept] = result.messages;
	assert.equal(first.customType, "tape-summary");
	assert.ok(first.content.includes("a1") && first.content.includes("Summary of a1."));
	assert.ok(kept.length < messages.length, "old messages must be trimmed");
	assert.ok(kept.some((m) => m?.details?.tapeAnchor?.name === "a1"), "anchor boundary must stay in the window");
	assert.equal(kept.at(-1).content[0].text, "after");
});

test("window never starts with a toolResult", async () => {
	// Alternating assistant toolCall / toolResult pairs make naive cuts land
	// on a toolResult; the cut must snap to a compact-compatible point.
	const messages = [];
	for (let i = 0; i < 20; i++) {
		messages.push({ role: "assistant", content: [{ type: "text", text: big }, { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: big } }], timestamp: 1000 + i * 2 });
		messages.push({ role: "toolResult", toolName: "bash", content: [{ type: "text", text: big }], timestamp: 1001 + i * 2 });
	}
	messages.push(anchor("a1", 3000));
	const result = await rebuild(messages);
	assert.ok(result);
	assert.notEqual(result.messages[1].role, "toolResult");
});

test("latest anchor governs when several exist", async () => {
	const messages = [
		...longConversation(10),
		anchor("old", 2000, "2026-07-01T00:00:00.000Z"),
		...longConversation(10),
		anchor("new", 2000, "2026-07-02T00:00:00.000Z"),
		textMessage("user", "after"),
	];
	const result = await rebuild(messages);
	assert.ok(result);
	assert.ok(result.messages[0].content.includes("new"));
	assert.ok(!result.messages[0].content.includes("Summary of old."));
});

test("a newer native compaction disables a retained anchor marker", async () => {
	const messages = [...longConversation(2), anchor("old", 2000), textMessage("user", "after")];
	const branch = entriesForMessages(messages);
	branch.push({
		type: "compaction",
		id: "native-compaction",
		parentId: branch.at(-1).id,
		timestamp: "2026-07-02T01:00:00.000Z",
		summary: "New native summary.",
		firstKeptEntryId: branch.at(-1).id,
		tokensBefore: 10000,
	});

	assert.equal(await rebuild(messages, branch), undefined);
});

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
