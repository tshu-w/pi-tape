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

test("anchor summary is truncated to a prefix in the call line", () => {
	const theme = { bold: (text) => text, fg: (_color, text) => text };
	const summary = "H".repeat(150) + "T".repeat(150);
	const component = tools.tape.renderCall({ action: "anchor", name: "n1", summary }, theme, { expanded: false });
	const line = component.render(10000)[0];
	assert.ok(line.includes('action="anchor"'));
	assert.ok(line.includes("H".repeat(80) + "…"));
	assert.equal(line.includes("H".repeat(81)), false);
	assert.equal(line.includes("T"), false);
	assert.ok(line.trimEnd().endsWith(')'));

	const short = tools.tape.renderCall({ action: "anchor", summary: "brief" }, theme, { expanded: false });
	assert.ok(short.render(10000)[0].includes('summary="brief"'));
});
