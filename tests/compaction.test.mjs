import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { anchorEntry, loadTape, loadTapeModule, makeAgentDir, textMessage } from "./harness.mjs";

const agentDir = makeAgentDir();
const { prepareProjectedAnchorCompaction } = await loadTapeModule();

function messageEntry(id, message, timestamp = "2026-07-16T03:00:00.000Z") {
	return { type: "message", id, parentId: null, timestamp, message };
}

const settings = { enabled: true, reserveTokens: 32768, keepRecentTokens: 20 };
const fileOps = { read: new Set(), written: new Set(), edited: new Set() };
const discarded = "old".repeat(10_000);
const recent = "recent".repeat(100);

test("projected compaction summarizes the active view and keeps only entries after the anchor", () => {
	const branchEntries = [
		messageEntry("old-user", textMessage("user", discarded)),
		messageEntry("recent-user", textMessage("user", recent), "2026-07-16T03:10:00.000Z"),
		messageEntry("anchor-call", { role: "assistant", content: [], timestamp: Date.now() }),
		anchorEntry({
			id: "anchor-result",
			name: "checkpoint",
			summary: "Authoritative checkpoint.",
			cwd: "/x",
			createdAt: "2026-07-16T03:20:00.000Z",
			keepRecentTokens: 20,
		}),
		messageEntry("post-old", textMessage("user", recent), "2026-07-16T03:21:00.000Z"),
		messageEntry("post-kept", textMessage("user", "kept"), "2026-07-16T03:22:00.000Z"),
	];
	for (let i = 0; i < branchEntries.length; i++) {
		branchEntries[i].parentId = i > 0 ? branchEntries[i - 1].id : null;
	}

	const result = prepareProjectedAnchorCompaction(branchEntries, settings, 57011, fileOps);

	assert.equal(result.firstKeptEntryId, "post-old");
	assert.equal(result.tokensBefore, 57011);
	assert.equal(result.previousSummary, undefined);
	assert.equal(result.messagesToSummarize[0].customType, "tape-summary");
	assert.match(result.messagesToSummarize[0].content, /Authoritative checkpoint/);
	assert.ok(result.messagesToSummarize.some((message) => message.content?.[0]?.text === recent));
	assert.equal(result.messagesToSummarize.some((message) => message.content?.[0]?.text === discarded), false);
	assert.equal(result.messagesToSummarize.some((message) => message?.details?.tapeAnchor), false);
	assert.equal(result.messagesToSummarize.some((message) => message?.toolName === "tape"), false);
});

test("projected compaction can compact immediately after an anchor", () => {
	const branchEntries = [
		messageEntry("old-user", textMessage("user", discarded)),
		messageEntry("anchor-call", { role: "assistant", content: [], timestamp: Date.now() }),
		anchorEntry({
			id: "anchor-result",
			name: "checkpoint",
			summary: "Checkpoint.",
			cwd: "/x",
			createdAt: "2026-07-16T03:20:00.000Z",
			keepRecentTokens: 20,
		}),
	];
	for (let i = 0; i < branchEntries.length; i++) {
		branchEntries[i].parentId = i > 0 ? branchEntries[i - 1].id : null;
	}

	const result = prepareProjectedAnchorCompaction(branchEntries, settings, 1000, fileOps);
	assert.equal(result.firstKeptEntryId, "anchor-call");
	assert.equal(result.messagesToSummarize[0].customType, "tape-summary");
});

test("projected compaction finds the anchor tool call across parallel results", () => {
	const assistant = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "parallel-call", name: "read", arguments: { path: "README.md" } },
			{ type: "toolCall", id: "anchor-call-id", name: "tape", arguments: { action: "anchor" } },
		],
		timestamp: Date.now(),
	};
	const anchor = anchorEntry({
		id: "anchor-result",
		name: "checkpoint",
		summary: "Checkpoint.",
		cwd: "/x",
		createdAt: "2026-07-16T03:20:00.000Z",
		keepRecentTokens: 20,
	});
	anchor.message.toolCallId = "anchor-call-id";
	const branchEntries = [
		messageEntry("old-user", textMessage("user", discarded)),
		messageEntry("assistant-calls", assistant),
		messageEntry("parallel-result", { role: "toolResult", toolCallId: "parallel-call", toolName: "read", content: [{ type: "text", text: recent }], timestamp: Date.now() }),
		anchor,
	];
	for (let i = 0; i < branchEntries.length; i++) branchEntries[i].parentId = i > 0 ? branchEntries[i - 1].id : null;

	const result = prepareProjectedAnchorCompaction(branchEntries, settings, 1000, fileOps);
	assert.equal(result.firstKeptEntryId, "assistant-calls");
	assert.equal(result.messagesToSummarize.some((message) => message.toolCallId === "parallel-call"), false);
});

