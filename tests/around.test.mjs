import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { makeAgentDir, makeCtx, textMessage, writeSession } from "./harness.mjs";
const { executeHistory } = await createJiti(import.meta.url).import("../extensions/history.ts");
const agentDir = makeAgentDir();
const cwd = "/tmp/pi-tape-around-project";
let previous = null;
let tick = 0;
function entry(id, message, parentId = previous) {
	previous = id;
	return { type: "message", id, parentId, timestamp: new Date(Date.parse("2026-09-01T10:00:00Z") + tick++ * 1000).toISOString(), message };
}
const user = (id, text) => entry(id, textMessage("user", text));
const answer = (id, text, stopReason = "stop") => entry(id, { ...textMessage("assistant", text), stopReason });
const first = user("first", "first marker");
const completed = answer("completed", "completed marker");
const tools = entry("tools", { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "tool preamble" }, { type: "toolCall", name: "bash", arguments: { command: "pwd" } }] });
const result = entry("result", { role: "toolResult", toolName: "bash", content: "tool output" });
const aborted = answer("aborted", "aborted reply", "aborted");
const thinking = entry("thinking", { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "private reasoning" }] });
const target = user("target-entry", "target line 1\ntarget line 2");
const after = answer("after", "after marker");
const last = user("last", "last marker");
const branch = [first, completed, tools, result, aborted, thinking, target, after, last];
const sibling = entry("sibling", textMessage("user", "sibling marker"), target.id);
const ctx = makeCtx({ cwd, branch, entries: [...branch, sibling] });
const view = params => executeHistory({ action: "view", ...params }, undefined, ctx, { entryIds: new Set(), entries: [] });

test("around filters before counting and returns chronological preview records", async () => {
	const response = await view({ entryId: target.id, around: 2 });
	assert.deepEqual(response.details.results.map(item => item.entryId), [first.id, completed.id, target.id, after.id, last.id]);
	assert.match(response.content[0].text, /^first  user  2026-09-01 10:00\n  first marker/);
	assert.match(response.content[0].text, /target-entry  user .*\n  target line 1 target line 2/);
	assert.doesNotMatch(response.content[0].text, /tool preamble|tool output|aborted reply|private reasoning|sibling marker/);
});

test("around preserves an exact tool result target while filtering its neighbors", async () => {
	const response = await view({ entryId: result.id, around: 1 });
	assert.deepEqual(response.details.results.map(item => item.entryId), [completed.id, result.id, target.id]);
	assert.match(response.content[0].text, /result  tool_result bash/);
});

test("around returns previews independently of entry line pagination", async () => {
	const response = await view({ entryId: target.id, around: 1, offset: 2, limit: 1 });
	assert.deepEqual(response.details.results.map(item => item.entryId), [completed.id, target.id, after.id]);
	assert.match(response.content[0].text, /target line 1 target line 2/);
});

test("around=0 matches plain entry view and hides thinking", async () => {
	assert.deepEqual(await view({ entryId: target.id, around: 0 }), await view({ entryId: target.id }));
	const mixed = entry("mixed", { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "visible" }] });
	const response = await executeHistory({ action: "view", entryId: mixed.id }, undefined, makeCtx({ cwd, branch: [mixed] }), { entryIds: new Set(), entries: [] });
	assert.ok(response.content[0].text.endsWith("\nvisible"));
	assert.doesNotMatch(response.content[0].text, /hidden/);
});

test("around requires entryId and validates its range", async () => {
	await assert.rejects(view({ around: 1 }), /`around` requires `entryId`/);
	await assert.rejects(view({ entryId: target.id, around: 21 }), /`around`/);
});

test("another session follows the branch leading to its last entry", async () => {
	previous = null;
	const root = user("root", "root marker");
	const forward = answer("forward", "forward marker");
	const other = entry("other", textMessage("user", "other branch"), root.id);
	const leaf = entry("leaf", textMessage("user", "leaf marker"), forward.id);
	const sessionFile = writeSession(agentDir, "other", "other.jsonl", cwd, [root, forward, other, leaf]);
	const response = await view({ entryId: root.id, sessionFile, around: 1 });
	assert.deepEqual(response.details.results.map(item => item.entryId), [root.id, forward.id]);
});
