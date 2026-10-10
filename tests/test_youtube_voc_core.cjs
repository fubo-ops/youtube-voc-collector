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

test('keyword normalization drops naked generic words and near duplicates', () => {
  const rows = core.cleanKeywordPlan(['Product','products','Review','Acme Slow Feeder Bowl','acme slow feeder bowls']);
  assert.deepEqual(rows.map(x => x.cleaned_keyword), ['Acme Slow Feeder Bowl']);
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
  const map = core.buildConversationMap([{asin:'B000000001',title:'AquaPurr Cat Water Fountain',brand:'AquaPurr',bullets:['Quiet filtered drinking water for cats']}]);
  assert.ok(map.direct_terms.some(term=>/aquapurr/i.test(term)));
  assert.equal(map.direct_terms.some(term=>/^fountain$/i.test(term)),false);
  assert.equal(map.target_species,'cat');
});

test('product semantics switch between lick bowl and joint supplement ASINs', () => {
  const lick = core.buildProductContext({
    asin:'B0HMGGX71C',
    title:'Dog Lick Bowl Slow Feeder',
    bullets:['Reduces anxiety and boredom during grooming','Use with wet food, peanut butter, or frozen yogurt','Non-slip silicone base'],
    seller_keywords:['dog lick mat','slow feeder bowl'],
  });
  const joint = core.buildProductContext({
    asin:'B003ULL1NQ',
    title:'Cosequin Joint Health Supplement for Dogs',
    bullets:['Glucosamine, chondroitin and MSM support mobility','Chewable tablets for senior dogs'],
    seller_keywords:['dog joint supplement','canine mobility chews'],
  });
  const lickMap = core.buildConversationMap([lick]);
  const jointMap = core.buildConversationMap([joint]);
  assert.equal(lickMap.target_species,'dog');
  assert.equal(jointMap.target_species,'dog');
  assert.ok(lickMap.semantic_terms.some(term=>/lick bowl/i.test(term)));
  assert.ok(lickMap.semantic_terms.some(term=>/anxiety|grooming/i.test(term)));
  assert.equal(lickMap.semantic_terms.some(term=>/glucosamine|joint health/i.test(term)),false);
  assert.ok(jointMap.semantic_terms.some(term=>/glucosamine|joint health/i.test(term)));
  assert.equal(jointMap.semantic_terms.some(term=>/lick bowl|peanut butter/i.test(term)),false);
});

test('generic query families cover product semantics without product-specific templates', () => {
  const context = core.buildProductContext({
    asin:'B0HMGGX71C', title:'Dog Lick Bowl Slow Feeder',
    bullets:['Silicone non-slip bowl for grooming and anxiety relief','Serve wet food and frozen treats'],
    seller_keywords:['dog enrichment feeder','lick mat alternative'],
  });
  const rows = core.buildProductQueries([context]);
  const families = new Set(rows.map(row=>row.query_family));
  for (const family of ['product','category','attribute','use_case','problem','effect','component','purchase_intent','alternative']) {
    assert.ok(families.has(family), family);
  }
  assert.ok(rows.every(row => row.query.toLowerCase().includes('lick') || row.query.toLowerCase().includes('dog')));
});

test('generic relevance rejects wrong species, cross-category drift and unrelated ASMR', () => {
  const map = core.buildConversationMap([core.buildProductContext({
    asin:'B0HMGGX71C', title:'Dog Lick Bowl Slow Feeder',
    bullets:['For anxiety relief and wet food enrichment'], seller_keywords:['dog lick mat'],
  })]);
  assert.equal(core.scoreVideoRelevance({title:'Dog lick bowl slow feeder review'},map).relevant,true);
  assert.equal(core.scoreVideoRelevance({title:'Cat water fountain review'},map).relevant,false);
  assert.equal(core.scoreVideoRelevance({title:'Human bowl licking ASMR compilation'},map).relevant,false);
});

test('video relevance does not promote unrelated comments', () => {
  const map = {direct_terms:['acme feeder'],competitive_terms:['beta feeder'],need_terms:['slow eating']};
  assert.equal(core.scoreVideoRelevance({title:'Acme Feeder review'},map).relevant,true);
  assert.equal(core.classifyCommentRelevance({body:'great camera work'},map).relevance_tier,'irrelevant');
});

test('animal product video audit rejects wrong species and human-use drift', () => {
  const map = {direct_terms:['aquapurr fountain'],category_terms:['cat water fountain'],competitive_terms:[],need_terms:['quiet drinking water'],target_species:'cat'};
  assert.equal(core.scoreVideoRelevance({title:'AquaPurr cat water fountain review'},map).relevant,true);
  assert.equal(core.scoreVideoRelevance({title:'Horse automatic water feeder review'},map).relevant,false);
  assert.equal(core.scoreVideoRelevance({title:'Human desktop drinking fountain'},map).relevant,false);
});

test('semantic tiers are explainable', () => {
  const map = {direct_terms:['acme feeder'],competitive_terms:['beta feeder'],need_terms:['slow eating']};
  assert.equal(core.classifyCommentRelevance({body:'Acme Feeder helped'},map).relevance_tier,'direct_product');
  assert.equal(core.classifyCommentRelevance({body:'Beta Feeder was cheaper'},map).relevance_tier,'competitive_context');
  const need = core.classifyCommentRelevance({body:'Slow eating solved the mess'},map);
  assert.equal(need.relevance_tier,'unmet_need');
  assert.ok(need.semantic_link && need.evidence_reason && need.confidence > 0);
});

