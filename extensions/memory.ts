import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSessionProjection, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "tape-memory";
const MAX_LINES = 100;
const MAX_BYTES = 10 * 1024;
const CUT_NOTICE = "[MEMORY.md is cut at 100 lines/10KB; the rest is not loaded. Move details to other files.]";
const INSTRUCTIONS = [
	"Memory from past sessions: what you learned and should know without searching for it, such as the user's preferences and corrections, lasting facts and decisions, and where things live. It is shared by sessions in every project and on every machine.",
	"Read a file in the memory directory when its index line matches the task. Update memory when you learn something worth keeping.",
	"AGENTS.md takes precedence over memory.",
].join("\n");

interface Snapshot {
	boundary: string | null;
	kind: "base" | "update";
	role?: "system" | "user";
	section: string;
	timestamp: number;
}

function indexPath(): string {
	return path.join(getAgentDir(), "tape", "memory", "MEMORY.md");
}

function readIndex(): { section: string; lines: number; bytes: number } {
	let content: string;
	try {
		content = fs.readFileSync(indexPath(), "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		content = "";
	}
	const lines = content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0;
	const bytes = Buffer.byteLength(content, "utf-8");
	let retained = "";
	let retainedBytes = 0;
	for (const line of (content.match(/[^\n]*\n|[^\n]+$/g) ?? []).slice(0, MAX_LINES)) {
		const nextBytes = retainedBytes + Buffer.byteLength(line, "utf-8");
		if (nextBytes > MAX_BYTES) break;
		retained += line;
		retainedBytes = nextBytes;
	}
	if (lines > MAX_LINES || bytes > MAX_BYTES) retained = `${retained}\n${CUT_NOTICE}`;
	return {
		section: `${INSTRUCTIONS}\n\n<memory path="${path.dirname(indexPath())}">\n${retained}\n</memory>`,
		lines, bytes,
	};
}

function snapshot(entry: any): Snapshot | undefined {
	return entry.type === "custom" && entry.customType === ENTRY_TYPE ? entry.data : undefined;
}

function patch(data: Snapshot): any {
	return data.role === "user"
		? { role: "user", content: data.section, timestamp: data.timestamp }
		: { role: "system", content: "", sections: { memory: data.section }, timestamp: data.timestamp };
}

/** Persist placement, not model messages: replay updates at their original branch positions. */
export function createMemory(pi: ExtensionAPI) {
	function state(ctx: any) {
		const branch = ctx.sessionManager.getBranch() as any[];
		const boundary = branch.findLast((entry) => entry.type === "compaction")?.id ?? null;
		const snapshots = branch.map(snapshot).filter((data): data is Snapshot => !!data && data.boundary === boundary);
		let base = snapshots.find((data) => data.kind === "base");
		if (!base) {
			// A compaction starts a new stable prefix. Before it, preserve the persisted head on reload.
			const initial = boundary === null
				? branch.find((entry) => entry.type === "message" && entry.message?.role === "system" && entry.message.sections?.memory)?.message.sections.memory
				: undefined;
			base = { boundary, kind: "base", section: initial ?? readIndex().section, timestamp: Date.now() };
			pi.appendEntry(ENTRY_TYPE, base);
		}
		return { branch, boundary, base, snapshots };
	}

	return {
		beforeAgentStart(event: any, ctx: any): void {
			event.systemPromptOptions.sections.memory = state(ctx).base.section;
		},

		context(messages: any[], ctx: any): any[] {
			if (messages.length === 0) return messages;
			const { branch, boundary, base, snapshots } = state(ctx);
			const updates = snapshots.filter((data) => data.kind === "update");
			const encoded = new Set(updates.map((data) => JSON.stringify(patch(data))));
			// Also accept an already transformed request, as compaction reconstructs it twice.
			const raw = messages.filter((message, index) => index === 0 || !encoded.has(JSON.stringify(message)));
			const result = raw.slice();
			if (result[0]?.role === "system") {
				result[0] = { ...result[0], sections: { ...result[0].sections, memory: base.section } };
			}
			const insertions: Array<{ at: number; message: any }> = [];
			let cursor = 1;
			for (const projected of buildSessionProjection(branch).entries) {
				const data = snapshot(projected.sourceEntry);
				if (data && data.boundary === boundary && data.kind === "update") {
					insertions.push({ at: cursor, message: patch(data) });
				}
				for (const message of projected.messages) {
					const encoded = JSON.stringify(message);
					const found = raw.findIndex((candidate, index) => index >= cursor && JSON.stringify(candidate) === encoded);
					if (found >= 0) cursor = found + 1;
				}
			}
			for (const insertion of insertions.reverse()) result.splice(insertion.at, 0, insertion.message);
			const current = readIndex().section;
			const latest = updates.at(-1) ?? base;
			if (current !== latest.section) {
				const update: Snapshot = {
					boundary, kind: "update", section: current,
					role: ctx.model?.compat?.supportsMidConvoSystemMessages === true ? "system" : "user",
					timestamp: Math.max(Date.now(), latest.timestamp + 1),
				};
				pi.appendEntry(ENTRY_TYPE, update);
				result.push(patch(update));
			}
			return result;
		},

		toolResult(event: any, ctx: any): { content: any[] } | undefined {
			if (event.isError || !["write", "edit"].includes(event.toolName) || typeof event.input?.path !== "string") return;
			const requested = path.resolve(ctx.cwd, event.input.path.replace(/^~(?=$|\/)/, os.homedir()));
			let target: string;
			try { target = fs.realpathSync(requested); } catch { return; }
			let index: string;
			try { index = fs.realpathSync(indexPath()); } catch { return; }
			if (target !== index) return;
			const size = readIndex();
			if (size.lines < MAX_LINES * 0.9 && size.bytes < MAX_BYTES * 0.9) return;
			const notice = `[MEMORY.md is at ${size.lines}/100 lines, ${(size.bytes / 1024).toFixed(1)}KB/10KB; lines past the cap are not loaded. Tidy the index: move details to other files.]`;
			return { content: [...event.content, { type: "text", text: notice }] };
		},
	};
}
