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
	// The limits bound the retained content; the truncation notice sits on top of it.
	const content = result.details?.truncation?.content ?? text;
	assert.ok(Buffer.byteLength(content) <= MAX_BYTES, `expected <= ${MAX_BYTES} bytes`);
	assert.ok(content.split("\n").length <= MAX_LINES, `expected <= ${MAX_LINES} lines`);
	return text;
}

test("search details retain location metadata without copying matched payloads", async () => {
	const { tools } = await loadTape();
	const entry = {
		type: "message",
		id: "search-entry-0001",
		timestamp: "2026-07-27T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolName: "bash",
			content: [{ type: "text", text: `needle ${"x".repeat(60 * 1024)}` }],
		},
	};
	const ctx = makeCtx({ cwd: "/work", branch: [entry], entries: [entry] });
	const result = await tools.tape.execute("search", { action: "search", query: "needle" }, undefined, undefined, ctx);

	assert.deepEqual(Object.keys(result.details).sort(), ["limit", "offset", "results", "total"]);
	assert.equal(result.details.results.length, 1);
	assert.equal("preview" in result.details.results[0], false);
	assert.equal(result.details.results[0].entryId, entry.id);
	assert.equal(result.details.results[0].role, "toolResult");
	assert.equal(result.details.results[0].toolName, "bash");
	assert.match(result.content[0].text, /entryId=search-e kind=tool_result tool=bash time=/);
	assert.doesNotMatch(result.content[0].text, /role=toolResult/);
	assert.match(result.content[0].text, /…"$/);
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
		assert.match(text, /Showing lines/);
		assert.equal(result.details.tapeAnchor.summary, summary, "anchor state remains authoritative and complete");
		assert.deepEqual(Object.keys(result.details).sort(), ["fullOutputPath", "tapeAnchor", "truncation"]);
		assert.equal(result.details.truncation.truncated, true);
		assert.ok(text.startsWith(result.details.truncation.content));
		assert.equal(result.details.truncation.outputBytes, Buffer.byteLength(result.details.truncation.content));
		const notice = text.slice(result.details.truncation.content.length);
		assert.equal(
			notice,
			`\n\n[Showing lines 1-${name === "bytes" ? 1 : 2000} of ${name === "bytes" ? 2 : 2101}${name === "bytes" ? " (50.0KB limit)" : ""}. Full output: ${result.details.fullOutputPath}]`,
		);
		assert.equal(result.details.truncation.maxBytes, MAX_BYTES);
		assert.equal(result.details.truncation.maxLines, MAX_LINES);
		assert.equal(fs.readFileSync(result.details.fullOutputPath, "utf8"), `Anchor created: ${name}\n${summary}`);
		fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
	}
});

test("single-line entry view saves the complete body without a continuation", async () => {
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
	assert.ok(text.startsWith("entryId=view-ent type=message role=user time=2026-07-27 00:00:00\n\n"));
	assert.ok(text.includes(result.details.fullOutputPath));
	assert.doesNotMatch(text, /Use offset=/);
	assert.equal(result.details.truncation.firstLineExceedsLimit, true);
	assert.equal(result.details.truncation.lastLinePartial, false);
	assert.equal(result.details.truncation.outputLines, 0);
	assert.equal(result.details.totalLines, 1);
	assert.equal(result.details.shownLines, 0);
	assert.equal(result.details.offset, 1);
	assert.equal(result.details.limit, null);
	assert.equal(fs.readFileSync(result.details.fullOutputPath, "utf8"), "v".repeat(60 * 1024));
	fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
});

