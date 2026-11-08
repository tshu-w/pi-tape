// Dream: trigger decision, edit allowlist in a dream run, input extraction, and early exits.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { anchorEntry, loadDreamModule, loadTape, makeAgentDir, textMessage, writeSession } from "./harness.mjs";

const agentDir = makeAgentDir();
const spawned = [];
childProcess.spawn = (command, args, options) => {
	const listeners = {};
	spawned.push({ command, args, options, listeners });
	return { pid: 999999, on(event, listener) { listeners[event] = listener; }, unref() {} };
};
syncBuiltinESMExports();

const dream = await loadDreamModule();
const { handlers, appended, entryRenderers } = await loadTape();
const dreamDir = path.join(agentDir, "tape", "dream");
const iso = (ms) => new Date(ms).toISOString();
const entry = (id, time, message) => ({ type: "message", id, timestamp: iso(time), message });
const tui = { mode: "tui", isIdle: () => true };
const writeSettings = (settings) => fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ "pi-tape": { dream: settings } }));

test("dream starts only when due, after enough messages the user typed", async () => {
	const hour = 60 * 60_000;
	// In the past, so the hourly check gate leaves later tests free to start a run.
	const now = Date.now() - 3 * hour;
	writeSettings({ enabled: false, minMessages: 2 });
	assert.equal(await dream.maybeStartDream("tui", now), "disabled");

	writeSettings({ enabled: true, minMessages: 2 });
	assert.equal(await dream.maybeStartDream("print", now), "skip");
	process.env.PI_TAPE_DREAM = "1";
	assert.equal(await dream.maybeStartDream("tui", now), "skip");
	delete process.env.PI_TAPE_DREAM;

	const typed = entry("typed-1", now - 2 * 60_000, textMessage("user", "first"));
	const relayed = entry("relayed", now - 90_000, textMessage("user", '<agent-message name="main">relay</agent-message>'));
	const file = writeSession(agentDir, "--work--", "work.jsonl", "/work", [typed, relayed]);
	assert.equal(await dream.maybeStartDream("tui", now), "too-few-messages");
	assert.equal(await dream.maybeStartDream("tui", now + 60_000), "checked-recently");

	fs.appendFileSync(file, `\n${JSON.stringify(entry("typed-2", now - 60_000, textMessage("user", "second")))}\n`);
	assert.equal(await dream.maybeStartDream("tui", now + hour), "started");
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0].options.env.PI_TAPE_DREAM, "1");
	assert.equal(spawned[0].options.detached, true);
	assert.ok(["-p", "--no-session", "--no-mcp"].every((arg) => spawned[0].args.includes(arg)));
	assert.equal(spawned[0].args.includes("--model"), false);
	assert.ok(fs.existsSync(path.join(dreamDir, "lock")));
	const { id } = JSON.parse(fs.readFileSync(path.join(dreamDir, "state.json"), "utf-8")).lastRun;
	assert.match(id, /^\d{4}-\d{2}-\d{2}-\d{4}$/);
	assert.ok(fs.existsSync(path.join(dreamDir, `${id}.md`)));
	assert.equal(await dream.maybeStartDream("tui", now + 2 * hour), "not-due");
});

