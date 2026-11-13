import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { keyText } from "@earendil-works/pi-coding-agent";
import { loadTape, makeCtx, textMessage } from "./harness.mjs";

const { tools } = await loadTape();
const context = args => ({ args, isError: false });
const plainTheme = { bold: text => text, fg: (_color, text) => text };
const output = (result, args, expanded = false, theme = plainTheme, width = 1000) => tools.tape.renderResult(result, { expanded, isPartial: false }, theme, context(args)).render(width).map(line => line.trimEnd()).join("\n");
const records = (count, sessionFile = false) => Array.from({ length: count }, (_, i) => `id${i + 1}  user  2026-08-01 00:00\n  result ${i + 1}${sessionFile ? `\n  sessionFile: /tmp/session-${i + 1}.jsonl` : ""}`);
const listResult = (rows, total = rows.length, extra = "") => ({ content: [{ type: "text", text: rows.join("\n\n") + extra }], details: { results: rows.map((_, i) => ({ entryId: `id${i + 1}` })), total, offset: 0 } });
const entry = (id, body, parentId = null) => ({ type: "message", id, parentId, timestamp: "2026-08-01T00:00:00Z", message: textMessage("user", body) });
const view = (e, extra = {}) => tools.tape.execute("view", { action: "view", entryId: e.id, ...extra }, undefined, undefined, makeCtx({ cwd: "/work", branch: [e] }));

test("tool calls retain every argument, style only the name bold, and add a ready newline", () => {
	const styles = [];
	const theme = { bold: text => `<b>${text}</b>`, fg: (color, text) => { styles.push([color, text]); return text; } };
	const args = { action: "search", query: "alpha beta " + "中".repeat(300), kinds: ["message", "tool_call"], scope: "cwd", start: "2026-08-01", limit: 10, offset: 20, unused: undefined };
	const expected = `<b>tape</b>(${Object.entries(args).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")})`;
	for (const isPartial of [true, false]) {
		styles.length = 0;
		const component = tools.tape.renderCall(args, theme, { ...context(args), isPartial });
		assert.deepEqual(component.render(10000).map(line => line.trimEnd()), isPartial ? [expected] : [expected, ""]);
		assert.deepEqual(styles.filter(([color]) => color === "toolTitle"), [["toolTitle", "<b>tape</b>"]]);
		assert.ok(styles.every(([color]) => color === "toolTitle" || color === "text"));
	}
	const viewArgs = { action: "view", entryId: "a".repeat(200), sessionFile: "/" + "b".repeat(300), around: 20, offset: 2, limit: 10 };
	const rendered = tools.tape.renderCall(viewArgs, plainTheme, { ...context(viewArgs), isPartial: false }).render(10000).join("\n");
	assert.ok(rendered.includes(viewArgs.entryId) && rendered.includes(viewArgs.sessionFile));
});

test("search folds after five complete entries and retains navigation", () => {
	const rows = records(6);
	const navigation = "[14 more results. Use offset=6 to continue.]";
	const response = listResult(rows, 20, `\n\n${navigation}`);
	const args = { action: "search" };
	const collapsed = output(response, args);
	assert.match(collapsed, /^id1  user/);
	assert.match(collapsed, /id5  user/);
	assert.doesNotMatch(collapsed, /id6  user/);
	assert.match(collapsed, /\.\.\. \(2 more lines, .*to expand\)/);
	assert.ok(collapsed.endsWith(navigation));
	assert.equal(output(response, args, true), response.content[0].text);
	assert.equal(output(listResult(rows.slice(0, 5)), args), rows.slice(0, 5).join("\n\n"));
});

test("renderer prefers the injected keyText method when available", () => {
	const calls = [];
	const response = listResult(records(6));
	const rendererContext = { ...context({ action: "search" }), keyText(key) { calls.push(key); return "custom-expand-key"; } };
	const rendered = tools.tape.renderResult(response, { expanded: false }, plainTheme, rendererContext).render(1000).join("\n");
	assert.deepEqual(calls, ["app.tools.expand"]);
	assert.match(rendered, /custom-expand-key to expand/);
});

