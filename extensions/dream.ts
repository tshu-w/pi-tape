/**
 * Dream — optional periodic memory consolidation.
 *
 * An interactive session that finds a run due, at its start or when it goes
 * idle, spawns a detached `pi -p` with PI_TAPE_DREAM=1. In that process
 * pi-tape extracts the anchors and user messages recorded since the last
 * successful run, injects the dream prompt, restricts edits to the memory
 * directory, and backs up each memory file before its first edit. The first
 * interactive session that is idle after the run ends shows the result once
 * as a display-only entry.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDiffString, getAgentDir, renderDiff, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const DREAM_ENV = "PI_TAPE_DREAM";
const ENTRY_TYPE = "tape-dream";
const HOUR_MS = 60 * 60 * 1000;
/** At most one due check per process per interval, so idle checks stay cheap. */
const CHECK_INTERVAL_MS = HOUR_MS;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const RUNS_KEPT = 10;
const FORWARDED_MESSAGE = /^\s*(?:<agent-[a-z-]+[\s>]|\[(?:notification|pi-agents)\])/;
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DREAM_REQUEST = "Run the tape dream now.";

interface DreamSettings {
	enabled: boolean;
	minHours: number;
	minMessages: number;
	model?: string;
}

interface DreamRun {
	id: string;
	since: string;
	startedAt: string;
	/** The dream process, to detect an exit before it records a result. */
	pid?: number;
	finishedAt?: string;
	error?: string;
	/** Kept until the notice is shown. */
	files?: DreamFileChange[];
	/** Paths whose edits the allowlist blocked. */
	blocked?: string[];
	noticed?: boolean;
}

interface DreamState {
	lastAttempt?: string;
	lastSuccess?: string;
	/** Where counting starts before the first successful run, so messages accumulate across days. */
	firstSince?: string;
	lastRun?: DreamRun;
}

interface DreamFileChange {
	label: string;
	linesBefore: number;
	linesAfter: number;
	diff: string;
	reason?: string;
}

interface DreamNotice {
	summary: string;
	error?: string;
	files: Array<{ label: string; reason?: string; diff: string }>;
	blocked?: string[];
	report?: string;
}

// ============================================================================
// Paths, settings, state, lock
// ============================================================================

function dreamDir(): string {
	return path.join(getAgentDir(), "tape", "dream");
}

function reportPath(id: string): string {
	return path.join(dreamDir(), `${id}.md`);
}

/** Backups of the memory files a run edited, by their path in the memory directory. */
function backupDir(id: string): string {
	return path.join(dreamDir(), id);
}

function statePath(): string {
	return path.join(dreamDir(), "state.json");
}

function lockPath(): string {
	return path.join(dreamDir(), "lock");
}

export function readDreamSettings(): DreamSettings {
	let section: any;
	try {
		section = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf-8"))?.["pi-tape"]?.dream;
	} catch { /* defaults */ }
	const s = section && typeof section === "object" ? section : {};
	return {
		enabled: s.enabled === true,
		minHours: typeof s.minHours === "number" && s.minHours > 0 ? s.minHours : 24,
		minMessages: Number.isInteger(s.minMessages) && s.minMessages >= 0 ? s.minMessages : 30,
		model: typeof s.model === "string" && s.model.trim() ? s.model.trim() : undefined,
	};
}

function readState(): DreamState {
	try {
		return JSON.parse(fs.readFileSync(statePath(), "utf-8")) as DreamState;
	} catch {
		return {};
	}
}