test("a dream run edits only memory files and the next startup shows its diff once", async () => {
	const memory = path.join(agentDir, "tape", "memory");
	const index = path.join(memory, "MEMORY.md");
	fs.mkdirSync(memory, { recursive: true });
	fs.writeFileSync(index, "- old\n");
	fs.writeFileSync(path.join(memory, "kept.md"), "kept\n");
	const ctx = { cwd: agentDir };
	const call = (toolName, input) => handlers.tool_call({ type: "tool_call", toolName, toolCallId: "call", input }, ctx);

	process.env.PI_TAPE_DREAM = "1";
	try {
		handlers.session_start({ type: "session_start", reason: "startup" }, { mode: "print" });
		assert.equal(await call("edit", { path: "tape/memory/MEMORY.md" }), undefined);
		assert.equal(await call("edit", { path: path.join(memory, "kept.md") }), undefined);
		assert.equal(await call("write", { path: path.join(memory, "topic.md") }), undefined);
		for (const target of ["AGENTS.md", "skills/x/SKILL.md", "tape/memory/../notes.md", "/tmp/elsewhere.md"]) {
			assert.equal((await call("edit", { path: target }))?.block, true, target);
		}
		assert.equal((await call("tape", { action: "anchor", name: "a", summary: "s" }))?.block, true);
		fs.writeFileSync(index, "- new\n- see topic.md\n");
		fs.writeFileSync(path.join(memory, "topic.md"), "details\n");
		// A failed attempt that an automatic retry then completes.
		handlers.agent_end({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "overloaded", content: [] }] }, ctx);
		handlers.agent_end({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "## Changes\n- MEMORY.md: merged" }] }] }, ctx);
		handlers.agent_settled({ type: "agent_settled" }, ctx);
		handlers.session_shutdown({ type: "session_shutdown" }, ctx);
	} finally {
		delete process.env.PI_TAPE_DREAM;
	}

	const readState = () => JSON.parse(fs.readFileSync(path.join(dreamDir, "state.json"), "utf-8"));
	const { lastRun, lastSuccess } = readState();
	assert.equal(lastSuccess, lastRun.startedAt);
	assert.deepEqual(fs.readdirSync(path.join(dreamDir, lastRun.id)), ["MEMORY.md"]);
	assert.equal(fs.readFileSync(path.join(dreamDir, lastRun.id, "MEMORY.md"), "utf-8"), "- old\n");

	handlers.session_start({ type: "session_start", reason: "startup" }, tui);
	handlers.session_start({ type: "session_start", reason: "startup" }, tui);
	assert.equal(appended.length, 1);
	assert.equal(appended[0].data.summary, "MEMORY.md 1→2 lines · 1 topic file");
	assert.deepEqual(appended[0].data.files.map((file) => [file.label, file.reason]), [["MEMORY.md", "merged"], ["topic.md", undefined]]);
	assert.deepEqual(appended[0].data.blocked, ["AGENTS.md", "skills/x/SKILL.md", "tape/notes.md", "/tmp/elsewhere.md"].map((file) => file.startsWith("/") ? file : path.join(agentDir, file)));
	initTheme("dark", false);
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const rendered = entryRenderers["tape-dream"](appended[0], { expanded: false }, theme).render(200).join("\n");
	assert.ok(["MEMORY.md 1→2 lines", "blocked: /tmp/elsewhere.md", "MEMORY.md — merged", "- new"].every((text) => rendered.includes(text)), rendered);
	assert.equal(readState().lastRun.files, undefined);
});

test("a dream run shut down before it settles fails as interrupted", () => {
	const statePath = path.join(dreamDir, "state.json");
	const { lastSuccess } = JSON.parse(fs.readFileSync(statePath, "utf-8"));
	fs.writeFileSync(statePath, JSON.stringify({ lastSuccess, lastRun: { id: "interrupted", since: lastSuccess, startedAt: iso(Date.now()), noticed: false } }));
	process.env.PI_TAPE_DREAM = "1";
	try {
		handlers.session_start({ type: "session_start", reason: "startup" }, { mode: "print" });
		handlers.session_shutdown({ type: "session_shutdown" }, { cwd: agentDir });
	} finally {
		delete process.env.PI_TAPE_DREAM;
	}
	const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
	assert.equal(state.lastSuccess, lastSuccess);
	assert.match(state.lastRun.error, /interrupted/);
});

test("dream input keeps in-range anchors and user messages in full", () => {
	const since = Date.parse("2026-01-01T00:00:00Z");
	const until = since + 1_000_000;
	writeSession(agentDir, "--extract--", "range.jsonl", "/w", [
		entry("before", since - 1, textMessage("user", "too old")),
		entry("forwarded", since + 1, textMessage("user", '<agent-message name="main">relay</agent-message>')),
		entry("assistant", since + 2, textMessage("assistant", "reply")),
		anchorEntry({ id: "anchor", name: "topic", summary: "anchor summary", cwd: "/w", createdAt: iso(since + 3) }),
		entry("long", since + 4, textMessage("user", "x".repeat(4000))),
		entry("after", until + 1, textMessage("user", "too new")),
	]);
	const input = dream.buildDreamInput(since, until);
	assert.equal(input.anchors, 1);
	assert.equal(input.messages, 1);
	assert.match(input.text, /anchor summary/);
	assert.ok(["too old", "relay", "reply", "too new"].every((text) => !input.text.includes(text)));
	assert.ok(input.text.includes("x".repeat(4000)));
});

test("a dream process that exits without a result is shown by the session that started it", async () => {
	writeSettings({ enabled: true, minMessages: 0 });
	const statePath = path.join(dreamDir, "state.json");
	fs.writeFileSync(statePath, JSON.stringify({ lastAttempt: iso(Date.now() - 2 * 86_400_000) }));
	const shown = appended.length;
	handlers.session_start({ type: "session_start", reason: "startup" }, tui);
	for (let i = 0; i < 200 && spawned.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));

	const { lastRun } = JSON.parse(fs.readFileSync(statePath, "utf-8"));
	assert.equal(lastRun.pid, 999999);
	assert.equal(spawned[1].args.includes("--model"), false);
	fs.writeFileSync(path.join(dreamDir, `${lastRun.id}.md`), 'Error: Model "x/y" not found\n');
	spawned[1].listeners.exit();
	assert.equal(appended.length, shown + 1);
	assert.match(appended.at(-1).data.error, /Model "x\/y" not found/);
	assert.equal(JSON.parse(fs.readFileSync(statePath, "utf-8")).lastRun.noticed, true);
	assert.equal(fs.existsSync(path.join(dreamDir, "lock")), false);
});

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
