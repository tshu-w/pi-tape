// Notes injection, budget, reminders, and the record index cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { anchorEntry, loadTape, makeAgentDir, makeCtx, writeSession } from "./harness.mjs";

const agentDir = makeAgentDir();
const cwd = "/tmp/pi-tape-fake-project";
const { tools, handlers } = await loadTape();

writeSession(agentDir, "--fake--", "past.jsonl", cwd, [
	anchorEntry({ id: "aaaa1111-0000", name: "past-topic", summary: "Past work summary.", cwd, createdAt: "2026-07-01T10:00:00.000Z" }),
]);
const sessionFile = path.join(agentDir, "sessions", "--fake--", "current.jsonl");
const branch = [];
const ctx = makeCtx({ cwd, sessionFile, branch });

async function inject(context = ctx, hooks = handlers) {
	const event = { type: "before_agent_start", prompt: "hi", systemPrompt: "SYS", systemPromptOptions: { sections: { other: "Unchanged" } } };
	assert.equal(await hooks.before_agent_start(event, context), undefined, "notes must not force a full prompt replacement");
	assert.equal(event.systemPromptOptions.sections.other, "Unchanged");
	return event.systemPromptOptions.sections["tape-notes"];
}

const globalNotes = path.join(agentDir, "tape", "notes.md");

test("injection: pointers when no notes exist, anchors from past sessions", async () => {
	const sp = await inject();
	assert.ok(sp.includes(globalNotes));
	assert.ok(sp.includes("recent anchors (cwd, session-start snapshot): [past-topic] 2026-07-01"));
});

test("corrupt record index is rebuilt from session files", async () => {
	const indexFile = path.join(agentDir, "tape", "index.json");
	// Corrupt index must be survivable (rebuilt from session files).
	fs.writeFileSync(indexFile, "not json");
	const fresh = await loadTape();
	const sp = await inject(ctx, fresh.handlers);
	assert.ok(sp.includes("[past-topic]"));
});

test("global notes follow the agent across cwd while anchor snapshots remain cwd scoped", async () => {
	const content = "- shared preference\n- verified external fact\n";
	fs.mkdirSync(path.dirname(globalNotes), { recursive: true });
	fs.writeFileSync(globalNotes, content);
	for (const directory of [cwd, "/tmp/pi-tape-other-project"]) {
		const { handlers: isolatedHandlers } = await loadTape();
		const context = makeCtx({ cwd: directory, sessionId: directory, sessionDir: path.dirname(sessionFile) });
		const sp = await inject(context, isolatedHandlers);
		assert.ok(sp.includes(content.trimEnd()));
		assert.equal(sp.includes("[past-topic]"), directory === cwd);
	}
});

test("anchor result carries the summary; system prompt snapshot stays frozen", async () => {
	const before = await inject();
	const result = await tools.tape.execute("t2", { action: "anchor", name: "new-topic", summary: "Testing." }, undefined, undefined, ctx);
	const text = result.content[0].text;
	assert.ok(text.includes("Anchor created: new-topic"));
	assert.ok(text.includes("Testing."));
	assert.ok(!text.includes("recent anchors (this branch)"), "first anchor has no prior-anchor list");

	branch.push({ type: "message", id: "bbbb2222-0000", timestamp: new Date().toISOString(), message: { role: "toolResult", toolName: "tape", content: result.content, details: result.details } });
	const after = await inject();
	assert.equal(after, before, "system prompt must be byte-identical after anchoring");
	assert.ok(!after.includes("new-topic"));

	const second = await tools.tape.execute("t3", { action: "anchor", name: "second-topic", summary: "More." }, undefined, undefined, ctx);
	assert.match(second.content[0].text, /recent anchors \(this branch\): \[new-topic\] \d{4}-\d{2}-\d{2}/);
	assert.ok(!second.content[0].text.includes("[second-topic]"), "current anchor is only in the title");
});

