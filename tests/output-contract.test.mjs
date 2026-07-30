import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	DEFAULT_MAX_BYTES as MAX_BYTES,
	DEFAULT_MAX_LINES as MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { anchorEntry, loadTape, makeCtx, textMessage } from "./harness.mjs";

function assertBounded(result) {
	const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	assert.ok(Buffer.byteLength(text) <= MAX_BYTES, `expected <= ${MAX_BYTES} bytes`);
	assert.ok(text.split("\n").length <= MAX_LINES, `expected <= ${MAX_LINES} lines`);
	return text;
}

test("search details retain location metadata without copying matched payloads", async () => {
	const { tools } = await loadTape();
	const entry = {
		type: "message",
		id: "search-entry-0001",
		timestamp: "2026-07-27T00:00:00.000Z",
		message: textMessage("user", `needle ${"x".repeat(60 * 1024)}`),
	};
	const ctx = makeCtx({ cwd: "/work", branch: [entry], entries: [entry] });
	const result = await tools.tape.execute("search", { action: "search", query: "needle" }, undefined, undefined, ctx);

	assert.deepEqual(Object.keys(result.details).sort(), ["limit", "offset", "results", "total"]);
	assert.equal(result.details.results.length, 1);
	assert.equal("preview" in result.details.results[0], false);
	assert.equal(result.details.results[0].entryId, entry.id);
});

test("all actions share the final byte and line contract", async () => {
	const { tools } = await loadTape();
	const ctx = makeCtx({ cwd: "/work" });
	for (const [name, summary] of [
		["bytes", "x".repeat(60 * 1024)],
		["lines", Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n")],
	]) {
		const result = await tools.tape.execute("anchor", { action: "anchor", name, summary }, undefined, undefined, ctx);
		const text = assertBounded(result);
		assert.match(text, /Output truncated/);
		assert.equal(result.details.tapeAnchor.summary, summary, "anchor state remains authoritative and complete");
		assert.deepEqual(Object.keys(result.details).sort(), ["fullOutputPath", "tapeAnchor", "truncation"]);
		assert.equal(result.details.truncation.truncated, true);
		assert.ok(text.startsWith(result.details.truncation.content));
		assert.equal(result.details.truncation.outputBytes, Buffer.byteLength(result.details.truncation.content));
		const notice = text.slice(result.details.truncation.content.length);
		assert.equal(result.details.truncation.maxBytes + Buffer.byteLength(notice), MAX_BYTES);
		assert.equal(result.details.truncation.maxLines + 2, MAX_LINES);
		assert.equal(fs.readFileSync(result.details.fullOutputPath, "utf8"), `[Anchor: ${name}]\n${summary}`);
		fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
	}
});

test("single-line entry view remains useful and preserves the full rendering", async () => {
	const { tools } = await loadTape();
	const entry = {
		type: "message",
		id: "view-entry-0001",
		timestamp: "2026-07-27T00:00:00.000Z",
		message: textMessage("user", "v".repeat(60 * 1024)),
	};
	const ctx = makeCtx({ cwd: "/work", branch: [entry], entries: [entry] });
	const result = await tools.tape.execute("view", { action: "view", entryId: entry.id, scope: "branch" }, undefined, undefined, ctx);
	const text = assertBounded(result);
	assert.ok(text.startsWith("entry [view-ent]"));
	assert.match(text, /Output truncated/);
	assert.equal(result.details.truncation.firstLineExceedsLimit, false);
	assert.equal(result.details.truncation.lastLinePartial, false);
	assert.equal(result.details.truncation.outputLines, 2);
	assert.ok(fs.readFileSync(result.details.fullOutputPath, "utf8").length > MAX_BYTES);
	fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
});

test("oversized first line is marked as partial", async () => {
	const { tools } = await loadTape();
	const name = "n".repeat(60 * 1024);
	const result = await tools.tape.execute("anchor", { action: "anchor", name, summary: "summary" }, undefined, undefined, makeCtx({ cwd: "/work" }));
	const text = assertBounded(result);
	assert.ok(text.startsWith("[Anchor: "));
	assert.equal(result.details.truncation.firstLineExceedsLimit, true);
	assert.equal(result.details.truncation.lastLinePartial, true);
	assert.equal(result.details.truncation.outputLines, 1);
	assert.equal(result.details.truncation.outputBytes, Buffer.byteLength(result.details.truncation.content));
	fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
});

test("temp-file failure fails a truncated result", async () => {
	const { tools } = await loadTape();
	const ctx = makeCtx({ cwd: "/work" });
	const originalTmpdir = process.env.TMPDIR;
	try {
		process.env.TMPDIR = path.join(os.tmpdir(), `pi-tape-missing-${Date.now()}`, "nested");
		await assert.rejects(
			tools.tape.execute(
				"anchor",
				{ action: "anchor", name: "unsaved", summary: "x".repeat(60 * 1024) },
				undefined,
				undefined,
				ctx,
			),
			/ENOENT/,
		);
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
	}
});

test("semantic failures and cancellation reject while empty results remain successful", async () => {
	const { tools } = await loadTape();
	const entry = {
		type: "message",
		id: "entry-0001",
		timestamp: "2026-07-27T00:00:00.000Z",
		message: textMessage("user", "body"),
	};
	const secondEntry = {
		...entry,
		id: "entry-0002",
		timestamp: "2026-07-27T00:00:30.000Z",
	};
	const existing = anchorEntry({
		id: "anchor-0001",
		name: "existing",
		summary: "summary",
		cwd: "/work",
		createdAt: "2026-07-27T00:01:00.000Z",
	});
	const ctx = makeCtx({ cwd: "/work", branch: [entry, secondEntry, existing] });

	for (const [params, pattern] of [
		[{ action: "anchor" }, /name.*summary.*required/],
		[{ action: "anchor", name: "compact/reserved", summary: "x" }, /reserved/],
		[{ action: "anchor", name: "existing", summary: "x" }, /already exists/],
		[{ action: "view", entryId: "missing", scope: "branch" }, /No entry matching/],
		[{ action: "view", entryId: "entry-", scope: "branch" }, /ambiguous/],
		[{ action: "view", entryId: entry.id, scope: "branch", offset: 10 }, /beyond end of entry/],
		[{ action: "search" }, /query.*start.*end.*required/],
		[{ action: "search", start: "not-a-date" }, /not a valid timestamp/],
	]) {
		await assert.rejects(
			() => tools.tape.execute("failure", params, undefined, undefined, ctx),
			pattern,
		);
	}

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => tools.tape.execute("cancelled", { action: "search", query: "body", scope: "all" }, controller.signal, undefined, ctx),
		/Tape operation cancelled/,
	);

	const emptySearch = await tools.tape.execute("empty-search", { action: "search", query: "missing", scope: "branch" }, undefined, undefined, ctx);
	assert.match(emptySearch.content[0].text, /No entries matching/);
	const emptyView = await tools.tape.execute("empty-view", { action: "view", scope: "branch", offset: 10 }, undefined, undefined, makeCtx({ cwd: "/empty" }));
	assert.match(emptyView.content[0].text, /No records found/);
});

