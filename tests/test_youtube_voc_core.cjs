const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const core = require('../scripts/youtube_voc_core.cjs');

test('single, group and file ASIN inputs merge and deduplicate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-voc-'));
  const file = path.join(dir, 'asins.txt');
  fs.writeFileSync(file, 'B000000002\nB000000003, B000000001\n');
  assert.deepEqual(core.parseAsinInputs({asin:'B000000001', asins:'B000000002 B000000001', asinFile:file}),
    ['B000000001','B000000002','B000000003']);
});

test('legacy Trusted partition remains available only as diagnostic metadata', () => {
  const rows = [{comment_id:'a',body:'x',audit_status:'PASS',relevance_tier:'direct_product'},
    {comment_id:'a',body:'x',audit_status:'PASS',relevance_tier:'direct_product'},
    {comment_id:'b',body:'x',audit_status:'PARTIAL',relevance_tier:'direct_product'},
    {comment_id:'c',body:'x',audit_status:'PASS',relevance_tier:'irrelevant'}];
  assert.equal(core.countTrustedUnique(rows), 1);
});

test('keyword normalization drops naked broad words and near duplicates', () => {
  const rows = core.cleanKeywordPlan(['Dog','dogs','Joint','Zesty Paws Mobility Bites','zesty paws mobility bite']);
  assert.deepEqual(rows.map(x => x.cleaned_keyword), ['Zesty Paws Mobility Bites']);
});

test('videos deduplicate globally and merge query and ASIN lineage', () => {
  const rows = core.dedupeVideos([
    {video_id:'v1', matched_query:'q1', matched_asins:['A']},
    {video_id:'v1', matched_query:'q2', matched_asins:['B']},
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].matched_queries, ['q1','q2']);
  assert.deepEqual(rows[0].matched_asins, ['A','B']);
});

test('comment tree flattens with direct parent ids and increasing depth', () => {
  const rows = core.flattenCommentTree([{comment_id:'top',body:'x',replies:[{comment_id:'r1',body:'y',replies:[{comment_id:'r2',body:'z'}]}]}], 'vid');
  assert.deepEqual(rows.map(x => [x.comment_id,x.parent_comment_id,x.depth,x.source_parent_id]), [
    ['top',null,0,'video:vid'], ['r1','top',1,'video:vid'], ['r2','r1',2,'video:vid']]);
});

test('comments deduplicate by stable id and merge query and ASIN matches', () => {
  const rows = core.mergeComments([
    {comment_id:'c1',comment_url:'u1',body:'ok',matched_keywords:['q1'],matched_asins:['A']},
    {comment_id:'c1',comment_url:'u2',body:'ok',matched_keywords:['q2'],matched_asins:['B']},
  ]);
  assert.equal(rows.length,1);
  assert.deepEqual(rows[0].matched_keywords,['q1','q2']);
  assert.deepEqual(rows[0].matched_asins,['A','B']);
});

test('raw collection keeps advertising, short, low-relevance and similar distinct comments', () => {
  const rows = core.mergeComments([
    {comment_id:'ad',video_id:'v1',author:'seller',body:'See the Amazon listing https://amzn.to/x — affiliate link.'},
    {comment_id:'short',video_id:'v1',author:'a',body:'OK'},
    {comment_id:'offtopic',video_id:'v1',author:'b',body:'Great camera work',relevance_tier:'irrelevant'},
    {comment_id:'similar-1',video_id:'v1',author:'c',body:'Helped my dog after two weeks'},
    {comment_id:'similar-2',video_id:'v1',author:'c',body:'Helped my dog after three weeks'},
  ]);
  assert.deepEqual(rows.map(row => row.comment_id), ['ad','short','offtopic','similar-1','similar-2']);
});

