// Shared test harness: loads the real extension (node strips types natively)
// with a mocked ExtensionAPI and an isolated PI_CODING_AGENT_DIR.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

/** Create an isolated agent dir and point the extension at it. */
export function makeAgentDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tape-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

export async function loadTapeModule() {
	return jiti.import("../extensions/index.ts");
}

/** Load the extension with a mocked ExtensionAPI; returns registered surface. */
export async function loadTape() {
	const factory = (await loadTapeModule()).default;
	const tools = {};
	const handlers = {};
	factory({
		registerTool: (tool) => { tools[tool.name] = tool; },
		on: (event, handler) => { handlers[event] = handler; },
	});
	return { tools, handlers };
}

export function makeCtx({ cwd, sessionFile, sessionDir = sessionFile ? path.dirname(sessionFile) : undefined, sessionId = sessionFile ?? "ephemeral-session", branch = [], entries = branch }) {
	return {
		cwd,
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => entries,
			getSessionDir: () => sessionDir,
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getLeafId: () => undefined,
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 1000000 }),
	};
}

export function textMessage(role, text, timestamp = Date.now()) {
	return { role, content: [{ type: "text", text }], timestamp };
}

export function anchorMessage({ name, summary, cwd, createdAt, keepRecentTokens = 20000 }) {
	return {
		role: "toolResult",
		toolName: "tape",
		content: [{ type: "text", text: `[Anchor: ${name}]\n${summary}` }],
		timestamp: Date.parse(createdAt),
		details: { tapeAnchor: { version: 1, name, summary, keepRecentTokens, createdAt, source: { cwd } } },
	};
}

export function anchorEntry({ id, ...anchor }) {
	return { type: "message", id, timestamp: anchor.createdAt, message: anchorMessage(anchor) };
}

/** Write a session .jsonl fixture; returns its path. */
export function writeSession(agentDir, subdir, fileName, cwd, entries) {
	const dir = path.join(agentDir, "sessions", subdir);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, fileName);
	fs.writeFileSync(file, [JSON.stringify({ type: "session", cwd }), ...entries.map((e) => JSON.stringify(e))].join("\n"));
	return file;
}
