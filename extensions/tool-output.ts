import type { AgentToolResult, ToolDefinition, TruncationResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "typebox";

function utf8Prefix(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.length <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end--;
	return buffer.subarray(0, end).toString("utf8");
}

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

	const notice = `\n\n[Output truncated: ${formatSize(full.totalBytes)}, ${full.totalLines} lines total.` +
		` Full output: ${fullOutputPath}. This is a temporary file; copy or move it if it should persist.]`;
	const budget = DEFAULT_MAX_BYTES - Buffer.byteLength(notice);
	let truncation = truncateHead(value, { maxBytes: budget, maxLines: DEFAULT_MAX_LINES - 2 });
	if (truncation.firstLineExceedsLimit && budget > 0) {
		const content = utf8Prefix(value.split("\n")[0] ?? "", budget);
		truncation = {
			...truncation,
			content,
			outputLines: content ? 1 : 0,
			outputBytes: Buffer.byteLength(content),
			lastLinePartial: Boolean(content),
		};
	}
	return { text: truncation.content + notice, truncation, fullOutputPath };
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
			try {
				return await boundResult(await execute(id, params, signal, onUpdate, ctx));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const bounded = await boundText(message);
				throw new Error(bounded.text, { cause: error });
			}
		},
	};
}