test("projected compaction falls back when a native compaction is the newer boundary", () => {
	const branchEntries = [
		anchorEntry({
			id: "anchor-result",
			name: "checkpoint",
			summary: "Checkpoint.",
			cwd: "/x",
			createdAt: "2026-07-16T03:20:00.000Z",
		}),
		messageEntry("kept-user", textMessage("user", "kept"), "2026-07-16T03:22:00.000Z"),
		{
			type: "compaction",
			id: "new-compaction",
			parentId: "kept-user",
			timestamp: "2026-07-16T03:23:00.000Z",
			summary: "New native summary.",
			firstKeptEntryId: "kept-user",
			tokensBefore: 57011,
		},
	];

	assert.equal(prepareProjectedAnchorCompaction(branchEntries, settings, 1000, fileOps), undefined);
});

test("overflow leaves generation to Pi while preserving the legacy projection", async () => {
 const { handlers } = await loadTape();
 const branchEntries = [messageEntry("old", textMessage("user", discarded)), messageEntry("recent", textMessage("user", recent)), messageEntry("call", textMessage("assistant", "")), anchorEntry({id:"anchor",name:"old",summary:"Legacy checkpoint",cwd:"/x",createdAt:"2026-07-16T03:20:00.000Z",keepRecentTokens:20})];
 for (let i=0;i<branchEntries.length;i++) branchEntries[i].parentId=i?branchEntries[i-1].id:null;
 const preparation = { settings, tokensBefore: 1000, fileOps };
 const result = await handlers.session_before_compact({reason:"overflow",branchEntries,preparation}, {getContextUsage:()=>({tokens:1000})});
 assert.equal(result, undefined);
 assert.match(JSON.stringify(preparation.messagesToSummarize), /Legacy checkpoint/);
 assert.ok(!JSON.stringify(preparation.messagesToSummarize).includes(discarded));
});

const { createJiti } = await import("jiti");
const { summarize, SUMMARY_TASK } = await createJiti(import.meta.url).import("../extensions/compaction.ts");

test("summary appends its task without changing the cached prefix and retries tool replies", async () => {
 for (const supportsSystem of [false,true]) {
  const prefix = [{role:"system",content:"Stable prompt",toolsAdded:[],timestamp:1},{role:"user",content:"Work",timestamp:2}];
  const requests=[];
  const pi={getSettings:()=>({retry:{enabled:true,maxRetries:1,baseDelayMs:1}}),getThinkingLevel:()=>"off"};
  const ctx={model:{compat:{supportsMidConvoSystemMessages:supportsSystem}},sessionManager:{getSessionId:()=>"same-session"},modelRegistry:{streamSimple(_model,context,options){
   requests.push({context,options});
   return {result:async()=>({role:"assistant",stopReason:"stop",content:requests.length===1?[{type:"toolCall",name:"read"}]:[{type:"text",text:"Done and pending."}],usage:{input:1}})};
  }}};
  const result=await summarize(pi,ctx,prefix,undefined,"Keep IDs");
  assert.equal(result.summary,"Done and pending.");
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0].context.messages.slice(0,2),prefix);
  assert.equal(requests[0].options.sessionId,"same-session");
  assert.equal(requests[0].options.disableContinuation,true);
  const suffix=requests[0].context.messages.slice(2);
  assert.equal(suffix.length,supportsSystem?2:1);
  assert.match(suffix[0].content,/Additional focus: Keep IDs/);
  assert.ok(suffix[0].content.startsWith(SUMMARY_TASK));
 }
 let attempts=0;
 const aborted={model:{},sessionManager:{getSessionId:()=>"same-session"},modelRegistry:{streamSimple(){attempts++;return {result:async()=>({stopReason:"aborted",content:[]})}}}};
 await assert.rejects(summarize({getSettings:()=>({retry:{enabled:true,maxRetries:1,baseDelayMs:1}}),getThinkingLevel:()=>"off"},aborted,[]),/Operation aborted/);
 assert.equal(attempts,1);
});