function writeState(state: DreamState): void {
	fs.mkdirSync(dreamDir(), { recursive: true });
	const tmp = `${statePath()}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
	fs.renameSync(tmp, statePath());
}

function updateRun(id: string, patch: Partial<DreamRun>, extra: Partial<DreamState> = {}): void {
	const state = readState();
	if (state.lastRun?.id !== id) return;
	writeState({ ...state, ...extra, lastRun: { ...state.lastRun, ...patch } });
}

function lockIsFresh(now: number): boolean {
	try {
		return now - fs.statSync(lockPath()).mtimeMs < LOCK_STALE_MS;
	} catch {
		return false;
	}
}

function acquireLock(now: number): boolean {
	fs.mkdirSync(dreamDir(), { recursive: true });
	const content = `${process.pid} ${new Date(now).toISOString()}\n`;
	try {
		fs.writeFileSync(lockPath(), content, { flag: "wx" });
		return true;
	} catch {
		if (lockIsFresh(now)) return false;
		try {
			fs.rmSync(lockPath(), { force: true });
			fs.writeFileSync(lockPath(), content, { flag: "wx" });
			return true;
		} catch {
			return false;
		}
	}
}

function releaseLock(): void {
	fs.rmSync(lockPath(), { force: true });
}

/** Local start time to the minute; seconds and then a counter only to avoid a collision. */
function newRunId(now: number): string {
	const date = new Date(now);
	const pad = (n: number) => String(n).padStart(2, "0");
	const minute = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
	const second = `${minute}${pad(date.getSeconds())}`;
	for (let n = 0; ; n++) {
		const id = n === 0 ? minute : n === 1 ? second : `${second}-${n}`;
		if (!fs.existsSync(reportPath(id))) return id;
	}
}

function pruneRuns(keep: number): void {
	let ids: string[];
	try {
		ids = fs.readdirSync(dreamDir()).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();
	} catch {
		return;
	}
	for (const id of ids.slice(0, Math.max(0, ids.length - keep))) {
		fs.rmSync(reportPath(id), { force: true });
		fs.rmSync(backupDir(id), { recursive: true, force: true });
	}
}

// ============================================================================
// Session scanning
// ============================================================================

function sessionFilesModifiedAfter(sinceMs: number): string[] {
	const root = path.join(getAgentDir(), "sessions");
	const files: string[] = [];
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const dir of dirs) {
		if (!dir.isDirectory()) continue;
		const dirPath = path.join(root, dir.name);
		for (const name of fs.readdirSync(dirPath)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = path.join(dirPath, name);
			try {
				if (fs.statSync(file).mtimeMs > sinceMs) files.push(file);
			} catch { /* skip */ }
		}
	}
	return files;
}

function entryTime(entry: any): number {
	const raw = entry?.timestamp ?? entry?.message?.timestamp;
	return typeof raw === "number" ? raw : Date.parse(raw);
}

function anchorOf(entry: any): { name: string; summary: string } | undefined {
	const message = entry?.type === "message" ? entry.message : undefined;
	const anchor = message?.role === "toolResult" && message.toolName === "tape" ? message.details?.tapeAnchor : undefined;
	return anchor?.version === 1 && anchor.name && anchor.summary ? anchor : undefined;
}

/** Per session file: bytes already scanned and the times of the user messages in them. */
const userMessageTimes = new Map<string, { offset: number; times: number[] }>();

/** Counts the user's own messages after sinceMs, reading only what each session file appended since the last count. */
async function countUserMessagesSince(sinceMs: number, enough: number): Promise<number> {
	let count = 0;
	for (const file of sessionFilesModifiedAfter(sinceMs)) {
		let scanned = userMessageTimes.get(file);
		try {
			const size = (await fs.promises.stat(file)).size;
			if (!scanned || size < scanned.offset) scanned = { offset: 0, times: [] };
			if (size > scanned.offset) {
				const handle = await fs.promises.open(file, "r");
				const buffer = Buffer.alloc(size - scanned.offset);
				try {
					await handle.read(buffer, 0, buffer.length, scanned.offset);
				} finally {
					await handle.close();
				}
				const complete = buffer.lastIndexOf(0x0a) + 1;
				for (const line of buffer.subarray(0, complete).toString("utf-8").split("\n")) {
					if (!line.includes('"user"')) continue;
					let entry: any;
					try { entry = JSON.parse(line); } catch { continue; }
					if (userText(entry)) scanned.times.push(entryTime(entry));
				}
				scanned.offset += complete;
			}
		} catch {
			continue;
		}
		userMessageTimes.set(file, scanned);
		count += scanned.times.filter((time) => time > sinceMs).length;
		if (count >= enough) return count;
	}
	return count;
}

function userText(entry: any): string | undefined {
	const message = entry?.type === "message" ? entry.message : undefined;
	if (message?.role !== "user") return undefined;
	const content = message.content;
	const text = typeof content === "string"
		? content
		: Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n") : "";
	return text.trim() && !FORWARDED_MESSAGE.test(text) ? text.trim() : undefined;
}

/** Anchor summaries and the user's own messages in (since, until], oldest first, in full. */
export function buildDreamInput(sinceMs: number, untilMs: number): { text: string; anchors: number; messages: number } {
	const items: Array<{ time: number; block: string; anchor: boolean }> = [];
	for (const file of sessionFilesModifiedAfter(sinceMs)) {
		let raw: string;
		try { raw = fs.readFileSync(file, "utf-8"); } catch { continue; }
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			const time = entryTime(entry);
			if (!(time > sinceMs && time <= untilMs)) continue;
			const anchor = anchorOf(entry);
			const text = anchor ? undefined : userText(entry);
			if (!anchor && !text) continue;
			const head = `## ${new Date(time).toISOString()} ${anchor ? `anchor ${anchor.name}` : "user"} · entryId=${entry.id} · sessionFile=${file}`;
			items.push({ time, anchor: !!anchor, block: `${head}\n${anchor ? anchor.summary : text}\n` });
		}
	}
	items.sort((a, b) => a.time - b.time);

	const anchors = items.filter((item) => item.anchor).length;
	const messages = items.length - anchors;
	const header = [
		"# Tape dream input",
		`Range: ${new Date(sinceMs).toISOString()} → ${new Date(untilMs).toISOString()}`,
		`Items: ${anchors} anchors, ${messages} user messages`,
	].join("\n");
	return { text: [header, ...items.map((item) => item.block)].join("\n\n"), anchors, messages };
}

