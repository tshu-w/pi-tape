// Notes injection, budget, reminders, and the record index cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { anchorEntry, loadTape, makeAgentDir, makeCtx, writeSession } from "./harness.mjs";

const agentDir = makeAgentDir();
const cwd = "/tmp/pi-tape-fake-project";
const projectSlug = "--tmp-pi-tape-fake-project--";
const { tools, handlers } = await loadTape();

writeSession(agentDir, "--fake--", "past.jsonl", cwd, [
	anchorEntry({ id: "aaaa1111-0000", name: "past-topic", summary: "Past work summary.", cwd, createdAt: "2026-07-01T10:00:00.000Z" }),
]);
const sessionFile = path.join(agentDir, "sessions", "--fake--", "current.jsonl");
const branch = [];
const ctx = makeCtx({ cwd, sessionFile, branch });

const inject = async () =>
	(await handlers.before_agent_start({ type: "before_agent_start", prompt: "hi", systemPrompt: "SYS" }, ctx)).systemPrompt;

const globalNotes = path.join(agentDir, "tape", "notes.md");
const projectNotes = path.join(agentDir, "tape", projectSlug, "notes.md");

test("injection: pointers when no notes exist, anchors from past sessions", async () => {
	const sp = await inject();
	assert.ok(sp.startsWith("SYS\n\n<tape-notes>"));
	assert.match(sp, /global notes: none yet — create /);
	assert.ok(sp.includes(`${projectSlug}/notes.md`));
	assert.ok(sp.includes("recent anchors (cwd): [past-topic] 2026-07-01"));
});

test("record index is written and reused", async () => {
	const indexFile = path.join(agentDir, "tape", "index.json");
	assert.ok(fs.existsSync(indexFile));
	const index = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
	const files = Object.keys(index.files);
	assert.equal(files.length, 1);
	assert.equal(index.files[files[0]].records[0].name, "past-topic");

	// Corrupt index must be survivable (rebuilt from session files).
	fs.writeFileSync(indexFile, "not json");
	const fresh = await loadTape();
	const sp = (await fresh.handlers.before_agent_start({ type: "before_agent_start", prompt: "hi", systemPrompt: "SYS" }, ctx)).systemPrompt;
	assert.ok(sp.includes("[past-topic]"));
	assert.ok(JSON.parse(fs.readFileSync(indexFile, "utf-8")).version === 1);
});

test("injection: notes content and line budget label", async () => {
	fs.mkdirSync(path.dirname(globalNotes), { recursive: true });
	fs.writeFileSync(globalNotes, "- (user) prefers incremental output\n- machine grep is aliased to rg\n");
	const sp = await inject();
	assert.ok(sp.includes("prefers incremental output"));
	assert.match(sp, /global \(.*notes\.md, 2\/150 lines\):/);
});

test("info reports notes status", async () => {
	const info = await tools.tape.execute("t1", { action: "info" }, undefined, undefined, ctx);
	const text = info.content[0].text;
	assert.match(text, /notes \(global\): .*2\/150 lines/);
	assert.match(text, /notes \(project\): none — /);
});

test("anchor reminder targets global notes; live anchor joins the list", async () => {
	const result = await tools.tape.execute("t2", { action: "anchor", name: "new-topic", summary: "Testing." }, undefined, undefined, ctx);
	const text = result.content[0].text;
	assert.ok(text.includes("add them now (edit "));
	assert.ok(text.includes("tape/notes.md"));

	branch.push({ type: "message", id: "bbbb2222-0000", timestamp: new Date().toISOString(), message: { role: "toolResult", toolName: "tape", content: result.content, details: result.details } });
	const sp = await inject();
	assert.match(sp, /recent anchors \(cwd\): \[new-topic\] .* · \[past-topic\]/);
});

test("over-budget warning", async () => {
	fs.writeFileSync(globalNotes, Array.from({ length: 160 }, (_, i) => `- fact ${i}`).join("\n"));
	const sp = await inject();
	assert.ok(sp.includes("over budget (160/150 lines), consider distilling"));
});

test("project notes switch the reminder target and get injected", async () => {
	fs.mkdirSync(path.dirname(projectNotes), { recursive: true });
	fs.writeFileSync(projectNotes, "- repo tests need bun\n");
	const result = await tools.tape.execute("t3", { action: "anchor", name: "another", summary: "x" }, undefined, undefined, ctx);
	assert.ok(result.content[0].text.includes(`${projectSlug}/notes.md`));
	const sp = await inject();
	assert.ok(sp.includes("repo tests need bun"));
});

test("view scope=cwd lists records through the index", async () => {
	const view = await tools.tape.execute("t4", { action: "view" }, undefined, undefined, ctx);
	assert.ok(view.content[0].text.includes("past-topic"));
});

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
