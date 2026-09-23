import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadTape, makeCtx, textMessage } from "./harness.mjs";

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
	const result = { content: [{ type: "text", text: content }], details: { total: 20, offset: 0, results: records } };
	const context = { args: { action: "search" }, isError: false };

	const collapsed = tools.tape.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /^search results \(6\/20\)/);
	assert.match(collapsed, /entryId=id5/);
	assert.doesNotMatch(collapsed, /entryId=id6/);
	assert.match(collapsed, /\.\.\. \(2 more lines, .*to expand\)/);
	assert.match(collapsed, /Use offset=6 to continue/);

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
	const result = { content: [{ type: "text", text: content }], details: { total: 20, offset: 0, shown: 6 } };
	const context = { args: { action: "view" }, isError: false };

	const collapsed = tools.tape.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /name=anchor-5/);
	assert.doesNotMatch(collapsed, /name=anchor-6/);
	assert.match(collapsed, /\.\.\. \(2 more lines, .*to expand\)/);
	assert.match(collapsed, /Use offset=6 to continue/);

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
	assert.match(collapsed, /\.\.\. \(1 more lines, .*to expand\)$/);

	const wrappedBody = [...body.split("\n").slice(0, 15), "x".repeat(120)].join("\n");
	const wrapped = tools.tape.renderResult(
		{ content: [{ type: "text", text: `entryId=abcdefgh\n\n${wrappedBody}` }], details: { shownLines: 16 } },
		{ expanded: false, isPartial: false }, theme, context,
	);
	assert.match(wrapped.render(60).join("\n"), /\.\.\. \(2 more lines, .*to expand\)/);
	assert.match(wrapped.render(120).join("\n"), /\.\.\. \(1 more lines, .*to expand\)/);

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
	assert.match(collapsed, /\.\.\. \(3 more lines, .*to expand\)$/);

	const expanded = tools.tape.renderResult(result, { expanded: true, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expanded, content);
});