// ============================================================================
// Interactive side: trigger and notice
// ============================================================================

let lastCheck = Number.NEGATIVE_INFINITY;

/**
 * Starts a detached dream run when one is due; resolves to the decision for diagnostics and tests.
 * `onExit` runs when the dream process ends while this process is still alive.
 */
export async function maybeStartDream(mode: string, now = Date.now(), onExit?: () => void): Promise<string> {
	if (mode !== "tui" || process.env[DREAM_ENV]) return "skip";
	const settings = readDreamSettings();
	if (!settings.enabled) return "disabled";
	const state = readState();
	if (state.lastAttempt && now - Date.parse(state.lastAttempt) < settings.minHours * HOUR_MS) return "not-due";
	if (now - lastCheck < CHECK_INTERVAL_MS) return "checked-recently";
	lastCheck = now;
	const since = state.lastSuccess ?? state.firstSince ?? new Date(now - settings.minHours * HOUR_MS).toISOString();
	if (!state.lastSuccess && !state.firstSince) writeState({ ...state, firstSince: since });
	if (await countUserMessagesSince(Date.parse(since), settings.minMessages) < settings.minMessages) return "too-few-messages";
	if (!acquireLock(now)) return "locked";

	const startedAt = new Date(now).toISOString();
	pruneRuns(RUNS_KEPT - 1);
	const id = newRunId(now);
	writeState({ ...readState(), lastAttempt: startedAt, lastRun: { id, since, startedAt } });

	const fail = (error: unknown) => {
		updateRun(id, { finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
		releaseLock();
		onExit?.();
	};
	try {
		const out = fs.openSync(reportPath(id), "w");
		// The user's extensions load as in any `pi -p`, so every model they use resolves.
		const args = [process.argv[1], "-p", "--no-session", "--no-mcp", "--tools", "read,write,edit,tape"];
		if (settings.model) args.push("--model", settings.model);
		args.push(DREAM_REQUEST);
		const child = spawn(process.execPath, args, {
			cwd: os.homedir(),
			detached: true,
			stdio: ["ignore", out, out],
			env: { ...process.env, [DREAM_ENV]: "1" },
		});
		fs.closeSync(out);
		if (child.pid) updateRun(id, { pid: child.pid });
		child.on("error", fail);
		child.on("exit", () => onExit?.());
		child.unref();
	} catch (error) {
		fail(error);
	}
	return "started";
}

function reasonFor(report: string, label: string): string | undefined {
	for (const line of report.split("\n")) {
		const match = line.match(/^\s*[-*]\s+`?([^`:]+)`?:\s*(.+)$/);
		if (match && match[1].trim() === label) return match[2].trim().slice(0, 200);
	}
	return undefined;
}

function summarize(files: DreamFileChange[]): string {
	if (files.length === 0) return "no changes";
	const parts: string[] = [];
	const index = files.find((file) => file.label === "MEMORY.md");
	if (index) parts.push(`MEMORY.md ${index.linesBefore}→${index.linesAfter} lines`);
	const topics = files.length - (index ? 1 : 0);
	if (topics) parts.push(`${topics} topic file${topics === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The last lines of a report, for a run that ended without a result. */
function reportTail(id: string): string | undefined {
	const text = readOptional(reportPath(id))?.replace(/\x1b\[[0-9;]*m/g, "") ?? "";
	const tail = text.split("\n").map((line) => line.trim()).filter(Boolean).slice(-3).join(" · ");
	return tail ? tail.slice(-300) : undefined;
}

/** Shows the last finished run once, as a display-only entry outside model context. */
export function showDreamNotice(pi: ExtensionAPI, now = Date.now()): void {
	const run = readState().lastRun;
	if (!run || run.noticed) return;
	if (!run.finishedAt && (run.pid ? processAlive(run.pid) : lockIsFresh(now))) return;

	const notice: DreamNotice = { summary: "", files: [], report: reportPath(run.id) };
	if (!run.finishedAt) {
		notice.error = reportTail(run.id) ?? "the dream process exited without a result";
		releaseLock();
	} else if (run.error) {
		notice.error = run.error;
	} else {
		const files = run.files ?? [];
		notice.summary = summarize(files);
		notice.files = files.map(({ label, reason, diff }) => ({ label, reason, diff }));
		notice.blocked = run.blocked;
	}
	pi.appendEntry(ENTRY_TYPE, notice);
	updateRun(run.id, { noticed: true, files: undefined, blocked: undefined, finishedAt: run.finishedAt ?? new Date(now).toISOString(), error: notice.error });
}

export function registerDreamRenderer(pi: ExtensionAPI): void {
	// Always expanded, like Pi's changelog: each file with its reason and full diff.
	pi.registerEntryRenderer?.(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as DreamNotice;
		if (data.error) return new Text(theme.fg("error", `tape dream failed: ${data.error}`), 1, 0);
		const title = `${theme.bold("tape dream")} ${theme.fg("muted", `· ${data.summary}`)}`;
		const lines = [title, ...(data.blocked ?? []).map((file) => theme.fg("warning", `blocked: ${file}`))];
		if (data.files.length === 0) return new Text(lines.join("\n"), 1, 0);
		for (const file of data.files) {
			lines.push("", `${theme.bold(file.label)}${file.reason ? theme.fg("muted", ` — ${file.reason}`) : ""}`, renderDiff(file.diff));
		}
		if (data.report) lines.push("", theme.fg("dim", `report: ${data.report}`));
		return new Text(lines.join("\n"), 1, 0);
	});
}

// ============================================================================
// Dream process side (PI_TAPE_DREAM set)
// ============================================================================

let activeRun: {
	id: string;
	since: string;
	startedAt: string;
	/** Temporary, removed when the run ends. */
	inputDir: string;
	blocked: Set<string>;
	report?: string;
	error?: string;
	/** Set once the agent run has settled, after any automatic retries. */
	settled?: boolean;
	originals: Map<string, { label: string; content: string | null }>;
} | null = null;

function realTarget(file: string): string {
	let dir = file;
	const rest: string[] = [];
	while (!fs.existsSync(dir)) {
		const parent = path.dirname(dir);
		if (parent === dir) break;
		rest.unshift(path.basename(dir));
		dir = parent;
	}
	try {
		return path.join(fs.realpathSync.native(dir), ...rest);
	} catch {
		return file;
	}
}

function memoryDir(): string {
	return path.join(getAgentDir(), "tape", "memory");
}

/** A path's label relative to the memory directory, or undefined when dream may not edit it. */
function editableLabel(target: string): string | undefined {
	const relative = path.relative(realTarget(memoryDir()), target);
	if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
	return undefined;
}

function memoryFiles(): string[] {
	try {
		return (fs.readdirSync(memoryDir(), { recursive: true, withFileTypes: true }) as fs.Dirent[])
			.filter((dirent) => dirent.isFile())
			.map((dirent) => path.relative(memoryDir(), path.join(dirent.parentPath, dirent.name)).split(path.sep).join("/"))
			.sort();
	} catch {
		return [];
	}
}

function readOptional(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

function lineCount(content: string | null): number {
	const trimmed = content?.trimEnd() ?? "";
	return trimmed ? trimmed.split("\n").length : 0;
}

export function dreamSessionStart(): void {
	if (!process.env[DREAM_ENV]) return;
	const run = readState().lastRun;
	if (!run || run.finishedAt) return;
	const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tape-dream-"));
	activeRun = { id: run.id, since: run.since, startedAt: run.startedAt, inputDir, blocked: new Set(), originals: new Map() };
	fs.writeFileSync(path.join(inputDir, "input.md"), buildDreamInput(Date.parse(run.since), Date.parse(run.startedAt)).text);
}

export function dreamPromptSection(): string | undefined {
	if (!activeRun) return undefined;
	const files = memoryFiles();
	const values: Record<string, string> = {
		input: path.join(activeRun.inputDir, "input.md"),
		since: activeRun.since,
		until: activeRun.startedAt,
		memory: memoryDir(),
		files: files.length ? files.join(", ") : "none yet",
	};
	return fs.readFileSync(path.join(EXTENSION_DIR, "dream.md"), "utf-8").replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
}

export function dreamToolCall(event: { toolName: string; input: any }, ctx: { cwd: string }): { block: true; reason: string } | undefined {
	if (!process.env[DREAM_ENV]) return undefined;
	if (event.toolName === "tape" && event.input?.action === "anchor") {
		return { block: true, reason: "A dream run cannot create anchors." };
	}
	if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

	const requested = path.resolve(ctx.cwd, String(event.input?.path ?? "").replace(/^~(?=$|\/)/, os.homedir()));
	const target = realTarget(requested);
	const label = editableLabel(target);
	if (!label) {
		activeRun?.blocked.add(requested.startsWith(os.homedir()) ? `~${requested.slice(os.homedir().length)}` : requested);
		return { block: true, reason: `A dream run may only edit files in ${memoryDir()}.` };
	}
	if (activeRun && !activeRun.originals.has(target)) {
		const content = readOptional(target);
		activeRun.originals.set(target, { label, content });
		if (content !== null) {
			const backup = path.join(backupDir(activeRun.id), label);
			fs.mkdirSync(path.dirname(backup), { recursive: true });
			fs.writeFileSync(backup, content);
		}
	}
	return undefined;
}

export function dreamAgentEnd(messages: any[]): void {
	if (!activeRun) return;
	const last = [...messages].reverse().find((message) => message?.role === "assistant");
	// A retry ends with another agent_end, so only the last attempt counts.
	activeRun.error = last?.stopReason === "error" || last?.stopReason === "aborted"
		? last.errorMessage || `model run ${last.stopReason}`
		: undefined;
	activeRun.report = (last?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
}

export function dreamAgentSettled(): void {
	if (activeRun) activeRun.settled = true;
}

export function dreamSessionShutdown(): void {
	if (!activeRun) return;
	const run = activeRun;
	activeRun = null;
	// A shutdown before the run settled, e.g. on SIGTERM, interrupted it.
	if (!run.settled) run.error = "the dream run was interrupted";
	const files: DreamFileChange[] = [];
	for (const [target, original] of run.originals) {
		const current = readOptional(target);
		if (current === original.content) {
			fs.rmSync(path.join(backupDir(run.id), original.label), { force: true });
			continue;
		}
		files.push({
			label: original.label,
			linesBefore: lineCount(original.content),
			linesAfter: lineCount(current),
			diff: generateDiffString(original.content ?? "", current ?? "").diff,
			reason: reasonFor(run.report ?? "", original.label),
		});
	}
	if (![...run.originals.values()].some((original) => original.content !== null && files.some((file) => file.label === original.label))) {
		fs.rmSync(backupDir(run.id), { recursive: true, force: true });
	}
	fs.rmSync(run.inputDir, { recursive: true, force: true });
	const finishedAt = new Date().toISOString();
	const blocked = run.blocked.size ? [...run.blocked] : undefined;
	updateRun(run.id, { finishedAt, error: run.error, files, blocked }, run.error ? {} : { lastSuccess: run.startedAt });
	releaseLock();
}
