import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJiti } from "jiti";
import { buildSessionProjection, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { anchorEntry, makeAgentDir, makeCtx, textMessage } from "./harness.mjs";
const { executeHistory } = await createJiti(import.meta.url).import("../extensions/history.ts");
makeAgentDir();
const entry = (id, text, timestamp = "2026-07-27T00:00:00Z") => ({ type: "message", id, timestamp, message: textMessage("user", text) });
const execute = (params, entries = [], excluded = new Set(), signal) => executeHistory(params, signal, makeCtx({ cwd: "/work", branch: entries }), { entryIds: excluded, entries: buildSessionProjection(entries).entries });

test("search uses substring AND/OR, newest-first ordering, and exact output records", async () => {
	const entries = [entry("old", "Alpha Beta", "2026-07-26T00:00:00Z"), entry("new", "gamma", "2026-07-27T00:00:00Z"), entry("miss", "alpha")];
	const response = await execute({ action: "search", query: "ALP beta | GAM", limit: 1 }, entries);
	assert.equal(response.content[0].text, "new  user  2026-07-27 00:00\n  gamma\n\n[1 more results. Use offset=1 to continue.]");
	assert.equal(response.details.total, 2);
	assert.equal(response.details.results[0].entryId, "new");
	assert.equal("preview" in response.details.results[0], false);
	const past = await execute({ action: "search", query: "alpha", offset: 100 }, entries);
	assert.equal(past.content[0].text, "No matching entries.");
	assert.equal(past.details.total, 2);
});

test("context entries are excluded but compactions and legacy anchor summaries remain searchable", async () => {
	const entries = [entry("raw", "needle"), { type: "compaction", id: "summary", timestamp: "2026-07-27T00:01:00Z", summary: "needle summary", firstKeptEntryId: "raw" }, anchorEntry({ id: "legacy", name: "old", summary: "needle legacy", cwd: "/work", createdAt: "2026-07-27T00:02:00Z" })];
	entries.forEach((item, index) => { item.parentId = index ? entries[index - 1].id : null; });
	const response = await execute({ action: "search", query: "needle", kinds: ["message", "compaction"] }, entries, new Set(entries.map(item => item.id)));
	assert.deepEqual(response.details.results.map(item => [item.entryId, item.kind]), [["legacy", "compaction"], ["summary", "compaction"]]);
});

test("default search includes calls and results, excludes tape and thinking", async () => {
	const assistant = { ...entry("calls", ""), message: { role: "assistant", content: [{ type: "thinking", thinking: "secret needle" }, { type: "toolCall", name: "tape", arguments: { query: "needle" } }, { type: "toolCall", name: "bash", arguments: { command: "needle" } }] } };
	const tool = { ...entry("tool", ""), message: { role: "toolResult", toolName: "bash", content: "needle output" } };
	const tape = { ...tool, id: "tape", message: { ...tool.message, toolName: "tape" } };
	const response = await execute({ action: "search", query: "needle" }, [assistant, tool, tape]);
	assert.deepEqual(response.details.results.map(item => item.kind), ["tool_call", "tool_result"]);
	assert.doesNotMatch(response.content[0].text, /secret|tool_call tape|tool_result tape/);
});

test("kinds-only and inclusive date filters cover summaries and custom entries", async () => {
	const entries = [{ type: "branch_summary", id: "branch", summary: "branch notes", timestamp: "2026-07-27T23:59:59.999Z" }, { type: "custom", id: "custom", data: { marker: "metadata" }, timestamp: "2026-07-28T00:00:00Z" }];
	const response = await execute({ action: "search", kinds: ["branch_summary", "custom"], start: "2026-07-27", end: "2026-07-27" }, entries);
	assert.deepEqual(response.details.results.map(item => item.entryId), ["branch"]);
	const custom = await execute({ action: "search", kinds: ["custom"] }, entries);
	assert.match(custom.content[0].text, /metadata/);
});

test("previews collapse whitespace near the match and fit 200 Unicode characters", async () => {
	const response = await execute({ action: "search", query: "needle" }, [entry("unicode", "😀".repeat(300) + "\n\t needle   " + "中".repeat(300))]);
	const preview = response.content[0].text.split("\n")[1].slice(2);
	assert.ok(Array.from(preview).length <= 200);
	assert.match(preview, /needle/);
	assert.doesNotMatch(preview, /\s{2}|\uFFFD/);
	assert.ok(preview.startsWith("…") && preview.endsWith("…"));
});

test("search truncates only between records and continues after actual shown count", async () => {
	const entries = Array.from({ length: 600 }, (_, i) => entry(`entry-${i}`, "中".repeat(200)));
	const response = await execute({ action: "search", kinds: ["message"], limit: 600 }, entries);
	const shown = response.details.results.length;
	assert.ok(shown > 0 && shown < entries.length);
	assert.ok(Buffer.byteLength(response.content[0].text.split("\n\n[")[0]) <= DEFAULT_MAX_BYTES);
	assert.match(response.content[0].text, new RegExp(`Use offset=${shown} to continue`));
	assert.equal(response.content[0].text.split("\n\n[")[0].split("\n\n").length, shown);
	const next = await execute({ action: "search", kinds: ["message"], limit: 600, offset: shown }, entries);
	assert.equal(next.details.results[0].entryId, entries[shown].id);
});

test("view preserves all lines across native line and byte pagination", async () => {
	for (const lines of [Array.from({ length: DEFAULT_MAX_LINES + 50 }, (_, i) => `line ${i}`), Array.from({ length: 100 }, (_, i) => `${i} ${"中".repeat(500)}`), ["", "one", "", "two", ""]]) {
		const e = entry("paged", lines.join("\n"));
		let offset = 1;
		const recovered = [];
		while (true) {
			const response = await execute({ action: "view", entryId: e.id, offset }, [e]);
			const text = response.content[0].text;
			const body = text.slice(text.indexOf("\n") + 1).split("\n\n[Showing lines ")[0];
			recovered.push(...body.split("\n"));
			assert.equal(response.details.shownLines, body.split("\n").length);
			assert.ok(Buffer.byteLength(body) <= DEFAULT_MAX_BYTES);
			const continuation = text.match(/Use offset=(\d+) to continue/);
			if (!continuation) break;
			assert.ok(Number(continuation[1]) > offset);
			offset = Number(continuation[1]);
		}
		assert.deepEqual(recovered, lines);
	}
});

test("view explicit line paging and oversized-line recovery retain complete selected body", async () => {
	const normal = await execute({ action: "view", entryId: "normal", offset: 2, limit: 1 }, [entry("normal", "one\ntwo\nthree")]);
	assert.equal(normal.content[0].text, "normal  user  2026-07-27 00:00\ntwo\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]");
	const lines = ["x".repeat(DEFAULT_MAX_BYTES + 1), "middle", "last"];
	const response = await execute({ action: "view", entryId: "huge", limit: 2 }, [entry("huge", lines.join("\n"))]);
	assert.equal(response.details.shownLines, 0);
	assert.equal(response.details.truncation.firstLineExceedsLimit, true);
	assert.equal(fs.readFileSync(response.details.fullOutputPath, "utf8"), lines.slice(0, 2).join("\n"));
	assert.match(response.content[0].text, /Read the full page file before continuing\. Use offset=3/);
	assert.ok(response.content[0].text.includes(response.details.fullOutputPath));
});

test("semantic errors and cancellation reject; empty matches succeed", async () => {
	for (const [params, pattern] of [
		[{ action: "search" }, /`query`, `kinds`, `start`, or `end` is required/],
		[{ action: "search", query: "|" }, /search term/],
		[{ action: "search", start: "not-date" }, /`start` is not a valid timestamp/],
		[{ action: "search", start: "2026-02-30" }, /`start` is not a valid timestamp/],
		[{ action: "search", kinds: ["anchor"] }, /`kinds`/],
		[{ action: "search", query: "x", limit: 0 }, /`limit`/],
		[{ action: "view" }, /`entryId` is required/],
		[{ action: "view", entryId: "missing" }, /No entry missing in this Session/],
		[{ action: "view", entryId: "body", offset: 2 }, /`offset`.*beyond end/],
	]) await assert.rejects(execute(params, [entry("body", "body")]), pattern);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(execute({ action: "search", query: "x" }, [], new Set(), controller.signal), /Operation aborted/);
	assert.equal((await execute({ action: "search", query: "none" })).content[0].text, "No matching entries.");
});

test("oversized-line file creation failures propagate", async () => {
	const original = process.env.TMPDIR;
	try {
		process.env.TMPDIR = path.join(os.tmpdir(), `pi-tape-missing-${Date.now()}`, "nested");
		await assert.rejects(execute({ action: "view", entryId: "huge" }, [entry("huge", "x".repeat(DEFAULT_MAX_BYTES + 1))]), /ENOENT/);
	} finally {
		if (original === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = original;
	}
});