test("hard truncation stays visible as a warning while navigation hints stay subdued", () => {
	const styles = [];
	const theme = {
		bold: (text) => text,
		fg: (color, text) => { styles.push([color, text]); return text; },
	};
	const records = Array.from({ length: 6 }, (_, index) =>
		`- entryId=id${index + 1} kind=message role=user time=2026-08-01 00:00:0${index + 1}\n  preview: "result ${index + 1}"`,
	);
	const notice = "[Output truncated: 100 lines. Full output: /tmp/tape.txt]";
	const body = `search results (6/20)\n\n${records.join("\n\n")}`;
	const navigation = "[14 more results. Use offset=6 to continue.]";
	const scope = "scope: session";
	const content = `${body}\n\n${notice}\n\n${navigation}\n\n${scope}`;
	const result = { content: [{ type: "text", text: content }], details: { truncation: { truncated: true, content: body } } };
	const context = { args: { action: "search" }, isError: false };

	const collapsed = tools.tape.renderResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsed, /\[Output truncated:/);
	assert.ok(styles.some(([color, text]) => color === "warning" && text === notice));
	assert.ok(styles.some(([color, text]) => color === "muted" && text.startsWith("... (2 more lines,")));
	assert.ok(collapsed.includes(navigation));
	assert.ok(styles.some(([color, text]) => color === "dim" && text === navigation));
	assert.ok(styles.some(([color, text]) => color === "dim" && text === scope));
	assert.equal(styles.some(([color, text]) => color === "warning" && (text.includes(navigation) || text.includes(scope))), false);

	styles.length = 0;
	const omittedSummary = Array.from({ length: 20 }, (_, index) => `omitted summary ${index + 1}`).join("\n");
	const noticeOnly = tools.tape.renderResult(
		{ content: [{ type: "text", text: notice }], details: { truncation: { truncated: true, content: "" }, tapeAnchor: { summary: omittedSummary } } },
		{ expanded: false, isPartial: false },
		theme,
		{ args: { action: "anchor" }, isError: false },
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(noticeOnly, notice);
	assert.doesNotMatch(noticeOnly, /omitted summary/);
	assert.ok(styles.some(([color, text]) => color === "warning" && text === notice));

	styles.length = 0;
	const hint = '[2 more results. Use offset=1 to continue.]';
	tools.tape.renderResult(
		{ content: [{ type: "text", text: hint }], details: {} },
		{ expanded: true, isPartial: false },
		theme,
		context,
	).render(1000);
	assert.equal(styles.some(([color]) => color === "warning"), false);
});

test("entry history markers stay in the folded body while generated pagination stays visible", async () => {
	const markers = ["[Showing example]", "[Line example]", "[Output truncated: example]"];
	for (const marker of markers) {
		const body = `first\n\n${marker}\n` + Array.from({ length: 100 }, (_, i) => `historical ${i}`).join("\n");
		const entry = { type: "message", id: "history", message: textMessage("user", body) };
		const ctx = makeCtx({ cwd: "/work", branch: [entry] });
		for (const limit of [undefined, 20]) {
			const args = { action: "view", entryId: entry.id, limit };
			const result = await tools.tape.execute("view", args, undefined, undefined, ctx);
			for (const expanded of [false, true]) {
				const styles = [];
				const theme = { fg: (color, text) => { styles.push([color, text]); return text; } };
				const rendered = tools.tape.renderResult(result, { expanded }, theme, { args }).render(1000).join("\n");
				assert.ok(styles.some(([color, text]) => color === "toolOutput" && text.includes(marker)));
				assert.equal(styles.some(([color, text]) => color !== "toolOutput" && text.includes(marker)), false);
				if (!expanded) assert.doesNotMatch(rendered, /historical 99|historical 16/);
				if (limit) {
					assert.match(rendered, /Use offset=21 to continue/);
					assert.ok(styles.some(([color, text]) => color === "dim" && text.includes("Use offset=21")));
				} else {
					assert.doesNotMatch(rendered, /Use offset=/);
				}
			}
		}
	}
});

test("automatic entry truncation highlights only the generated trailing notice", async () => {
	const body = "[Showing example]\n\n[Line example]\n" + Array.from({ length: 100 }, (_, i) => `${i} ${"中".repeat(500)}`).join("\n");
	const entry = { type: "message", id: "byte-page", message: textMessage("user", body) };
	const args = { action: "view", entryId: entry.id };
	const result = await tools.tape.execute("view", args, undefined, undefined, makeCtx({ cwd: "/work", branch: [entry] }));
	assert.equal(result.details.truncation.truncatedBy, "bytes");
	for (const expanded of [false, true]) {
		const styles = [];
		const theme = { fg: (color, text) => { styles.push([color, text]); return text; } };
		const rendered = tools.tape.renderResult(result, { expanded }, theme, { args }).render(1000).join("\n");
		assert.ok(rendered.includes(`Use offset=${result.details.shownLines + 1}`));
		assert.ok(styles.some(([color, text]) => color === "warning" && text.includes("Use offset=")));
		assert.equal(styles.some(([color, text]) => color !== "toolOutput" && text.includes("[Showing example]")), false);
	}
});

test("only the actual long-line warning is highlighted, not its continuation", async () => {
	const entry = { type: "message", id: "longline", message: textMessage("user", "x".repeat(60 * 1024) + "\ntail") };
	const args = { action: "view", entryId: entry.id, limit: 1 };
	const result = await tools.tape.execute("view", args, undefined, undefined, makeCtx({ cwd: "/work", branch: [entry] }));
	try {
		for (const expanded of [false, true]) {
			const styles = [];
			const theme = { fg: (color, text) => { styles.push([color, text]); return text; } };
			const rendered = tools.tape.renderResult(result, { expanded }, theme, { args }).render(1000).join("\n");
			assert.ok(rendered.includes(result.details.fullOutputPath));
			assert.match(rendered, /Read the full page file before continuing/);
			assert.match(rendered, /Use offset=2 to continue/);
			assert.ok(styles.some(([color, text]) => color === "warning" && text.includes(result.details.fullOutputPath)));
			assert.equal(styles.some(([color, text]) => color === "warning" && text.includes("Use offset=")), false);
			assert.ok(styles.some(([color, text]) => color === "dim" && text.includes("Use offset=")));
		}
	} finally {
		fs.rmSync(path.dirname(result.details.fullOutputPath), { recursive: true });
	}
});

test("list history markers remain body text and real navigation is visible", async () => {
	const entries = Array.from({ length: 8 }, (_, i) => ({
		type: "message", id: `entry-${i}`, message: textMessage("user", "[Showing example]\n[Line example]"),
	}));
	const args = { action: "search", query: "example", limit: 6 };
	const result = await tools.tape.execute("search", args, undefined, undefined, makeCtx({ cwd: "/work", branch: entries }));
	for (const expanded of [false, true]) {
		const styles = [];
		const theme = { fg: (color, text) => { styles.push([color, text]); return text; } };
		const rendered = tools.tape.renderResult(result, { expanded }, theme, { args }).render(1000).join("\n");
		assert.match(rendered, /Use offset=6 to continue/);
		assert.ok(styles.some(([color, text]) => color === "dim" && text.includes("Use offset=6")));
		assert.equal(styles.some(([color, text]) => color !== "toolOutput" && text.includes("[Showing example]")), false);
		assert.ok(styles.some(([color, text]) => color === "toolOutput" && text.includes("[Showing example]")));
	}
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