test("turn-end threshold is opt-in, validates settings, and leaves native triggers available", async () => {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const session = SessionManager.inMemory("/work");
	session.appendMessage(textMessage("user", discarded));
	session.appendMessage({ ...textMessage("assistant", "done"), stopReason: "stop" });
	const keptId = session.appendMessage(textMessage("user", "next"));
	const projection = session.buildSessionProjection();
	const event = { outcome: "completed", entries: [], context: { contextEntries: projection.entries, contextMessages: projection.messages } };
	const settingsFile = path.join(agentDir, "settings.json");
	const cases = [
		[undefined, 1000000, false, false],
		[{}, 1000000, false, false],
		[{ "pi-tape": {} }, 1000000, false, false],
		...[-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "200000", null].map(compactAt => [{ "pi-tape": { compactAt } }, 1000000, false, true]),
		...[
			{ "pi-tape": null },
			{ "pi-tape": [] },
			"invalid-json",
		].map(config => [config, 1000000, false, true]),
		[{ "pi-tape": { compactAt: 1000 } }, 999, false, false],
		[{ "pi-tape": { compactAt: 1000 } }, 1000, true, false],
	];
	try {
		for (const [config, tokens, expected, invalid] of cases) {
			if (config === undefined) fs.rmSync(settingsFile, { force: true });
			else fs.writeFileSync(settingsFile, typeof config === "string" ? config : JSON.stringify(config));
			const warnings = [];
			let requests = 0;
			const ctx = {
				cwd: "/work", sessionManager: session, model: {}, hasUI: false, mode: "print",
				getContextUsage: () => ({ tokens }),
				ui: { notify(message) { warnings.push(message); } },
				modelRegistry: { streamSimple() { requests++; return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Summary" }] }) }; } },
			};
			const { handlers } = await loadTape({ compaction: { keepRecentTokens: 1 }, retry: { enabled: false } });
			await handlers.session_start({}, ctx);
			assert.equal(warnings.some(message => /turn-end threshold disabled/.test(message)), invalid, JSON.stringify(config));
			const result = await handlers.turn_end(event, ctx);
			assert.equal(Boolean(result), expected, `${JSON.stringify(config)} at ${tokens} tokens`);
			assert.equal(requests, expected ? 1 : 0);
			if (result) assert.equal(result.entries[0].type, "compaction");
		}
		fs.writeFileSync(settingsFile, JSON.stringify({ "pi-tape": { compactAt: 1000 } }));
		const disabled = await loadTape({ compaction: { enabled: false } });
		assert.equal(await disabled.handlers.turn_end(event, { model: {}, getContextUsage: () => ({ tokens: 1000000 }) }), undefined);
		fs.rmSync(settingsFile);
		const { handlers } = await loadTape({ retry: { enabled: false } });
		const ctx = {
			model: {}, sessionManager: session, getContextUsage: () => ({ tokens: 1000 }),
			ui: { notify() {} },
			modelRegistry: { streamSimple() { return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Native trigger summary" }] }) }; } },
		};
		for (const reason of ["threshold", "manual"]) {
			const result = await handlers.session_before_compact({ reason, branchEntries: session.getBranch(), preparation: { settings, tokensBefore: 1000, fileOps, firstKeptEntryId: keptId } }, ctx);
			assert.equal(result.compaction.summary, "Native trigger summary");
		}
	} finally {
		fs.rmSync(settingsFile, { force: true });
	}
});

test("turn-end compaction uses a native draft without aborting or continuing the run", async () => {
 const { SessionManager }=await import("@earendil-works/pi-coding-agent");
 const session=SessionManager.inMemory("/work");
 session.appendMessage({role:"system",content:"Stable",timestamp:1});
 const oldId=session.appendMessage(textMessage("user",discarded));
 session.appendMessage({...textMessage("assistant","done"),stopReason:"stop"});
 session.appendMessage(textMessage("user","next"));
 const { tools,handlers }=await loadTape({compaction:{keepRecentTokens:1},retry:{enabled:false}});
 let received;
 const ctx={cwd:"/work",sessionManager:session,getContextUsage:()=>({tokens:200001}),model:{},hasUI:false,mode:"print",ui:{notify(){}},modelRegistry:{streamSimple(_model,context){received=context;return {result:async()=>({stopReason:"stop",content:[{type:"text",text:"Summary"}]})}}}};
 const accepted=await tools.tape.execute("id",{action:"compact"},undefined,undefined,ctx);
 assert.equal(accepted.content[0].text,"Compacting the context after this turn.");
 const projection=session.buildSessionProjection();
 const result=await handlers.turn_end({outcome:"completed",entries:[],context:{contextEntries:projection.entries,contextMessages:projection.messages}},ctx);
 assert.equal(result.entries[0].type,"compaction");
 assert.equal(result.entries[0].summary,"Summary");
 assert.equal(result.continue,undefined);
 assert.ok(result.entries[0].firstKeptEntryId);
 await handlers.context_with_system({messages:projection.messages},ctx);
 const preview=SessionManager.inMemory("/work",undefined,[session.getHeader(),...session.getBranch()]);
 preview.appendContextEdit(oldId,null);
 const edited=preview.buildSessionProjection();
 const draft={type:"context_edit",targetId:oldId,replacement:null};
 await tools.tape.execute("edited",{action:"compact"},undefined,undefined,ctx);
 await handlers.turn_end({outcome:"completed",entries:[draft],context:{contextEntries:edited.entries,contextMessages:edited.messages}},ctx);
 assert.ok(!JSON.stringify(received.messages).includes(discarded),"a prior boundary handler's omission must not be restored by the cached request");
 const disabled=await loadTape({compaction:{enabled:false,keepRecentTokens:1}});
 assert.equal(await disabled.handlers.turn_end({outcome:"completed",entries:[],context:{}},ctx),undefined);
 await disabled.tools.tape.execute("manual",{action:"compact"},undefined,undefined,ctx);
 const manual=await disabled.handlers.turn_end({outcome:"completed",entries:[],context:{contextEntries:projection.entries,contextMessages:projection.messages}},ctx);
 assert.equal(manual.entries[0].type,"compaction","model-requested compaction works without compactAt even when automatic compaction is disabled");
});
