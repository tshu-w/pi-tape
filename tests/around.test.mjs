import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { loadTape, makeAgentDir, makeCtx, textMessage, writeSession } from "./harness.mjs";

const agentDir = makeAgentDir();
const cwd = "/tmp/pi-tape-around-project";

let previous = null;
let tick = 0;
function entry(id, message, parentId = previous) {
	const timestamp = new Date(Date.parse("2026-09-01T10:00:00.000Z") + tick++ * 1000).toISOString();
	previous = id;
	return { type: "message", id, parentId, timestamp, message: { ...message, timestamp: Date.parse(timestamp) } };
}
const toolCall = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (toolCallId, toolName, text, isError = false) => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError });

const u1 = entry("u1-start", textMessage("user", "start marker"));
const a1 = entry("a1-reply", { role: "assistant", content: [{ type: "text", text: "first reply" }, toolCall("c1", "read", { path: "a.txt" })] });
const r1 = entry("r1-read", toolResult("c1", "read", "read output marker"));
const a2 = entry("a2-tools", { role: "assistant", content: [toolCall("c2", "bash", { command: "false" }), toolCall("c3", "tape", { action: "search", query: "x" })] });
const r2 = entry("r2-bash", toolResult("c2", "bash", "bash output marker", true));
const r3 = entry("r3-tape", toolResult("c3", "tape", "tape output marker"));
const a3 = entry("a3-answer", { role: "assistant", content: [{ type: "text", text: "answer marker" }] });
const target = entry("target-entry", textMessage("user", "target line 1\ntarget line 2"));
const a4 = entry("a4-after", { role: "assistant", content: [{ type: "text", text: "after one" }] });
const u3 = entry("u3-after", textMessage("user", "after two"));
const leaf = entry("a5-leaf", { role: "assistant", content: [{ type: "text", text: "after three" }] });
const offBranch = entry("b1-off", textMessage("user", "other branch marker"), target.id);

const branch = [u1, a1, r1, a2, r2, r3, a3, target, a4, u3, leaf];
const entries = [...branch, offBranch];
const sessionFile = path.join(agentDir, "sessions", "current", "current.jsonl");

const { tools } = await loadTape();
const ctx = makeCtx({ cwd, sessionFile, branch, entries });
const view = (params) => tools.tape.execute("v", { action: "view", ...params }, undefined, undefined, ctx);

test("around counts conversation messages, folds tool steps, and follows the current branch", async () => {
	const { content, details } = await view({ entryId: target.id, around: 2 });
	const text = content[0].text;
	assert.equal(details.around, 2);
	assert.match(text, /^\[before: 2 messages\]/);
	assert.ok(text.includes("first reply") && text.includes("answer marker"));
	assert.ok(!text.includes("start marker"), "tool-only assistant and tool results do not count toward around");
	assert.ok(text.includes(`- tool=read args={"path":"a.txt"} status=ok\n- tool=bash args={"command":"false"} status=error`));
	assert.ok(!text.includes("output marker"), "tool output is folded");
	assert.ok(!text.includes("tool=tape"), "tape's own calls are excluded");
	assert.ok(text.includes("[entry]\n\nentryId=target-e type=message role=user"));
	assert.ok(text.includes("[after: 2 messages]") && text.includes("after one") && text.includes("after two"));
	assert.ok(!text.includes("after three"));
	assert.ok(!text.includes("other branch marker"), "the off-branch sibling is not followed");
});

test("offset and limit page only the viewed entry", async () => {
	const { content, details } = await view({ entryId: target.id, around: 1, offset: 2, limit: 1 });
	const text = content[0].text;
	assert.ok(text.includes("target line 2") && !text.includes("target line 1"));
	assert.ok(text.includes("answer marker") && text.includes("after one"));
	assert.equal(details.shownLines, 1);
});

test("around=0 matches the plain entry view", async () => {
	const plain = await view({ entryId: target.id });
	const zero = await view({ entryId: target.id, around: 0 });
	assert.equal(zero.content[0].text, plain.content[0].text);
});

test("around requires entryId", async () => {
	await assert.rejects(view({ around: 1 }), /`around` requires `entryId`/);
});

test("around in another session file follows the branch to that file's last entry", async () => {
	previous = null;
	const x1 = entry("x1-root", textMessage("user", "root marker"));
	const x2 = entry("x2-leafward", { role: "assistant", content: [{ type: "text", text: "leafward marker" }] });
	const x3 = entry("x3-sibling", textMessage("user", "sibling marker"), x1.id);
	const x4 = entry("x4-leaf", textMessage("user", "leaf marker"), x2.id);
	const file = writeSession(agentDir, "other", "other.jsonl", cwd, [x1, x2, x3, x4]);
	const { content } = await view({ entryId: x1.id, sessionFile: file, around: 1 });
	const text = content[0].text;
	assert.ok(text.includes("[before: 0 messages]\n\n[entry]"));
	assert.ok(text.includes("leafward marker") && !text.includes("sibling marker") && !text.includes("leaf marker"));
});
