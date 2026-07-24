import { Text } from "@earendil-works/pi-tui";

type ToolCallTheme = {
	bold(text: string): string;
	fg(color: "toolTitle" | "text", text: string): string;
};

function renderValue(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

// Only `summary` may be shortened in the call line: the anchor result
// re-displays it in full right below, so truncation loses nothing. Other
// values stay complete because the call line is their only visible copy.
const SUMMARY_DISPLAY_LIMIT = 200;
const SUMMARY_HEAD = 120;
const SUMMARY_TAIL = 80;

function displayValue(key: string, value: unknown): unknown {
	if (key !== "summary" || typeof value !== "string") return value;
	const chars = Array.from(value);
	if (chars.length <= SUMMARY_DISPLAY_LIMIT) return value;
	return chars.slice(0, SUMMARY_HEAD).join("") + "…" + chars.slice(-SUMMARY_TAIL).join("");
}

export function renderToolCall(name: string, args: unknown, theme: ToolCallTheme): Text {
	const entries = Object.entries((args ?? {}) as Record<string, unknown>)
		.filter(([, value]) => value !== undefined);
	let text = theme.fg("toolTitle", theme.bold(name)) + theme.fg("text", "(");
	for (let index = 0; index < entries.length; index += 1) {
		const [key, value] = entries[index]!;
		if (index > 0) text += theme.fg("text", ", ");
		text += theme.fg("text", `${key}=${renderValue(displayValue(key, value))}`);
	}
	return new Text(text + theme.fg("text", ")") + "\n", 0, 0);
}