test("renderer falls back to public keyText when the context has no method", () => {
	const rendererContext = context({ action: "search" });
	assert.equal("keyText" in rendererContext, false);
	const rendered = tools.tape.renderResult(listResult(records(6)), { expanded: false }, plainTheme, rendererContext).render(1000).join("\n");
	assert.ok(rendered.includes(`2 more lines, ${keyText("app.tools.expand")} to expand`));
});

test("cross-session search keeps each sessionFile with its entry", () => {
	const response = listResult(records(6, true));
	const collapsed = output(response, { action: "search", scope: "all" });
	assert.match(collapsed, /sessionFile: \/tmp\/session-5.jsonl/);
	assert.doesNotMatch(collapsed, /session-6.jsonl/);
	assert.match(collapsed, /3 more lines/);
	assert.equal(output(response, { action: "search" }, true), response.content[0].text);
});

test("entry view folds after fifteen body lines and counts wrapped hidden lines", async () => {
	const e = entry("abcdefgh", Array.from({ length: 16 }, (_, i) => `line ${i + 1}`).join("\n"));
	const response = await view(e);
	const args = { action: "view", entryId: e.id };
	const collapsed = output(response, args);
	assert.match(collapsed, /^abcdefgh  user  2026-08-01 00:00\n/);
	assert.match(collapsed, /line 15/);
	assert.doesNotMatch(collapsed, /line 16/);
	assert.match(collapsed, /1 more lines, .*to expand/);
	assert.equal(output(response, args, true), response.content[0].text);
	const wrapped = await view(entry("wrapped", Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).concat("x".repeat(120)).join("\n")));
	assert.match(output(wrapped, args, false, plainTheme, 60), /2 more lines/);
	assert.match(output(wrapped, args, false, plainTheme, 120), /1 more lines/);
	const short = await view(entry("short", e.message.content[0].text.split("\n").slice(0, 15).join("\n")));
	assert.equal(output(short, args), short.content[0].text);
});

test("a trailing blank body line still counts toward entry folding", async () => {
	const response = await view(entry("blank-tail", Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).concat("").join("\n")));
	assert.match(output(response, { action: "view", entryId: "blank-tail" }), /1 more lines/);
	assert.equal(output(response, { action: "view", entryId: "blank-tail" }, true), response.content[0].text);
});

test("compact and successful empty results are rendered unchanged; errors use error style", () => {
	for (const text of ["Compacting the context after this turn.", "No matching entries."]) {
		assert.equal(output({ content: [{ type: "text", text }], details: {} }, { action: "compact" }), text);
	}
	const styles = [];
	const result = { content: [{ type: "text", text: "Nothing to compact." }], details: {} };
	const component = tools.tape.renderResult(result, { expanded: false }, { fg: (color, text) => { styles.push([color, text]); return text; } }, { ...context({ action: "compact" }), isError: true });
	assert.equal(component.render(1000).map(line => line.trimEnd()).join("\n"), "Nothing to compact.");
	assert.deepEqual(styles, [["error", "Nothing to compact."]]);
});

test("historical marker text stays body text while generated pagination stays visible", async () => {
	for (const marker of ["[Showing example]", "[Line example]", "[Output truncated: example]"]) {
		const e = entry("history", `first\n\n${marker}\n` + Array.from({ length: 100 }, (_, i) => `historical ${i}`).join("\n"));
		for (const limit of [undefined, 20]) {
			const args = { action: "view", entryId: e.id, limit };
			const response = await view(e, { limit });
			for (const expanded of [false, true]) {
				const styles = [];
				const theme = { fg: (color, text) => { styles.push([color, text]); return text; } };
				const rendered = output(response, args, expanded, theme);
				assert.ok(styles.some(([color, text]) => color === "toolOutput" && text.includes(marker)));
				assert.equal(styles.some(([color, text]) => color !== "toolOutput" && text.includes(marker)), false);
				if (!expanded) assert.doesNotMatch(rendered, /historical 99|historical 16/);
				if (limit) {
					assert.match(rendered, /Use offset=21 to continue/);
					assert.ok(styles.some(([color, text]) => color === "dim" && text.includes("Use offset=21")));
				} else assert.doesNotMatch(rendered, /Use offset=/);
			}
		}
	}
});