test("oversized entry pages recover the selected body before continuing at the page end", async () => {
	const { tools } = await loadTape();
	const lines = ["x".repeat(60 * 1024), "middle", "lastline"];
	for (const [bodyLines, limit] of [[[lines[0], "lastline"], 1], [lines, 2], [lines, undefined]]) {
		const entry = { type: "message", id: "long-page", timestamp: "2026-07-27T00:00:00.000Z", message: textMessage("user", bodyLines.join("\n")) };
		const ctx = makeCtx({ cwd: "/work", branch: [entry] });
		const result = await tools.tape.execute("view", { action: "view", entryId: entry.id, scope: "branch", limit }, undefined, undefined, ctx);
		const text = assertBounded(result);
		const selected = bodyLines.slice(0, limit ?? bodyLines.length).join("\n");
		const saved = fs.readFileSync(result.details.fullOutputPath, "utf8");
		assert.equal(saved, selected);
		assert.equal(result.details.shownLines, 0);
		assert.equal(result.details.truncation.outputBytes, 0);
		assert.ok(text.includes(result.details.fullOutputPath));
		const continuation = text.match(/Use offset=(\d+) to continue/);
		if (limit !== undefined) {
			assert.match(text, /Read the full page file before continuing/);
			assert.equal(Number(continuation?.[1]), limit + 1);
			const next = await tools.tape.execute("next", { action: "view", entryId: entry.id, scope: "branch", offset: Number(continuation[1]) }, undefined, undefined, ctx);
			assert.equal(next.details.fullOutputPath, undefined);
			const tail = next.content[0].text.slice(next.content[0].text.indexOf("\n\n") + 2);
			assert.equal(saved + "\n" + tail, bodyLines.join("\n"));
			assert.doesNotMatch(next.content[0].text, /Use offset=/);
		} else {
			assert.equal(continuation, null);
			assert.equal(saved, bodyLines.join("\n"));
		}
		fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
	}
});