test("pagination parameters describe their shared semantics", async () => {
	const { tools } = await loadTape();
	const properties = tools.tape.parameters.properties;
	assert.equal(
		properties.limit.description,
		"Maximum items to return (lines when viewing an entry). Defaults: 20 records, 200 entry lines, 10 search results.",
	);
	assert.equal(
		properties.offset.description,
		"Number of items to skip (lines when viewing an entry). Default: 0.",
	);
});

test("search and record listings provide read-style offset continuation", async () => {
	const { tools } = await loadTape();
	const entries = Array.from({ length: 3 }, (_, index) => ({
		type: "message",
		id: `entry-${index}`,
		timestamp: `2026-07-27T00:0${index}:00.000Z`,
		message: textMessage("user", `needle ${index}`),
	}));
	const anchors = Array.from({ length: 3 }, (_, index) => anchorEntry({
		id: `anchor-${index}`,
		name: `anchor-${index}`,
		summary: `summary ${index}`,
		cwd: "/work",
		createdAt: `2026-07-27T00:1${index}:00.000Z`,
	}));

	const searchCtx = makeCtx({ cwd: "/work", branch: entries });
	const firstSearch = await tools.tape.execute("search-1", { action: "search", query: "needle", scope: "branch", limit: 1 }, undefined, undefined, searchCtx);
	assert.match(firstSearch.content[0].text, /\[2 more results\. Use offset=1 to continue\.\]/);
	const lastSearch = await tools.tape.execute("search-2", { action: "search", query: "needle", scope: "branch", limit: 1, offset: 2 }, undefined, undefined, searchCtx);
	assert.doesNotMatch(lastSearch.content[0].text, /more results/);
	const pastSearch = await tools.tape.execute("search-3", { action: "search", query: "needle", scope: "branch", limit: 1, offset: 3 }, undefined, undefined, searchCtx);
	assert.equal(pastSearch.content[0].text, "No entries at offset 3 (total 3).");
	const zeroSearch = await tools.tape.execute("search-0", { action: "search", query: "needle", scope: "branch", limit: 0 }, undefined, undefined, searchCtx);
	assert.equal(zeroSearch.details.limit, 1);
	assert.equal(zeroSearch.details.results.length, 1);
	assert.match(zeroSearch.content[0].text, /Use offset=1 to continue/);

	const viewCtx = makeCtx({ cwd: "/work", branch: anchors });
	const firstView = await tools.tape.execute("view-1", { action: "view", scope: "branch", limit: 1 }, undefined, undefined, viewCtx);
	assert.match(firstView.content[0].text, /\[2 more records\. Use offset=1 to continue\.\]/);
	const zeroView = await tools.tape.execute("view-0", { action: "view", scope: "branch", limit: 0 }, undefined, undefined, viewCtx);
	assert.equal(zeroView.details.limit, 1);
	assert.equal(zeroView.details.shown, 1);
	assert.match(zeroView.content[0].text, /Use offset=1 to continue/);

	const zeroEntryView = await tools.tape.execute("entry-view-0", { action: "view", entryId: entries[0].id, scope: "branch", limit: 0 }, undefined, undefined, searchCtx);
	assert.equal(zeroEntryView.details.limit, 1);
	assert.match(zeroEntryView.content[0].text, /Use offset=1 to continue/);
});

test("info details keep anchor identity without duplicating its summary", async () => {
	const { tools } = await loadTape();
	const anchor = anchorEntry({
		id: "anchor-info-0001",
		name: "latest",
		summary: "summary that already lives in tapeAnchor",
		cwd: "/work",
		createdAt: "2026-07-27T00:00:00.000Z",
	});
	const ctx = makeCtx({ cwd: "/work", branch: [anchor], entries: [anchor] });
	const result = await tools.tape.execute("info", { action: "info" }, undefined, undefined, ctx);
	assert.deepEqual(Object.keys(result.details.latest).sort(), ["entryId", "name", "timestamp"]);
});
