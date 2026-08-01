import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTape } from "./harness.mjs";

const { tools } = await loadTape();

test("tool call renders every argument in function-call form", () => {
	const styles = [];
	const theme = {
		bold: (text) => `<b>${text}</b>`,
		fg: (color, text) => { styles.push([color, text]); return text; },
	};
	const args = { action: "search", query: "alpha beta", scope: "cwd", limit: 10 };
	const expected = '<b>tape</b>(action="search", query="alpha beta", scope="cwd", limit=10)';
	const pending = tools.tape.renderCall(args, theme, { expanded: false, isPartial: true });
	assert.deepEqual(pending.render(1000).map((line) => line.trimEnd()), [expected]);
	const completed = tools.tape.renderCall(args, theme, { expanded: false, isPartial: false });
	assert.deepEqual(completed.render(1000).map((line) => line.trimEnd()), [expected, ""]);
	assert.equal(styles[0][0], "toolTitle");
	assert.ok(styles.filter(([color]) => color === "text").length > Object.keys(args).length);
	assert.equal(styles.some(([color]) => color === "muted"), false);
	assert.equal(styles.some(([color]) => color === "accent"), false);
});

test("search results collapse after five complete entries", () => {
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const records = Array.from({ length: 6 }, (_, index) =>
		`- entryId=id${index + 1} kind=message role=user time=2026-08-01 00:00:0${index + 1}\n  preview: "result ${index + 1}"`,
	);
	const content = `search results (6/20)\n\n${records.join("\n\n")}\n\n[14 more results. Use offset=6 to continue.]`;
	const result = { content: [{ type: "text", text: content }], details: {} };
	const context = { args: { action: "search" }, isError: false };

	const collapsed = tools.tape.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /^search results \(6\/20\)/);
	assert.match(collapsed, /entryId=id5/);
	assert.doesNotMatch(collapsed, /entryId=id6/);
	assert.match(collapsed, /\.\.\. \(1 result hidden, .*to expand\)$/);
	assert.doesNotMatch(collapsed, /Use offset=/);

	const expanded = tools.tape.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);

	const empty = tools.tape.renderResult(
		{ content: [{ type: "text", text: "No entries found." }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(empty, "No entries found.");
});

test("record lists collapse after five complete records", () => {
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const records = Array.from({ length: 6 }, (_, index) =>
		`- name=anchor-${index + 1} entryId=id${index + 1} time=2026-08-01 00:00:0${index + 1} session=current\n  summary: "summary ${index + 1}"`,
	);
	const content = `records (6/20)\n\n${records.join("\n\n")}\n\n[14 more records. Use offset=6 to continue.]`;
	const result = { content: [{ type: "text", text: content }], details: {} };
	const context = { args: { action: "view" }, isError: false };

	const collapsed = tools.tape.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /name=anchor-5/);
	assert.doesNotMatch(collapsed, /name=anchor-6/);
	assert.match(collapsed, /\.\.\. \(1 record hidden, .*to expand\)$/);
	assert.doesNotMatch(collapsed, /Use offset=/);

	const fiveRecords = `records (5/5)\n\n${records.slice(0, 5).join("\n\n")}`;
	const notCollapsed = tools.tape.renderResult(
		{ content: [{ type: "text", text: fiveRecords }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(notCollapsed, fiveRecords);
});

test("entry views collapse after fifteen body lines", () => {
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const body = Array.from({ length: 16 }, (_, index) => `line ${index + 1}`).join("\n");
	const content = `entryId=abcdefgh type=message role=user time=2026-08-01 00:00:00\n\n${body}`;
	const result = { content: [{ type: "text", text: content }], details: { shownLines: 16 } };
	const context = { args: { action: "view", entryId: "abcdefgh" }, isError: false };

	const collapsed = tools.tape.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /^entryId=abcdefgh/);
	assert.match(collapsed, /line 15/);
	assert.doesNotMatch(collapsed, /line 16/);
	assert.match(collapsed, /\.\.\. \(1 entry line hidden, .*to expand\)$/);

	const expanded = tools.tape.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);

	const fifteenLines = body.split("\n").slice(0, 15).join("\n");
	const shortContent = `entryId=abcdefgh type=message role=user time=2026-08-01 00:00:00\n\n${fifteenLines}`;
	const notCollapsed = tools.tape.renderResult(
		{ content: [{ type: "text", text: shortContent }], details: { shownLines: 15 } },
		{ expanded: false, isPartial: false },
		theme,
		context,
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(notCollapsed, shortContent);
});

test("anchor results collapse after fifteen summary lines", () => {
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const summary = Array.from({ length: 16 }, (_, index) => `summary line ${index + 1}`).join("\n");
	const content = `Anchor created: checkpoint\n${summary}\n\nrecent anchors (this branch): prior`;
	const result = { content: [{ type: "text", text: content }], details: { tapeAnchor: { summary } } };
	const context = { args: { action: "anchor", name: "checkpoint" }, isError: false };

	const collapsed = tools.tape.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /^Anchor created: checkpoint/);
	assert.match(collapsed, /summary line 15/);
	assert.doesNotMatch(collapsed, /summary line 16/);
	assert.doesNotMatch(collapsed, /recent anchors/);
	assert.match(collapsed, /\.\.\. \(1 summary line hidden, .*to expand\)$/);

	const expanded = tools.tape.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);
});

test("anchor summary is shortened only when a successful result repeats it", () => {
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const summary = "H".repeat(150) + "T".repeat(150);
	const args = { action: "anchor", name: "n1", summary };
	const pending = tools.tape.renderCall(args, theme, { expanded: false, isPartial: true, isError: false });
	assert.ok(pending.render(10000)[0].includes("T".repeat(150)));

	const failed = tools.tape.renderCall(args, theme, { expanded: false, isPartial: false, isError: true });
	assert.ok(failed.render(10000)[0].includes("T".repeat(150)));

	const completed = tools.tape.renderCall(args, theme, {
		expanded: false,
		isPartial: false,
		isError: false,
		lastComponent: failed,
	});
	assert.equal(completed, failed);
	const line = completed.render(10000)[0];
	assert.ok(line.includes('action="anchor"'));
	assert.ok(line.includes("H".repeat(80) + "…"));
	assert.equal(line.includes("H".repeat(81)), false);
	assert.equal(line.includes("T"), false);
	assert.ok(line.trimEnd().endsWith(')'));

	const short = tools.tape.renderCall({ action: "anchor", summary: "brief" }, theme, { expanded: false, isPartial: false, isError: false });
	assert.ok(short.render(10000)[0].includes('summary="brief"'));
});
