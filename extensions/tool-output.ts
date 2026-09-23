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

	const summary = full.firstLineExceedsLimit
		? `Line 1 is ${formatSize(Buffer.byteLength(value.split("\n")[0]!, "utf8"))}, exceeds ${formatSize(full.maxBytes)} limit.`
		: `Showing lines 1-${full.outputLines} of ${full.totalLines}${full.truncatedBy === "bytes" ? ` (${formatSize(full.maxBytes)} limit)` : ""}.`;
	const notice = `[${summary}` +
		` Full output: ${fullOutputPath}]`;
	return {
		text: full.content ? `${full.content}\n\n${notice}` : notice,
		truncation: full,
		fullOutputPath,
	};
}

async function boundResult<TDetails>(result: AgentToolResult<TDetails>): Promise<AgentToolResult<TDetails>> {
	if ((result.details as { truncation?: TruncationResult } | undefined)?.truncation) return result;
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
