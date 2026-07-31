import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { anchorEntry, loadTape, makeAgentDir, makeCtx, textMessage } from "./harness.mjs";

const agentDir = makeAgentDir();
const cwd = "/tmp/pi-tape-custom-session-project";
const customSessionDir = path.join(agentDir, "custom-sessions");
const externalSessionFile = path.join(agentDir, "external", "current.jsonl");
fs.mkdirSync(customSessionDir, { recursive: true });

const duplicated = {
	type: "message",
	id: "duplicate-entry-id",
	parentId: null,
	timestamp: "2026-08-01T10:00:00.000Z",
	message: textMessage("user", "fork duplicated marker", Date.parse("2026-08-01T10:00:00.000Z")),
};
const closedSessionFile = path.join(customSessionDir, "fork.jsonl");
fs.writeFileSync(closedSessionFile, [
	JSON.stringify({ type: "session", cwd }),
	JSON.stringify(duplicated),
	JSON.stringify({
		type: "message",
		id: "closed-entry-id",
		parentId: duplicated.id,
		timestamp: "2026-08-01T10:01:00.000Z",
		message: textMessage("user", "closed custom marker", Date.parse("2026-08-01T10:01:00.000Z")),
	}),
].join("\n"));

const currentEntries = [
	duplicated,
	{
		type: "message",
		id: "live-entry-id",
		parentId: duplicated.id,
		timestamp: "2026-08-01T10:02:00.000Z",
		message: textMessage("user", "live external marker", Date.parse("2026-08-01T10:02:00.000Z")),
	},
	anchorEntry({
		id: "live-anchor-id",
		name: "live-external-anchor",
		summary: "Current external session anchor.",
		cwd,
		createdAt: "2026-08-01T10:03:00.000Z",
	}),
];
const ctx = makeCtx({
	cwd,
	sessionFile: externalSessionFile,
	sessionDir: customSessionDir,
	branch: currentEntries,
	entries: currentEntries,
});
const { tools, handlers } = await loadTape();

test("custom session dir scans closed sessions and always includes the external current session", async () => {
	const closed = await tools.tape.execute("s1", { action: "search", query: "closed custom", scope: "cwd" }, undefined, undefined, ctx);
	assert.equal(closed.details.results[0].sessionFile, fs.realpathSync(closedSessionFile));

	const live = await tools.tape.execute("s2", { action: "search", query: "live external", scope: "all" }, undefined, undefined, ctx);
	assert.equal(live.details.results[0].sessionFile, externalSessionFile);

	const records = await tools.tape.execute("v1", { action: "view", scope: "all" }, undefined, undefined, ctx);
	assert.match(records.content[0].text, /live-external-anchor/);

	const injected = await handlers.before_agent_start({ systemPrompt: "SYS" }, ctx);
	assert.match(injected.systemPrompt, /recent anchors .*\[live-external-anchor\]/);
});

test("cross-session search body returns a complete sessionFile usable by view for duplicated fork IDs", async () => {
	const search = await tools.tape.execute("s3", { action: "search", query: "fork duplicated", scope: "all" }, undefined, undefined, ctx);
	assert.equal(search.details.total, 1);
	const result = search.details.results[0];
	assert.equal(result.sessionFile, externalSessionFile, "the live current copy is the stable preferred result");
	assert.ok(path.isAbsolute(result.sessionFile));
	assert.ok(search.content[0].text.includes(`sessionFile=${JSON.stringify(result.sessionFile)}`));

	const view = await tools.tape.execute("v2", { action: "view", entryId: duplicated.id, sessionFile: result.sessionFile }, undefined, undefined, ctx);
	assert.match(view.content[0].text, /fork duplicated marker/);
	assert.equal(view.details.sessionFile, externalSessionFile);
});

test("view rejects session-shaped JSONL outside managed session locations", async () => {
	const untrustedFile = path.join(agentDir, "outside", "untrusted.jsonl");
	fs.mkdirSync(path.dirname(untrustedFile), { recursive: true });
	fs.writeFileSync(untrustedFile, [
		JSON.stringify({ type: "session", cwd }),
		JSON.stringify({
			type: "message",
			id: "untrusted-entry-id",
			timestamp: "2026-08-01T10:04:00.000Z",
			message: textMessage("user", "untrusted marker"),
		}),
	].join("\n"));

	await assert.rejects(
		tools.tape.execute("v3", { action: "view", entryId: "untrusted-entry-id", sessionFile: untrustedFile }, undefined, undefined, ctx),
		/configured session directories/,
	);
});

test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