test('raw collection removes only stable-id or exact fallback technical duplicates', () => {
  const rows = core.mergeComments([
    {comment_id:'same',comment_url:'u1',video_id:'v1',author:'a',body:'first capture'},
    {comment_id:'same',comment_url:'u2',video_id:'v1',author:'a',body:'second capture'},
    {video_id:'v2',author:'b',body:'exact text'},
    {video_id:'v2',author:'b',body:'exact text'},
    {video_id:'v2',author:'b',body:'Exact text'},
    {video_id:'v3',author:'b',body:'exact text'},
  ]);
  assert.equal(rows.length,4);
  assert.deepEqual(rows.map(row => row.body), ['first capture','exact text','Exact text','exact text']);
});

test('only empty and tombstone placeholders are not capturable comments', () => {
  assert.equal(core.isValidComment({body:'  '}),false);
  assert.equal(core.isValidComment({body:'[deleted]'}),false);
  assert.equal(core.isValidComment({body:'I am a bot, and this action was performed automatically.'}),true);
  assert.equal(core.isValidComment({body:'Link to the product featured in this video https://amzn.to/x We may receive a commission.'}),true);
  assert.equal(core.isValidComment({body:'OK'}),true);
  assert.equal(core.isValidComment({body:'Worked for my older dog'}),true);
});

test('product semantics keep distinctive product anchors and dog species', () => {
  const map = core.buildConversationMap([{asin:'B003ULL1NQ',title:'Nutramax Cosequin Joint Supplement for Dogs, Chewable Tablets',brand:'Nutramax Cosequin',bullets:['With glucosamine for mobility']}]);
  assert.ok(map.direct_terms.some(term=>/cosequin/i.test(term)));
  assert.equal(map.direct_terms.some(term=>/^supplement$/i.test(term)),false);
  assert.equal(map.target_species,'dog');
});

test('video relevance does not promote unrelated comments', () => {
  const map = {direct_terms:['zesty paws'],competitive_terms:['cosequin'],need_terms:['dog limping']};
  assert.equal(core.scoreVideoRelevance({title:'Zesty Paws review'},map).relevant,true);
  assert.equal(core.classifyCommentRelevance({body:'great camera work'},map).relevance_tier,'irrelevant');
});

test('dog product video audit rejects horse and human search drift', () => {
  const map = {direct_terms:['nutramax cosequin','cosequin'],competitive_terms:[],need_terms:['dog mobility'],target_species:'dog'};
  assert.equal(core.scoreVideoRelevance({title:'Nutramax Cosequin for Dogs mobility review'},map).relevant,true);
  assert.equal(core.scoreVideoRelevance({title:'Cosequin ASU horse joint supplement review'},map).relevant,false);
  assert.equal(core.scoreVideoRelevance({title:'Best human joint supplements for seniors'},map).relevant,false);
  assert.equal(core.scoreVideoRelevance({title:'Top 5 supplements for joint pain'},map).relevant,false);
});

test('semantic tiers are explainable', () => {
  const map = {direct_terms:['zesty paws'],competitive_terms:['cosequin'],need_terms:['dog limping']};
  assert.equal(core.classifyCommentRelevance({body:'Zesty Paws helped'},map).relevance_tier,'direct_product');
  assert.equal(core.classifyCommentRelevance({body:'Cosequin was cheaper'},map).relevance_tier,'competitive_context');
  const need = core.classifyCommentRelevance({body:'My dog limping after walks'},map);
  assert.equal(need.relevance_tier,'unmet_need');
  assert.ok(need.semantic_link && need.evidence_reason && need.confidence > 0);
});

test('dog joint unmet needs require dog context and reject human-only problems', () => {
  const map = {direct_terms:['cosequin'],competitive_terms:['dasuquin'],need_terms:['arthritis','limping','stiffness','stairs','acl'],target_species:'dog'};
  assert.equal(core.classifyCommentRelevance({body:'My senior dog is limping and stiff on the stairs'},map).relevance_tier,'unmet_need');
  assert.equal(core.classifyCommentRelevance({body:'My hip arthritis improved with exercise'},map).relevance_tier,'irrelevant');
  assert.equal(core.classifyCommentRelevance({body:'Dasuquin worked better for my dog'},map).relevance_tier,'competitive_context');
});