test("snapshot stays frozen when an ephemeral session first gets a file", async () => {
	const { handlers: isolatedHandlers } = await loadTape();
	const sessionId = "new-session-id";
	const initialCtx = makeCtx({ cwd, sessionId, sessionFile: undefined, entries: [] });
	const initial = await inject(initialCtx, isolatedHandlers);

	const allocatedFile = writeSession(agentDir, "--fake--", "allocated.jsonl", cwd, [
		anchorEntry({ id: "allocated-anchor", name: "created-mid-session", summary: "New work.", cwd, createdAt: "2026-07-19T10:00:00.000Z" }),
	]);
	const allocatedCtx = makeCtx({ cwd, sessionId, sessionFile: allocatedFile, entries: [] });
	const afterAllocation = await inject(allocatedCtx, isolatedHandlers);
	assert.equal(afterAllocation, initial);
	assert.ok(!afterAllocation.includes("created-mid-session"));
	fs.unlinkSync(allocatedFile);
});

test("snapshot rescans when the session identity changes", async () => {
	writeSession(agentDir, "--fake--", "later.jsonl", cwd, [
		anchorEntry({ id: "cccc3333-0000", name: "later-topic", summary: "Later work.", cwd, createdAt: "2026-07-20T10:00:00.000Z" }),
	]);

	const sameSession = await inject();
	assert.ok(!sameSession.includes("later-topic"), "snapshot stays frozen within a session");

	const otherCtx = makeCtx({ cwd, sessionFile: path.join(agentDir, "sessions", "--fake--", "next.jsonl") });
	const next = await inject(otherCtx, handlers);
	assert.match(next, /recent anchors \(cwd, session-start snapshot\): \[later-topic\] 2026-07-20 · \[past-topic\] 2026-07-01/);
});

test("soft budget warns only above 40 lines without truncating", async () => {
	for (const count of [40, 41, 60, 80]) {
		const content = Array.from({ length: count }, (_, i) => `- fact ${i}`).join("\n");
		fs.writeFileSync(globalNotes, content);
		const sp = await inject();
		assert.equal(sp.includes("over budget"), count > 40);
		assert.ok(sp.includes(content));
		assert.doesNotMatch(sp, /distill required/);
	}
});

test("hard line and byte limits bound injection without changing the global file", async () => {
	for (const [content, lastRetained, firstOmitted] of [
		[Array.from({ length: 81 }, (_, i) => `- bounded fact ${i}`).join("\n"), "- bounded fact 79", "- bounded fact 80"],
		[Array.from({ length: 20 }, (_, i) => `- byte fact ${i} ${"中".repeat(500)}`).join("\n"), "- byte fact 4", "- byte fact 5"],
	]) {
		fs.writeFileSync(globalNotes, content);
		const sp = await inject();
		assert.ok(sp.includes(lastRetained));
		assert.ok(!sp.includes(firstOmitted));
		assert.match(sp, /distill required/);
		assert.equal(fs.readFileSync(globalNotes, "utf8"), content);
	}
});

test("view defaults to session while scope=cwd lists records through the index", async () => {
	const currentAnchor = anchorEntry({
		id: "dddd4444-0000",
		name: "current-topic",
		summary: "Current session summary.",
		cwd,
		createdAt: "2026-07-21T10:00:00.000Z",
	});
	const viewCtx = makeCtx({ cwd, sessionFile, branch: [currentAnchor] });

	const sessionView = await tools.tape.execute("t4", { action: "view" }, undefined, undefined, viewCtx);
	assert.equal(sessionView.details.scope, "session");
	assert.ok(sessionView.content[0].text.includes("current-topic"));
	assert.ok(!sessionView.content[0].text.includes("past-topic"));

	const cwdView = await tools.tape.execute("t5", { action: "view", scope: "cwd" }, undefined, undefined, viewCtx);
	assert.ok(cwdView.content[0].text.includes("past-topic"));
});

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