test('species-aware unmet needs require the current product species', () => {
  const map = {direct_terms:['aquapurr'],competitive_terms:['beta fountain'],need_terms:['quiet drinking water'],target_species:'cat'};
  assert.equal(core.classifyCommentRelevance({body:'My cat finally has quiet drinking water'},map).relevance_tier,'unmet_need');
  assert.equal(core.classifyCommentRelevance({body:'People need quiet drinking water'},map).relevance_tier,'irrelevant');
  assert.equal(core.classifyCommentRelevance({body:'Beta fountain worked better for my cat'},map).relevance_tier,'competitive_context');
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

test('resume merges only new expanded keywords and never replays completed queries', () => {
  const cp = core.migrateCheckpoint({trusted_comment_count:2,discovery_round:1,query_plan:[
    {query:'q1',discovery_round:1,executed:true},{query:'q2',discovery_round:1,executed:true},
  ]});
  const added = core.mergeResumeQueries(cp,[
    {query:'q2',asins:['B0HMGGX71C']},
    {query:'dog lick bowl frozen treats',asins:['B0HMGGX71C']},
  ]);
  assert.equal(added,1);
  assert.deepEqual(cp.query_plan.slice(0,2).map(row=>row.executed),[true,true]);
  assert.equal(cp.query_plan.at(-1).executed,false);
  assert.equal(cp.query_plan.at(-1).discovery_round,2);
  assert.equal(core.requeueQueriesForResume(cp,20),0);
});

test('resume skips completed videos and preserves candidate pool', () => {
  const cp = core.migrateCheckpoint({candidate_pool:[{video_id:'new'}],video_audits:{done:'PASS',blocked:'BLOCKED'}});
  assert.equal(cp.candidate_pool.length,1);
  assert.equal(core.shouldVisitVideo(cp,'done'),false);
  assert.equal(core.shouldVisitVideo(cp,'blocked'),false);
  assert.equal(core.shouldVisitVideo(cp,'new'),true);
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
  const map = {products:[{brand:'Acme Feeder'}],direct_terms:['acme feeder']};
  const rows = core.deriveEvidenceQueries([{video_id:'v1',comment_id:'c1',body:'Acme Feeder took three weeks to help with slow eating',relevance_tier:'direct_product',matched_asins:['A']}],2,[],map);
  assert.ok(rows.length);
  assert.match(rows[0].query,/acme feeder/i);
  assert.equal(rows[0].generation_source,'youtube_comment');
  assert.deepEqual(rows[0].source_video_ids,['v1']);
  assert.deepEqual(rows[0].evidence_comment_ids,['c1']);
  assert.equal(rows[0].discovery_round,2);
});

test('evidence query discovery rejects promotional and unanchored drift', () => {
  const map = {products:[{brand:'Acme Feeder'}],direct_terms:['acme feeder']};
  const rows = core.deriveEvidenceQueries([
    {video_id:'v1',comment_id:'c1',body:'link to the product featured in this video',relevance_tier:'direct_product'},
    {video_id:'v2',comment_id:'c2',body:'check out the full review https://example.com',relevance_tier:'direct_product'},
    {video_id:'v3',comment_id:'c3',body:'Unrelated Brand product review',relevance_tier:'direct_product'},
    {video_id:'v4',comment_id:'c4',body:'Acme Feeder helped slow eating after three weeks',relevance_tier:'direct_product'},
  ],2,[],map);
  assert.equal(rows.length,1);
  assert.match(rows[0].query,/acme feeder/i);
  assert.doesNotMatch(rows[0].query,/https|check out|link to/i);
});

test('stop conditions require consecutive empty product rounds before exhaustion', () => {
  assert.equal(core.evaluateStop({trusted:20,targetComments:20}).stop_reason,'target_comments_reached');
  assert.equal(core.evaluateStop({trusted:1,targetComments:20,rounds:[{new_collected:0}],minNew:2}).stop,false);
  assert.equal(core.evaluateStop({trusted:1,targetComments:20,rounds:[{new_collected:0},{new_collected:0}],minNew:2}).stop_reason,'product_query_exhausted');
  assert.equal(core.evaluateStop({trusted:1,targetComments:20,rounds:[{new_collected:0,duplicate_rate:.9},{new_collected:0,duplicate_rate:.95}],duplicateRateStop:.8}).stop_reason,'product_query_exhausted');
  assert.equal(core.evaluateStop({trusted:1,targetComments:20,inspectedVideos:10,maxVideos:10}).stop_reason,'max_videos_reached');
});

test('new candidate priority favors likely-comment-rich relevant videos', () => {
  const rows = core.prioritizeVideos([
    {video_id:'short',search_position:1,title:'Dog lick bowl review',search_metadata:['12 views']},
    {video_id:'popular',search_position:4,title:'Dog lick bowl review and tutorial',search_metadata:['120K views']},
  ]);
  assert.equal(rows[0].video_id,'popular');
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