test("entry limit paging retains the entire bounded body and appends navigation outside its budget", async () => {
	const { tools } = await loadTape();
	const lines = ["x".repeat(MAX_BYTES), "lastline"];
	const entry = { type: "message", id: "exact-page", timestamp: "2026-07-27T00:00:00.000Z", message: textMessage("user", lines.join("\n")) };
	const ctx = makeCtx({ cwd: "/work", branch: [entry] });
	const first = await tools.tape.execute("view", { action: "view", entryId: entry.id, limit: 1 }, undefined, undefined, ctx);
	assertBounded(first);
	assert.equal(first.details.fullOutputPath, undefined);
	assert.equal(first.details.truncation.truncated, false);
	assert.equal(first.details.truncation.content, lines[0]);
	assert.equal(first.details.shownLines, 1);
	assert.ok(first.content[0].text.includes(lines[0]));
	assert.match(first.content[0].text, /Use offset=2 to continue/);
	const last = await tools.tape.execute("view", { action: "view", entryId: entry.id, offset: 2, limit: 1 }, undefined, undefined, ctx);
	assert.equal(last.details.truncation.content, lines[1]);
	assert.doesNotMatch(last.content[0].text, /Use offset=/);
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
		await assert.rejects(
			tools.tape.execute(
				"search",
				{ action: "search", start: "x".repeat(60 * 1024) },
				undefined,
				undefined,
				ctx,
			),
			/`start` is not a valid timestamp\. Use an ISO timestamp or YYYY-MM-DD\./,
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
	const originalError = new TypeError("original failure");
	const failingCtx = makeCtx({ cwd: "/work" });
	failingCtx.sessionManager.getBranch = () => {
		throw originalError;
	};
	await assert.rejects(
		() => tools.tape.execute("original-error", { action: "view" }, undefined, undefined, failingCtx),
		(error) => error === originalError,
	);

	for (const [params, pattern] of [
		[{ action: "anchor" }, /name.*summary.*required/],
		[{ action: "anchor", name: "empty-summary", summary: " \n " }, /summary.*non-whitespace/],
		[{ action: "anchor", name: "compact/reserved", summary: "x" }, /reserved/],
		[{ action: "anchor", name: "bad\nname", summary: "x" }, /lowercase slug.*80 characters/],
		[{ action: "anchor", name: "Bad-Name", summary: "x" }, /lowercase slug.*80 characters/],
		[{ action: "anchor", name: "bad__name", summary: "x" }, /lowercase slug.*80 characters/],
		[{ action: "anchor", name: "bad--name", summary: "x" }, /lowercase slug.*80 characters/],
		[{ action: "anchor", name: "x".repeat(81), summary: "x" }, /lowercase slug.*80 characters/],
		[{ action: "anchor", name: "existing", summary: "x" }, /already exists/],
		[{ action: "view", entryId: "" }, /entryId.*non-empty/],
		[{ action: "view", sessionFile: "/tmp/session.jsonl" }, /sessionFile.*entryId/],
		[{ action: "view", entryId: "missing", scope: "branch" }, /No entry matches/],
		[{ action: "view", entryId: "entry-", scope: "branch" }, /ambiguous/],
		[{ action: "view", entryId: entry.id, scope: "branch", offset: 10 }, /beyond end of entry/],
		[{ action: "search" }, /query.*start.*end.*required/],
		[{ action: "search", query: "|" }, /must contain a search term/],
		[{ action: "search", start: "not-a-date" }, /not a valid timestamp/],
		[{ action: "search", start: "2026-02-01", end: "2026-01-01" }, /start.*before.*end/],
	]) {
		await assert.rejects(
			() => tools.tape.execute("failure", params, undefined, undefined, ctx),
			pattern,
		);
	}

	const underscoreAnchor = await tools.tape.execute(
		"underscore-anchor",
		{ action: "anchor", name: "valid_name/nested_value", summary: "summary" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(underscoreAnchor.details.tapeAnchor.name, "valid_name/nested_value");

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => tools.tape.execute("cancelled", { action: "search", query: "body", scope: "all" }, controller.signal, undefined, ctx),
		/Tape operation cancelled/,
	);

	const emptySearch = await tools.tape.execute("empty-search", { action: "search", query: "missing", scope: "branch" }, undefined, undefined, ctx);
	assert.equal(emptySearch.content[0].text, "No entries found.");
	const emptyView = await tools.tape.execute("empty-view", { action: "view", scope: "branch", offset: 10 }, undefined, undefined, makeCtx({ cwd: "/empty" }));
	assert.equal(emptyView.content[0].text, "No records found.");
	assert.deepEqual(emptyView.details, { total: 0, shown: 0, offset: 10, limit: 20, scope: "branch" });

	const anchorView = await tools.tape.execute("anchor-view", { action: "view", entryId: existing.id, scope: "branch" }, undefined, undefined, ctx);
	assert.match(anchorView.content[0].text, /^entryId=anchor-0 type=anchor name=existing time=/);
	const multiline = { ...entry, id: "multiline-entry", message: textMessage("user", "one\ntwo\nthree") };
	const pagedView = await tools.tape.execute(
		"paged-view",
		{ action: "view", entryId: multiline.id, scope: "branch", limit: 2 },
		undefined,
		undefined,
		makeCtx({ cwd: "/work", branch: [multiline] }),
	);
	assert.match(pagedView.content[0].text, /\[Showing lines 1-2 of 3\. Use offset=3 to continue\.\]/);
	assert.equal(pagedView.details.totalLines, 3);
	assert.equal(pagedView.details.shownLines, 2);
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
	assert.match(firstSearch.content[0].text, /^search results \(1\/3\)\n\n- entryId=entry-2 kind=message role=user time=/);
	assert.match(firstSearch.content[0].text, /\[2 more results\. Use offset=1 to continue\.\]/);
	const lastSearch = await tools.tape.execute("search-2", { action: "search", query: "needle", scope: "branch", limit: 1, offset: 2 }, undefined, undefined, searchCtx);
	assert.doesNotMatch(lastSearch.content[0].text, /more results/);
	assert.match(lastSearch.content[0].text, /preview: "needle 0"$/);
	const pastSearch = await tools.tape.execute("search-3", { action: "search", query: "needle", scope: "branch", limit: 1, offset: 3 }, undefined, undefined, searchCtx);
	assert.equal(pastSearch.content[0].text, "No entries at offset 3 (total 3).");
	const zeroSearch = await tools.tape.execute("search-0", { action: "search", query: "needle", scope: "branch", limit: 0 }, undefined, undefined, searchCtx);
	assert.equal(zeroSearch.details.limit, 1);
	assert.equal(zeroSearch.details.results.length, 1);
	assert.match(zeroSearch.content[0].text, /Use offset=1 to continue/);

	const viewCtx = makeCtx({ cwd: "/work", branch: anchors });
	const firstView = await tools.tape.execute("view-1", { action: "view", scope: "branch", limit: 1 }, undefined, undefined, viewCtx);
	assert.match(firstView.content[0].text, /^records \(1\/3\)/);
	assert.match(firstView.content[0].text, /name=anchor-2 entryId=anchor-2 time=.* session=current/);
	assert.match(firstView.content[0].text, /summary 2…/);
	assert.match(firstView.content[0].text, /\[2 more records\. Use offset=1 to continue\.\]/);
	assert.deepEqual(Object.keys(firstView.details).sort(), ["limit", "offset", "scope", "shown", "total"]);
	assert.equal(firstView.details.scope, "branch");
	const zeroView = await tools.tape.execute("view-0", { action: "view", scope: "branch", limit: 0 }, undefined, undefined, viewCtx);
	assert.equal(zeroView.details.limit, 1);
	assert.equal(zeroView.details.shown, 1);
	assert.match(zeroView.content[0].text, /Use offset=1 to continue/);
	const pastView = await tools.tape.execute("view-past", { action: "view", scope: "branch", offset: 3 }, undefined, undefined, viewCtx);
	assert.equal(pastView.content[0].text, "No records at offset 3 (total 3).");
	assert.equal(pastView.details.shown, 0);

	const zeroEntryView = await tools.tape.execute("entry-view-0", { action: "view", entryId: entries[0].id, scope: "branch", limit: 0 }, undefined, undefined, searchCtx);
	assert.equal(zeroEntryView.details.limit, 1);
	assert.equal(zeroEntryView.details.offset, 1);
	assert.equal(zeroEntryView.details.totalLines, 1);
	assert.equal(zeroEntryView.details.shownLines, 1);
});

test("info reports the effective boundary and structured status", async () => {
	const { tools } = await loadTape();
	const anchor = anchorEntry({
		id: "anchor-info-0001",
		name: "latest",
		summary: "summary that already lives in tapeAnchor",
		cwd: "/work",
		createdAt: "2026-07-27T00:00:00.000Z",
	});
	const active = await tools.tape.execute(
		"info-anchor",
		{ action: "info" },
		undefined,
		undefined,
		makeCtx({ cwd: "/work", branch: [anchor], entries: [anchor] }),
	);
	assert.match(active.content[0].text, /active boundary: latest \[anchor-i\]/);
	assert.deepEqual(Object.keys(active.details.boundary).sort(), ["entryId", "kind", "name", "timestamp"]);
	assert.equal(active.details.boundary.kind, "anchor");
	assert.equal(active.details.entriesAfterBoundary, 0);

	const compact = {
		type: "compaction",
		id: "compact-info-0001",
		timestamp: "2026-07-27T00:01:00.000Z",
		summary: "compacted state",
	};
	const after = {
		type: "message",
		id: "after-info-0001",
		timestamp: "2026-07-27T00:02:00.000Z",
		message: textMessage("user", "after boundary"),
	};
	const compacted = await tools.tape.execute(
		"info-compact",
		{ action: "info" },
		undefined,
		undefined,
		makeCtx({ cwd: "/work", branch: [anchor, compact, after], entries: [anchor, compact, after] }),
	);
	assert.match(compacted.content[0].text, /active boundary: compact\/20260727-000100 \[compact-\]/);
	assert.equal(compacted.details.boundary.kind, "compact");
	assert.equal(compacted.details.entriesAfterBoundary, 1);
});


test("entry view follows automatic line and byte continuations without losing content", async () => {
	const { tools } = await loadTape();
	for (const lines of [
		Array.from({ length: 3000 }, (_, i) => "line " + i),
		Array.from({ length: 100 }, (_, i) => i + "中".repeat(500)),
		Array.from({ length: 3000 }, (_, i) => i % 2 ? "line " + i : "").concat(""),
	]) {
		const entry = { type: "message", id: "paged-entry", timestamp: "2026-07-27T00:00:00.000Z", message: textMessage("user", lines.join("\n")) };
		const ctx = makeCtx({ cwd: "/work", branch: [entry] });
		let offset = 1;
		const seen = [];
		while (true) {
			const result = await tools.tape.execute("view", { action: "view", entryId: entry.id, scope: "branch", offset }, undefined, undefined, ctx);
			assert.equal(result.details.fullOutputPath, undefined);
			const text = assertBounded(result);
			const continuation = text.match(/Use offset=(\d+) to continue/);
			const body = text.slice(text.indexOf("\n\n") + 2).split("\n\n[Showing lines ")[0];
			seen.push(...body.split("\n"));
			assert.equal(result.details.shownLines, body.split("\n").length);
			if (!continuation) break;
			const collapsed = tools.tape.renderResult(result, { expanded: false }, { fg: (_color, value) => value }, { args: { action: "view", entryId: entry.id }, isError: false }).render(1000).join("\n");
			assert.ok(collapsed.includes(continuation[0]));
			assert.ok(Number(continuation[1]) > offset);
			offset = Number(continuation[1]);
		}
		assert.deepEqual(seen, lines);
	}
});
