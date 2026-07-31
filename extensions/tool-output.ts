import type { AgentToolResult, ToolDefinition, TruncationResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "typebox";

async function boundText(value: string): Promise<{
	text: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}> {
	const full = truncateHead(value, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!full.truncated) return { text: value };

	const directory = await mkdtemp(join(tmpdir(), "pi-tape-"));
	const fullOutputPath = join(directory, "output.txt");
	await writeFile(fullOutputPath, value, "utf8");

	const notice = `[Output truncated: ${full.totalLines} lines, ${formatSize(full.totalBytes)} total.` +
		` Full output: ${fullOutputPath}]`;
	const suffix = `\n\n${notice}`;
	const budget = DEFAULT_MAX_BYTES - Buffer.byteLength(suffix);
	const truncation = truncateHead(value, { maxBytes: budget, maxLines: DEFAULT_MAX_LINES - 2 });
	return {
		text: truncation.content ? truncation.content + suffix : notice,
		truncation,
		fullOutputPath,
	};
}

async function boundResult<TDetails>(result: AgentToolResult<TDetails>): Promise<AgentToolResult<TDetails>> {
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const bounded = await boundText(text);
	if (!bounded.truncation) return result;

	const nonText = result.content.filter((part) => part.type !== "text");
	const details = result.details && typeof result.details === "object"
		? result.details as Record<string, unknown>
		: {};
	return {
		...result,
		content: [{ type: "text", text: bounded.text }, ...nonText],
		details: {
			...details,
			truncation: bounded.truncation,
			fullOutputPath: bounded.fullOutputPath,
		} as TDetails,
	};
}

export function withToolOutputContract<TParams extends TSchema, TDetails, TState>(
	definition: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	const execute = definition.execute.bind(definition);
	return {
		...definition,
		async execute(id, params, signal, onUpdate, ctx) {
			return boundResult(await execute(id, params, signal, onUpdate, ctx));
		},
	};
}
