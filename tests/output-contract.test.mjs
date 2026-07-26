import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { anchorEntry, loadTape, makeCtx, textMessage } from "./harness.mjs";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

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
	assert.equal("payload" in result.details.results[0], false);
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
		assert.ok(result.details.fullOutputPath);
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
	assert.ok(fs.readFileSync(result.details.fullOutputPath, "utf8").length > MAX_BYTES);
	fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
});

test("temp-file failure keeps a successful bounded result", async () => {
	const { tools } = await loadTape();
	const ctx = makeCtx({ cwd: "/work" });
	const originalTmpdir = process.env.TMPDIR;
	try {
		process.env.TMPDIR = path.join(os.tmpdir(), `pi-tape-missing-${Date.now()}`, "nested");
		const result = await tools.tape.execute(
			"anchor",
			{ action: "anchor", name: "unsaved", summary: "x".repeat(60 * 1024) },
			undefined,
			undefined,
			ctx,
		);
		const text = assertBounded(result);
		assert.match(text, /could not be saved/);
		assert.equal(result.details.fullOutputPath, undefined);
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
	}
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