test('PASS, PARTIAL and BLOCKED partitioning keeps only PASS as Trusted', () => {
  const rows = core.partitionRecords([
    {comment_id:'p',body:'x',audit_status:'PASS',relevance_tier:'direct_product'},
    {comment_id:'q',body:'x',audit_status:'PARTIAL',relevance_tier:'direct_product'},
    {comment_id:'r',body:'x',audit_status:'BLOCKED',relevance_tier:'direct_product'},
  ]);
  assert.deepEqual(rows.trusted.map(x=>x.comment_id),['p']);
  assert.deepEqual(rows.partial.map(x=>x.comment_id),['q']);
  assert.equal(rows.blocked.length,1);
});

test('reaudit reconciliation preserves comments from BLOCKED videos as raw records', () => {
  const rows = core.reconcileVideoAudits([
    {comment_id:'a',body:'x',video_id:'v1',audit_status:'PARTIAL'},
    {comment_id:'b',body:'x',video_id:'v2',audit_status:'PARTIAL'},
  ],{v1:'BLOCKED',v2:'PASS'});
  assert.deepEqual(rows.map(row=>[row.comment_id,row.audit_status]),[['a','BLOCKED'],['b','PASS']]);
});

test('checkpoint migrates, resumes PASS skips and retries PARTIAL', () => {
  const cp = core.migrateCheckpoint({video_audits:{v1:'PASS',v2:'PARTIAL'}, searched_queries:['done']});
  assert.equal(core.shouldVisitVideo(cp,'v1',{retryPartial:true}),false);
  assert.equal(core.shouldVisitVideo(cp,'v2',{retryPartial:false}),false);
  assert.equal(core.shouldVisitVideo(cp,'v2',{retryPartial:true}),true);
  assert.equal(core.shouldVisitVideo(cp,'v2',{forceReauditPartial:true, queryAlreadyDone:true}),true);
});

test('legacy checkpoint requeues completed discovery queries when target is incomplete', () => {
  const cp = core.migrateCheckpoint({trusted_comment_count:2,discovery_round:1,query_plan:[
    {query:'q1',discovery_round:1,executed:true},{query:'q2',discovery_round:1,executed:true},
  ]});
  assert.equal(core.requeueQueriesForResume(cp,20),2);
  assert.deepEqual(cp.query_plan.map(row=>row.executed),[false,false]);
  assert.equal(core.requeueQueriesForResume(cp,2),0);
  const rawComplete = core.migrateCheckpoint({final_collected_count:20,trusted_comment_count:0,query_plan:[{query:'q',executed:true}]});
  assert.equal(core.requeueQueriesForResume(rawComplete,20),0);
  const advanced = core.migrateCheckpoint({trusted_comment_count:0,discovery_round:2,query_plan:[
    {query:'seed',discovery_round:1,executed:true},
  ]});
  assert.equal(core.requeueQueriesForResume(advanced,20),1);
  assert.equal(advanced.discovery_round,1);
  assert.equal(advanced.query_plan[0].executed,false);
});

test('checkpoint atomic save/load preserves state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-cp-'));
  const file = path.join(dir,'checkpoint.json');
  core.saveCheckpoint(file,{trusted_comment_count:7});
  assert.equal(core.loadCheckpoint(file).trusted_comment_count,7);
  assert.equal(fs.existsSync(file+'.tmp'),false);
});

test('access restriction trips immediate circuit breaker', () => {
  for (const state of ['captcha','login_required','age_restricted','region_restricted','rate_limited','access_denied']) {
    assert.equal(core.shouldCircuitBreak(state),true,state);
  }
  assert.equal(core.shouldCircuitBreak('ready'),false);
});

