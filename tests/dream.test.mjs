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

test("dream starts only for a due interactive startup with enough new anchors", async () => {
	const now = Date.now();
	writeSettings({ enabled: false, minAnchors: 2 });
	assert.equal(await dream.maybeStartDream("startup", "tui", now), "disabled");

	writeSettings({ enabled: true, minAnchors: 2 });
	assert.equal(await dream.maybeStartDream("reload", "tui", now), "skip");
	assert.equal(await dream.maybeStartDream("startup", "print", now), "skip");
	process.env.PI_TAPE_DREAM = "1";
	assert.equal(await dream.maybeStartDream("startup", "tui", now), "skip");
	delete process.env.PI_TAPE_DREAM;

	const anchors = [1, 2].map((n) => anchorEntry({ id: `anchor-${n}`, name: `a${n}`, summary: "s", cwd: "/work", createdAt: iso(now - n * 60_000) }));
	writeSession(agentDir, "--work--", "work.jsonl", "/work", anchors.slice(0, 1));
	assert.equal(await dream.maybeStartDream("startup", "tui", now), "too-few-anchors");

	writeSession(agentDir, "--work--", "work.jsonl", "/work", anchors);
	assert.equal(await dream.maybeStartDream("startup", "tui", now), "started");
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0].options.env.PI_TAPE_DREAM, "1");
	assert.equal(spawned[0].options.detached, true);
	assert.ok(["-p", "--no-session", "--no-mcp"].every((arg) => spawned[0].args.includes(arg)));
	assert.equal(spawned[0].args.includes("-ne"), false);
	assert.equal(spawned[0].args.includes("--model"), false);
	assert.ok(fs.existsSync(path.join(dreamDir, "lock")));
	const { id } = JSON.parse(fs.readFileSync(path.join(dreamDir, "state.json"), "utf-8")).lastRun;
	assert.match(id, /^\d{4}-\d{2}-\d{2}-\d{4}$/);
	assert.ok(fs.existsSync(path.join(dreamDir, `${id}.md`)));
	assert.equal(await dream.maybeStartDream("startup", "tui", now + 60_000), "not-due");
});

test("a dream run edits only memory files and the next startup shows its diff once", async () => {
	const notes = path.join(agentDir, "tape", "notes.md");
	fs.writeFileSync(notes, "- old\n");
	const ctx = { cwd: agentDir };
	const call = (toolName, input) => handlers.tool_call({ type: "tool_call", toolName, toolCallId: "call", input }, ctx);

	process.env.PI_TAPE_DREAM = "1";
	try {
		handlers.session_start({ type: "session_start", reason: "startup" }, { mode: "print" });
		assert.equal(await call("edit", { path: "tape/notes.md" }), undefined);
		assert.equal(await call("write", { path: path.join(agentDir, "skills", "dream-x", "SKILL.md") }), undefined);
		assert.equal(await call("edit", { path: path.join(agentDir, "AGENTS.md") }), undefined);
		for (const target of ["settings.json", "skills/../settings.json", "/tmp/elsewhere.md"]) {
			assert.equal((await call("edit", { path: target }))?.block, true, target);
		}
		assert.equal((await call("tape", { action: "anchor", name: "a", summary: "s" }))?.block, true);
		fs.writeFileSync(notes, "- new\n");
		handlers.agent_end({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "## Changes\n- notes.md: merged" }] }] }, ctx);
		handlers.session_shutdown({ type: "session_shutdown" }, ctx);
	} finally {
		delete process.env.PI_TAPE_DREAM;
	}

	const readState = () => JSON.parse(fs.readFileSync(path.join(dreamDir, "state.json"), "utf-8"));
	const { lastRun, lastSuccess } = readState();
	assert.equal(lastSuccess, lastRun.startedAt);
	assert.deepEqual(fs.readdirSync(dreamDir).sort(), [`${lastRun.id}.md`, `${lastRun.id}.notes.md`, "state.json"]);
	assert.equal(fs.readFileSync(path.join(dreamDir, `${lastRun.id}.notes.md`), "utf-8"), "- old\n");

	handlers.session_start({ type: "session_start", reason: "startup" }, tui);
	handlers.session_start({ type: "session_start", reason: "startup" }, tui);
	assert.equal(appended.length, 1);
	assert.equal(appended[0].data.summary, "notes 1→1 lines");
	assert.deepEqual(appended[0].data.files.map((file) => [file.label, file.reason]), [["notes.md", "merged"]]);
	assert.deepEqual(appended[0].data.blocked, [path.join(agentDir, "settings.json"), "/tmp/elsewhere.md"]);
	initTheme("dark", false);
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const rendered = entryRenderers["tape-dream"](appended[0], { expanded: false }, theme).render(200).join("\n");
	assert.ok(["notes 1→1 lines", "blocked: /tmp/elsewhere.md", "notes.md — merged", "- new"].every((text) => rendered.includes(text)), rendered);
	assert.equal(readState().lastRun.files, undefined);
});

test("dream input keeps in-range anchors and user messages and drops the oldest over budget", () => {
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

	writeSession(agentDir, "--extract--", "many.jsonl", "/w",
		Array.from({ length: 200 }, (_, i) => entry(`m${i}`, since + 10 + i, textMessage("user", `${i} ${"y".repeat(1500)}`))));
	const bounded = dream.buildDreamInput(since, until);
	assert.ok(bounded.omitted > 0);
	assert.match(bounded.text, /oldest items omitted/);
	assert.ok(bounded.text.includes("entryId=m199 "));
	assert.ok(!bounded.text.includes("entryId=anchor "));
});

test("a dream process that exits without a result is shown by the session that started it", async () => {
	writeSettings({ enabled: true, minAnchors: 0 });
	const statePath = path.join(dreamDir, "state.json");
	fs.writeFileSync(statePath, JSON.stringify({ lastAttempt: iso(Date.now() - 4 * 86_400_000) }));
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
