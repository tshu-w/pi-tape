import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { anchorMessage, loadTape, makeAgentDir, textMessage } from "./harness.mjs";

const { prepareCompaction } = await import(new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const agentDir = makeAgentDir();
const settings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 };
const oldText = "Old persisted history. ".repeat(2000);

function appendAnchor(session, name) {
	session.appendMessage(textMessage("user", `Create checkpoint ${name}.`));
	const toolCallId = `${name}-call`;
	session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "tape", arguments: { action: "anchor", name, summary: `Summary of ${name}.` } }], timestamp: Date.now(), stopReason: "toolUse" });
	return session.appendMessage({ ...anchorMessage({ name, summary: `Summary of ${name}.`, cwd: "/work", createdAt: new Date().toISOString(), keepRecentTokens: 1 }), toolCallId, isError: false });
}
function appendReply(session, text) {
	return session.appendMessage({ ...textMessage("assistant", text), stopReason: "stop" });
}
function context(session, requests = []) {
	return {
		cwd: "/work", sessionManager: session, model: {}, hasUI: false, mode: "print",
		getContextUsage: () => ({ tokens: 20000 }),
		ui: { notify() {} },
		modelRegistry: { streamSimple(_model, request, options) {
			requests.push({ request, options });
			return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Native replacement summary." }] }) };
		} },
	};
}
async function visible(handlers, ctx) {
	const messages = ctx.sessionManager.buildSessionProjection().messages;
	return (await handlers.context_with_system({ messages }, ctx))?.messages ?? messages;
}
const summaries = messages => messages.filter(message => message.role === "custom" && message.customType === "tape-summary");

test("disk v1 anchors survive resume, yield to a saved native compaction, and can follow it", async () => {
	const session = SessionManager.create("/work", path.join(agentDir, "main"));
	const oldMessageId = session.appendMessage(textMessage("user", oldText));
	appendReply(session, "Old reply.");
	appendAnchor(session, "first");
	session.appendMessage(textMessage("user", "Middle work. ".repeat(1000)));
	appendReply(session, "Middle reply.");
	const latestAnchorId = appendAnchor(session, "latest");
	session.appendMessage(textMessage("user", "Recent work. ".repeat(1000)));
	appendReply(session, "Ready for native compaction.");
	const sessionFile = session.getSessionFile();
	assert.ok(fs.existsSync(sessionFile));

	const resumed = SessionManager.open(sessionFile);
	const rawBefore = structuredClone(resumed.getEntries());
	const requests = [];
	const ctx = context(resumed, requests);
	const { handlers } = await loadTape({ compaction: settings, retry: { enabled: false } });
	await handlers.session_start({ reason: "resume" }, ctx);
	const before = await visible(handlers, ctx);
	assert.equal(summaries(before).length, 1);
	assert.match(summaries(before)[0].content, /Summary of latest/);
	assert.doesNotMatch(JSON.stringify(before), /Old persisted history/);
	assert.deepEqual(resumed.getEntries(), rawBefore);

	const preparation = prepareCompaction(resumed.getBranch(), settings);
	assert.ok(preparation);
	const generated = await handlers.session_before_compact({ reason: "manual", branchEntries: resumed.getBranch(), preparation, signal: new AbortController().signal }, ctx);
	assert.equal(generated.compaction.summary, "Native replacement summary.");
	assert.equal(requests.length, 1);
	assert.match(JSON.stringify(requests[0].request.messages), /Summary of latest/);
	assert.doesNotMatch(JSON.stringify(requests[0].request.messages), /Old persisted history/);
	assert.equal(requests[0].options.disableContinuation, true);
	assert.equal(requests[0].options.sessionId, resumed.getSessionId());
	const result = generated.compaction;
	const compactId = resumed.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true, result.usage);
	await handlers.session_compact({ compactionEntry: resumed.getEntry(compactId), fromExtension: true, reason: "manual" }, ctx);
	assert.deepEqual(resumed.getEntries().slice(0, rawBefore.length), rawBefore);

	const loaded = SessionManager.open(sessionFile);
	const fresh = await loadTape({ compaction: settings });
	const loadedCtx = context(loaded);
	await fresh.handlers.session_start({ reason: "resume" }, loadedCtx);
	assert.equal(loaded.getEntry(latestAnchorId).message.details.tapeAnchor.version, 1);
	assert.equal(loaded.getEntry(compactId).type, "compaction");
	assert.equal(loaded.getEntry(compactId).fromHook, true);
	const after = await visible(fresh.handlers, loadedCtx);
	assert.equal(summaries(after).length, 0, "saved native compaction supersedes the old anchor");
	assert.match(JSON.stringify(after), /Native replacement summary/);

	const recall = params => fresh.tools.tape.execute("recall", params, undefined, undefined, loadedCtx);
	const oldSearch = await recall({ action: "search", query: "Old persisted history", kinds: ["message"], scope: "session" });
	assert.deepEqual(oldSearch.details.results.map(item => item.entryId), [oldMessageId]);
	const oldView = await recall({ action: "view", entryId: oldMessageId });
	assert.ok(oldView.content[0].text.endsWith(oldText), "folded original text remains readable after compaction and resume");
	const anchorSearch = await recall({ action: "search", query: "Summary of latest", kinds: ["compaction"], scope: "session" });
	assert.deepEqual(anchorSearch.details.results.map(item => [item.entryId, item.kind]), [[latestAnchorId, "compaction"]]);
	const anchorView = await recall({ action: "view", entryId: latestAnchorId });
	assert.ok(anchorView.content[0].text.endsWith("Summary of latest."));
	const nativeSearch = await recall({ action: "search", query: "Native replacement summary", kinds: ["compaction"], scope: "session" });
	assert.deepEqual(nativeSearch.details.results.map(item => item.entryId), [compactId], "current compaction summaries remain searchable");
	const nativeView = await recall({ action: "view", entryId: compactId });
	assert.ok(nativeView.content[0].text.endsWith("Native replacement summary."));

	loaded.appendMessage(textMessage("user", "Later work. ".repeat(1000)));
	appendReply(loaded, "Later reply.");
	appendAnchor(loaded, "after-native");
	appendReply(loaded, "Persist the new branch leaf.");
	const reopened = SessionManager.open(sessionFile);
	const later = await loadTape({ compaction: settings });
	const laterCtx = context(reopened);
	await later.handlers.session_start({ reason: "resume" }, laterCtx);
	const final = await visible(later.handlers, laterCtx);
	assert.equal(summaries(final).length, 1);
	assert.match(summaries(final)[0].content, /Summary of after-native/);
});

