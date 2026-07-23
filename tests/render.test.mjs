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
	const component = tools.tape.renderCall(args, theme, { expanded: false });
	assert.deepEqual(component.render(1000).map((line) => line.trimEnd()), [
		'<b>tape</b>(action="search", query="alpha beta", scope="cwd", limit=10)',
		"",
	]);
	assert.equal(styles[0][0], "toolTitle");
	assert.ok(styles.filter(([color]) => color === "text").length > Object.keys(args).length);
	assert.equal(styles.some(([color]) => color === "muted"), false);
	assert.equal(styles.some(([color]) => color === "accent"), false);
});