test("automatic entry truncation highlights only its generated notice", async () => {
	const e = entry("byte-page", "[Showing example]\n\n[Line example]\n" + Array.from({ length: 100 }, (_, i) => `${i} ${"中".repeat(500)}`).join("\n"));
	const response = await view(e);
	assert.equal(response.details.truncation.truncatedBy, "bytes");
	for (const expanded of [false, true]) {
		const styles = [];
		const theme = { fg: (color, text) => { styles.push([color, text]); return text; } };
		const rendered = output(response, { action: "view", entryId: e.id }, expanded, theme);
		assert.ok(rendered.includes(`Use offset=${response.details.shownLines + 1}`));
		assert.ok(styles.some(([color, text]) => color === "warning" && text.includes("Use offset=")));
		assert.equal(styles.some(([color, text]) => color !== "toolOutput" && text.includes("[Showing example]")), false);
	}
});

test("only the long-line warning is highlighted, not the page-file continuation", async () => {
	const e = entry("longline", "x".repeat(60 * 1024) + "\ntail");
	const args = { action: "view", entryId: e.id, limit: 1 };
	const response = await view(e, { limit: 1 });
	try {
		for (const expanded of [false, true]) {
			const styles = [];
			const theme = { fg: (color, text) => { styles.push([color, text]); return text; } };
			const rendered = output(response, args, expanded, theme);
			assert.ok(rendered.includes(response.details.fullOutputPath));
			assert.match(rendered, /Read the full page file before continuing/);
			assert.match(rendered, /Use offset=2 to continue/);
			assert.ok(styles.some(([color, text]) => color === "warning" && text.includes(response.details.fullOutputPath)));
			assert.equal(styles.some(([color, text]) => color === "warning" && text.includes("Use offset=")), false);
			assert.ok(styles.some(([color, text]) => color === "dim" && text.includes("Use offset=")));
		}
	} finally {
		fs.rmSync(path.dirname(response.details.fullOutputPath), { recursive: true });
	}
});

test("integrated search excludes current context and keeps historical previews and navigation", async () => {
	const historic = Array.from({ length: 8 }, (_, i) => entry(`historical-${i}`, "[Showing example]\n[Line example]"));
	const live = entry("live", "example still in context");
	const args = { action: "search", query: "example", limit: 6 };
	const response = await tools.tape.execute("search", args, undefined, undefined, makeCtx({ cwd: "/work", branch: [live], entries: [...historic, live] }));
	assert.equal(response.details.total, 8);
	assert.equal(response.details.results.some(item => item.entryId === live.id), false);
	for (const expanded of [false, true]) {
		const styles = [];
		const theme = { fg: (color, text) => { styles.push([color, text]); return text; } };
		const rendered = output(response, args, expanded, theme);
		assert.match(rendered, /Use offset=6 to continue/);
		assert.ok(styles.some(([color, text]) => color === "dim" && text.includes("Use offset=6")));
		assert.equal(styles.some(([color, text]) => color !== "toolOutput" && text.includes("[Showing example]")), false);
		assert.ok(styles.some(([color, text]) => color === "toolOutput" && text.includes("[Showing example]")));
	}
});

test("integrated search leaves compactions searchable even in the current projection", async () => {
	const summary = { type: "compaction", id: "summary", parentId: null, timestamp: "2026-08-01T00:00:00Z", summary: "historical marker", firstKeptEntryId: "summary", tokensBefore: 1 };
	const live = entry("live", "marker still in context", summary.id);
	const args = { action: "search", query: "marker", kinds: ["message", "compaction"] };
	const response = await tools.tape.execute("search", args, undefined, undefined, makeCtx({ cwd: "/work", branch: [summary, live] }));
	assert.deepEqual(response.details.results.map(item => item.entryId), [summary.id]);
	assert.equal(output(response, args), "summary  compaction  2026-08-01 00:00\n  historical marker");
});