test('preflight never invokes formal comment collection', async () => {
  let collected = 0;
  const result = await core.runPreflight({amazon:async()=> 'ready', seller:async()=> 'unavailable', youtube:async()=> 'ready', video:async()=> 'ready', comments:async()=> 'ready', collect:async()=>{collected+=1;}});
  assert.equal(collected,0);
  assert.equal(result.ready,true);
});

test('evidence-derived queries keep source ids and discovery round', () => {
  const map = {products:[{brand:'Zesty Paws Mobility Bites'}],direct_terms:['zesty paws mobility bites','mobility bites']};
  const rows = core.deriveEvidenceQueries([{video_id:'v1',comment_id:'c1',body:'Mobility Bites took three weeks to work for my senior dog',relevance_tier:'direct_product',matched_asins:['A']}],2,[],map);
  assert.ok(rows.length);
  assert.match(rows[0].query,/mobility bites/i);
  assert.equal(rows[0].generation_source,'youtube_comment');
  assert.deepEqual(rows[0].source_video_ids,['v1']);
  assert.deepEqual(rows[0].evidence_comment_ids,['c1']);
  assert.equal(rows[0].discovery_round,2);
});

test('evidence query discovery rejects promotional and unanchored drift', () => {
  const map = {products:[{brand:'Nutramax Cosequin'}],direct_terms:['nutramax cosequin','cosequin']};
  const rows = core.deriveEvidenceQueries([
    {video_id:'v1',comment_id:'c1',body:'link to the product featured in this video',relevance_tier:'direct_product'},
    {video_id:'v2',comment_id:'c2',body:'check out the full review https://example.com',relevance_tier:'direct_product'},
    {video_id:'v3',comment_id:'c3',body:'Nutramax Dasuquin with MSM chewables review',relevance_tier:'direct_product'},
    {video_id:'v4',comment_id:'c4',body:'Cosequin helped my senior dog climb stairs after three weeks',relevance_tier:'direct_product'},
  ],2,[],map);
  assert.equal(rows.length,1);
  assert.match(rows[0].query,/cosequin/i);
  assert.doesNotMatch(rows[0].query,/https|check out|link to/i);
});

test('stop conditions include target, low yield, duplicates and max videos', () => {
  assert.equal(core.evaluateStop({trusted:20,targetComments:20}).stop_reason,'target_comments_reached');
  assert.equal(core.evaluateStop({trusted:1,targetComments:20,rounds:[{new_trusted:1},{new_trusted:0}],minNew:2}).stop_reason,'low_marginal_yield');
  assert.equal(core.evaluateStop({trusted:1,targetComments:20,rounds:[{duplicate_rate:.9},{duplicate_rate:.95}],duplicateRateStop:.8}).stop_reason,'duplicate_saturation');
  assert.equal(core.evaluateStop({trusted:1,targetComments:20,inspectedVideos:10,maxVideos:10}).stop_reason,'max_videos_reached');
});

test('audit tiers use frontier and access status', () => {
  assert.equal(core.auditVideo({relevant:true,access_state:'captcha'}).audit_status,'BLOCKED');
  assert.equal(core.auditVideo({relevant:true,access_state:'ready',remaining_reply_controls:2}).audit_status,'PARTIAL');
  assert.equal(core.auditVideo({relevant:true,access_state:'ready',remaining_reply_controls:0,orphan_count:0,stagnant_rounds:3}).audit_status,'PASS');
});

test('modern YouTube reply expansion labels are recognized without matching reply composer buttons', () => {
  assert.equal(core.isReplyExpansionLabel('1 reply'), true);
  assert.equal(core.isReplyExpansionLabel('View 3 replies'), true);
  assert.equal(core.isReplyExpansionLabel('1 条回复'), true);
  assert.equal(core.isReplyExpansionLabel('查看 2 条回复'), true);
  assert.equal(core.isReplyExpansionLabel('Reply'), false);
  assert.equal(core.isReplyExpansionLabel('回复'), false);
});
