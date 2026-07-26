import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
	truncated: boolean;
	fullOutputPath?: string;
}> {
	const full = truncateHead(value, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!full.truncated) return { text: value, truncated: false };

	let fullOutputPath: string | undefined;
	try {
		const directory = await mkdtemp(join(tmpdir(), "pi-tape-"));
		fullOutputPath = join(directory, "output.txt");
		await writeFile(fullOutputPath, value, "utf8");
	} catch {
		fullOutputPath = undefined;
	}

	const notice = fullOutputPath
		? `\n\n[Output truncated: ${formatSize(full.totalBytes)}, ${full.totalLines} lines total.` +
			` Full output: ${fullOutputPath}. This is a temporary file; copy or move it if it should persist.]`
		: `\n\n[Output truncated: ${formatSize(full.totalBytes)}, ${full.totalLines} lines total.` +
			" Full output could not be saved to a temporary file; rerun or narrow the request if safe.]";
	const budget = DEFAULT_MAX_BYTES - Buffer.byteLength(notice);
	const preview = truncateHead(value, { maxBytes: budget, maxLines: DEFAULT_MAX_LINES - 2 });
	let content = preview.content;
	if (!content && budget > 0) content = utf8Prefix(value.split("\n")[0] ?? "", budget);
	return { text: content + notice, truncated: true, fullOutputPath };
}

async function boundResult<TDetails>(result: AgentToolResult<TDetails>): Promise<AgentToolResult<TDetails>> {
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const bounded = await boundText(text);
	if (!bounded.truncated) return result;

	const nonText = result.content.filter((part) => part.type !== "text");
	const details = result.details && typeof result.details === "object"
		? result.details as Record<string, unknown>
		: {};
	return {
		...result,
		content: [{ type: "text", text: bounded.text }, ...nonText],
		details: {
			...details,
			truncated: true,
			...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
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
