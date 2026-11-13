// Memory requests use the SDK's actual branch projection and compaction checkpoints.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { collapseSystemMessages } from "@earendil-works/pi-ai/utils/transcript";
import { makeAgentDir, textMessage } from "./harness.mjs";

const agentDir = makeAgentDir();
const index = path.join(agentDir, "tape", "memory", "MEMORY.md");
const { createMemory } = await createJiti(import.meta.url).import("../extensions/memory.ts");
const setIndex = (content) => {
	fs.mkdirSync(path.dirname(index), { recursive: true });
	fs.writeFileSync(index, content);
};

function fixture(manager = SessionManager.inMemory("/work")) {
	const memory = createMemory({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
	const ctx = { cwd: "/work", sessionManager: manager, model: { compat: { supportsMidConvoSystemMessages: true } } };
	const before = () => {
		const event = { systemPromptOptions: { sections: { other: "unchanged" } } };
		assert.equal(memory.beforeAgentStart(event, ctx), undefined);
		assert.equal(event.systemPromptOptions.sections.other, "unchanged");
		return event.systemPromptOptions.sections.memory;
	};
	const request = () => memory.context(manager.buildSessionProjection().messages, ctx);
	return { memory, manager, ctx, before, request };
}

function begin(content = "- original\n", manager) {
	setIndex(content);
	const f = fixture(manager);
	const section = f.before();
	f.manager.appendMessage({ role: "system", content: "SYS", sections: { memory: section, other: "stable" }, timestamp: 1 });
	f.manager.appendMessage(textMessage("user", "task"));
	return f;
}

const body = (section) => section.split(">\n").slice(1).join(">\n").replace(/\n<\/memory>$/, "");

test("the exact memory instructions use an empty index when MEMORY.md is absent", () => {
	const f = fixture();
	const section = f.before();
	assert.equal(section, [
		"Memory from past sessions: what you learned and should know without searching for it, such as the user's preferences and corrections, lasting facts and decisions, and where things live. It is shared by sessions in every project and on every machine.",
		"Read a file in the memory directory when its index line matches the task. Update memory when you learn something worth keeping.",
		"AGENTS.md takes precedence over memory.",
		"",
		`<memory path="${path.dirname(index)}">`, "", "</memory>",
	].join("\n"));
});

test("the index caps at 100 lines or 10KB without changing the file", () => {
	for (const [content, last, omitted] of [
		[Array.from({ length: 101 }, (_, i) => `fact ${i}`).join("\n"), "fact 99", "fact 100"],
		[Array.from({ length: 20 }, (_, i) => `fact ${i} ${"中".repeat(500)}`).join("\n"), "fact 5", "fact 6"],
	]) {
		setIndex(content);
		const section = fixture().before();
		assert.ok(section.includes(last));
		assert.ok(!section.includes(omitted));
		assert.match(section, /\[MEMORY\.md is cut at 100 lines\/10KB; the rest is not loaded\. Move details to other files\.\]/);
		assert.equal(fs.readFileSync(index, "utf-8"), content);
	}
	setIndex("\n\n- leading blank lines\n");
	assert.equal(body(fixture().before()), "\n\n- leading blank lines\n");
});

test("each request sees index changes at the tail while its entire cached prefix stays stable", () => {
	const f = begin();
	const initial = f.request();
	setIndex("- revised\n");
	const updated = f.request();
	assert.deepEqual(updated.slice(0, initial.length), initial);
	assert.equal(updated.length, initial.length + 1);
	assert.match(updated.at(-1).sections.memory, /- revised/);
	assert.equal(f.before(), initial[0]?.sections?.memory ?? initial.find((m) => m.role === "system").sections.memory);
	f.manager.appendMessage(textMessage("assistant", "next turn", 2));
	const next = f.request();
	assert.deepEqual(next.slice(0, updated.length), updated);
	assert.equal(next.at(-1).role, "assistant");
	assert.deepEqual(f.memory.context(next, f.ctx), next, "request reconstruction is idempotent");
});

test("models without mid-conversation system support keep memory updates out of the collapsed head", () => {
	for (const support of [false, undefined]) {
		const f = begin();
		f.ctx.model.compat.supportsMidConvoSystemMessages = support;
		const initial = collapseSystemMessages({ messages: f.request() }).messages;
		setIndex("- user-role update\n");
		const updated = f.request();
		assert.equal(updated.at(-1).role, "user");
		assert.match(updated.at(-1).content, /- user-role update/);
		assert.deepEqual(collapseSystemMessages({ messages: updated }).messages.slice(0, initial.length), initial);
		const stored = f.manager.getBranch().findLast((entry) => entry.customType === "tape-memory").data;
		assert.equal(stored.role, "user");
		f.ctx.model.compat.supportsMidConvoSystemMessages = true;
		assert.deepEqual(f.request(), updated, "switching models preserves the original update role");
		const loaded = fixture(SessionManager.inMemory("/work", undefined, [f.manager.getHeader(), ...f.manager.getEntries()]));
		assert.deepEqual(loaded.request(), updated, "reload preserves the original update role");
	}
});

test("reload and branch navigation replay only updates on their branch at their original positions", () => {
	const manager = SessionManager.create("/work", path.join(agentDir, "sessions"));
	const f = begin("- initial\n", manager);
	f.request();
	const forkPoint = manager.appendMessage(textMessage("assistant", "before edit", 3));
	setIndex("- changed\n");
	const updated = f.request();
	manager.appendMessage(textMessage("assistant", "after edit", 4));
	const expected = f.request();
	assert.deepEqual(expected.slice(0, updated.length), updated);
	const loaded = fixture(SessionManager.open(manager.getSessionFile()));
	assert.deepEqual(loaded.request(), expected);
	loaded.manager.branch(forkPoint);
	setIndex("- initial\n");
	const oldBranch = loaded.request();
	assert.equal(oldBranch.filter((message) => message.role === "system" && message.sections?.memory?.includes("- changed")).length, 0);
});

test("compaction folds the current index into the head and stops replaying old updates", () => {
	const f = begin();
	f.request();
	setIndex("- after update\n");
	f.request();
	const kept = f.manager.appendMessage(textMessage("user", "recent", 5));
	f.manager.appendCompaction("summary", kept, 1000);
	const section = f.before();
	assert.match(section, /- after update/);
	const compacted = f.request();
	assert.match(compacted[0].sections.memory, /- after update/);
	assert.equal(compacted.filter((message) => message.role === "system" && message.sections?.memory).length, 1);
	setIndex("- after compaction\n");
	const changed = f.request();
	assert.deepEqual(changed.slice(0, compacted.length), compacted);
	assert.match(changed.at(-1).sections.memory, /- after compaction/);
});

test("successful writes and edits at 90% of either cap append the exact notice", () => {
	const f = fixture();
	const result = (toolName, file = index, isError = false) => f.memory.toolResult({ toolName, input: { path: file }, content: [{ type: "text", text: "ok" }], isError }, f.ctx);
	setIndex(Array.from({ length: 89 }, () => "fact").join("\n"));
	assert.equal(result("write"), undefined);
	setIndex(Array.from({ length: 90 }, () => "fact").join("\n"));
	assert.equal(result("edit").content[1].text, "[MEMORY.md is at 90/100 lines, 0.4KB/10KB; lines past the cap are not loaded. Tidy the index: move details to other files.]");
	assert.equal(result("write", index, true), undefined);
	setIndex("x".repeat(9216));
	assert.match(result("write").content[1].text, /1\/100 lines, 9\.0KB\/10KB/);
	const topic = path.join(path.dirname(index), "topic.md");
	fs.writeFileSync(topic, "topic");
	assert.equal(result("write", topic), undefined);
});

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