test("disk fork and tree navigation use only the selected branch's anchor or compaction", async () => {
	const session = SessionManager.create("/work", path.join(agentDir, "branches"));
	session.appendMessage(textMessage("user", oldText));
	appendReply(session, "Old reply.");
	const firstAnchorId = appendAnchor(session, "fork-point");
	session.appendMessage(textMessage("user", "Sibling history. ".repeat(1000)));
	appendReply(session, "Sibling reply.");
	const siblingAnchorId = appendAnchor(session, "sibling");
	const siblingCompactId = session.appendCompaction("Sibling native summary.", siblingAnchorId, 10000);
	const { handlers } = await loadTape({ compaction: settings });
	const ctx = context(session);
	assert.equal(summaries(await visible(handlers, ctx)).length, 0);

	session.branch(firstAnchorId);
	await handlers.session_tree({ newLeafId: firstAnchorId }, ctx);
	session.appendMessage(textMessage("user", "Selected early branch."));
	appendReply(session, "Persist selected branch.");
	const early = await visible(handlers, ctx);
	assert.match(summaries(early)[0].content, /Summary of fork-point/);
	assert.doesNotMatch(JSON.stringify(early), /Sibling native summary|Summary of sibling/);

	const forked = SessionManager.forkFrom(session.getSessionFile(), "/work", path.join(agentDir, "fork"));
	assert.notEqual(forked.getSessionFile(), session.getSessionFile());
	assert.equal(forked.getHeader().parentSession, session.getSessionFile());
	assert.ok(forked.getEntry(siblingCompactId), "off-branch compaction exists in the fork's raw file");
	assert.equal(forked.getBranch().some(entry => entry.id === siblingCompactId), false);
	const forkRuntime = await loadTape({ compaction: settings });
	const forkCtx = context(forked);
	await forkRuntime.handlers.session_start({ reason: "fork" }, forkCtx);
	assert.match(summaries(await visible(forkRuntime.handlers, forkCtx))[0].content, /Summary of fork-point/);

	forked.branch(siblingCompactId);
	await forkRuntime.handlers.session_tree({ newLeafId: siblingCompactId }, forkCtx);
	const sibling = await visible(forkRuntime.handlers, forkCtx);
	assert.equal(summaries(sibling).length, 0);
	assert.match(JSON.stringify(sibling), /Sibling native summary/);
	forked.appendMessage(textMessage("user", "Continue the compacted branch."));
	appendReply(forked, "Persist compacted branch.");
	const reopened = SessionManager.open(forked.getSessionFile());
	const runtime = await loadTape({ compaction: settings });
	const resumedCtx = context(reopened);
	await runtime.handlers.session_start({ reason: "resume" }, resumedCtx);
	assert.equal(summaries(await visible(runtime.handlers, resumedCtx)).length, 0);
	assert.equal(reopened.getBranch().some(entry => entry.id === siblingCompactId), true);
});

test.after(() => fs.rmSync(agentDir, { recursive: true }));
