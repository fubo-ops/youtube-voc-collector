#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const ASIN_RE = /^[A-Z0-9]{10}$/;
const BROAD = new Set(['dog','dogs','joint','joints','pet','pets']);
const BLOCKED = new Set(['captcha','login_required','age_restricted','region_restricted','rate_limited','access_denied','member_only','private_video']);

function unique(values) {
  const seen = new Set();
  return (values || []).filter(value => {
    const key = String(value ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function parseAsinInputs({asin, asins, asinFile} = {}) {
  const values = [asin, asins];
  if (asinFile) values.push(fs.readFileSync(path.resolve(asinFile), 'utf8'));
  const out = unique(values.flatMap(value => String(value || '').split(/[\s,;]+/)).map(x => x.toUpperCase()));
  if (!out.length) throw Error('At least one ASIN is required.');
  for (const value of out) if (!ASIN_RE.test(value)) throw Error(`Invalid ASIN: ${value}`);
  return out;
}

function keywordSignature(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/)
    .map(word => word.length > 4 && word.endsWith('s') ? word.slice(0,-1) : word).join(' ');
}

function cleanKeywordPlan(values, sources = {}) {
  const seen = new Set(), out = [];
  for (const raw of values || []) {
    const cleaned = String(raw || '').replace(/\s+/g,' ').trim();
    if (!cleaned || BROAD.has(cleaned.toLowerCase())) continue;
    const signature = keywordSignature(cleaned);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    out.push({raw_keyword:raw, cleaned_keyword:cleaned, keyword_sources:unique(sources[raw] || [])});
  }
  return out;
}

function dedupeVideos(rows) {
  const map = new Map();
  for (const source of rows || []) {
    if (!source.video_id) continue;
    const row = map.get(source.video_id) || {...source, matched_queries:[], matched_keywords:[], matched_asins:[]};
    row.matched_queries = unique([...row.matched_queries, source.matched_query, ...(source.matched_queries || [])]);
    row.matched_keywords = unique([...row.matched_keywords, ...(source.matched_keywords || [])]);
    row.matched_asins = unique([...row.matched_asins, ...(source.matched_asins || source.asins || [])]);
    map.set(source.video_id,row);
  }
  return [...map.values()];
}

function flattenCommentTree(nodes, videoId, parent = null, depth = 0, out = []) {
  for (const source of nodes || []) {
    const row = {...source, parent_comment_id:parent, depth, source_parent_id:`video:${videoId}`};
    delete row.replies; out.push(row);
    flattenCommentTree(source.replies, videoId, source.comment_id, depth + 1, out);
  }
  return out;
}

function isValidComment(row) {
  const body = String(row?.body ?? row?.content?.text ?? '').trim();
  return Boolean(body) && !/^\[(?:deleted|removed)\]$/i.test(body);
}

function isReplyExpansionLabel(value) {
  const text = String(value || '').replace(/\s+/g,' ').trim();
  if (!text || /^(?:reply|回复)$/i.test(text)) return false;
  return /\b(?:view|show|more)?\s*\d+\s+repl(?:y|ies)\b|\b(?:view|show|load)\s+(?:more\s+)?repl(?:y|ies)\b|(?:查看|展开|显示|加载)?\s*\d+\s*条?回复|更多回复/i.test(text);
}

function mergeComments(rows) {
  const out = [], seen = new Map();
  for (const source of rows || []) {
    if (!isValidComment(source)) continue;
    const stableId = String(source.comment_id || source.source_item_id || '').trim();
    const body = String(source.body ?? source.content?.text ?? '');
    const videoId = String(source.video_id || source.source_specific?.video_id || '').trim();
    const author = String(source.author?.display_name || source.author?.handle || source.author || '').trim();
    const fallback = !stableId && videoId && body ? `fallback:${videoId}\u0000${author}\u0000${body}` : '';
    const key = stableId ? `id:${stableId}` : fallback;
    const prior = key ? seen.get(key) : null;
    if (prior) {
      prior.matched_keywords = unique([...(prior.matched_keywords || []), ...(source.matched_keywords || []), source.query]);
      prior.matched_asins = unique([...(prior.matched_asins || []), ...(source.matched_asins || [])]);
      prior.matched_queries = unique([...(prior.matched_queries || []), ...(source.matched_queries || []), source.query]);
      continue;
    }
    const row = {...source, matched_keywords:unique(source.matched_keywords || []), matched_asins:unique(source.matched_asins || [])};
    out.push(row); if (key) seen.set(key,row);
  }
  return out;
}

function matchingTerms(text, terms) {
  const lower = String(text || '').toLowerCase();
  return unique((terms || []).filter(term => lower.includes(String(term).toLowerCase())));
}

function buildConversationMap(productContexts = []) {
  const words = value => String(value || '').toLowerCase().replace(/[^a-z0-9\s-]/g,' ').split(/\s+/).filter(word => word.length > 2 && !BROAD.has(word));
  const products = productContexts.map(context => {
    const titleWords = words(context.product_title || context.title);
    const brand = context.brand || titleWords.slice(0,2).join(' ');
    const productNames = unique([context.product_title || context.title, ...((context.common_product_names || []))]);
    const functions = unique([...(context.primary_functions || []),...(context.user_problems || []),...(context.pain_points || [])]);
    return {asin:context.asin,product_title:context.product_title || context.title || null,brand,category:context.category || null,common_product_names:productNames,core_attributes:context.core_attributes || context.bullets || [],primary_functions:functions,ingredients_or_components:context.ingredients_or_components || [],use_cases:context.use_cases || [],user_problems:context.user_problems || [],pain_points:context.pain_points || [],competing_products:context.competing_products || [],amazon_status:context.status || context.amazon_status || 'available',amazon_login_status:context.amazon_login_status || 'not_required',sellersprite_status:context.seller_status || 'unavailable',sellersprite_extension_status:context.sellersprite_extension_status || 'not_used',sellersprite_missing_reason:context.seller_note || null};
  });
  const corpus = products.map(p=>`${p.product_title || ''} ${(p.core_attributes || []).join(' ')}`).join(' ').toLowerCase();
  const targetSpecies = /\bdogs?\b/.test(corpus) ? 'dog' : /\bcats?\b/.test(corpus) ? 'cat' : null;
  const titleNeeds = targetSpecies === 'dog' ? ['dog mobility','senior dog','dog arthritis','dog joint','joint pain','hip pain','knee pain','stiffness','stiff','limping','limp','climb stairs','stairs','acl','cruciate','glucosamine','chondroitin','msm','side effects','dosage'] : [];
  const directTerms = unique(products.flatMap(p=>{
    const brand=String(p.brand || '').trim(), brandWords=brand.split(/\s+/).filter(Boolean);
    return [brand,brandWords.at(-1),...p.common_product_names].filter(Boolean);
  }));
  return {schema_version:'youtube_conversation_map_v1',products,direct_terms:directTerms,competitive_terms:unique(products.flatMap(p=>p.competing_products)),need_terms:unique([...products.flatMap(p=>[...p.primary_functions,...p.use_cases,...p.user_problems,...p.pain_points]),...titleNeeds]),target_species:targetSpecies,created_at:new Date().toISOString()};
}

function scoreVideoRelevance(video, map) {
  const text = `${video.title || ''} ${video.description || ''}`;
  const title = String(video.title || '');
  const direct = matchingTerms(text,map.direct_terms), competitive = matchingTerms(text,map.competitive_terms), need = matchingTerms(text,map.need_terms);
  const lowerTitle = title.toLowerCase();
  const mismatch = map.target_species === 'dog' && /\b(?:horse|equine|human|men|women|cat|feline)\b/.test(lowerTitle) && !/\bdogs?\b/.test(lowerTitle);
  const speciesContext = map.target_species !== 'dog' || /\bdogs?\b/.test(lowerTitle);
  const hits = unique([...direct,...competitive,...need]);
  const relevant = !mismatch && (direct.length > 0 || (speciesContext && (competitive.length > 0 || need.length > 0)));
  return {relevant,relevance_score:relevant?Math.min(1,hits.length / 3):0,evidence_terms:hits,rejection_reason:mismatch?'species_mismatch':relevant?'matched_semantics':'missing_product_or_species_anchor'};
}

function classifyCommentRelevance(comment, map) {
  const body = comment.body ?? comment.content?.text ?? '';
  const direct = matchingTerms(body,map.direct_terms), competitive = matchingTerms(body,map.competitive_terms), need = matchingTerms(body,map.need_terms);
  const speciesContext = map.target_species !== 'dog' || /\b(?:dog|dogs|puppy|pup|canine)\b/i.test(body);
  const [tier,hits,link] = direct.length ? ['direct_product',direct,'explicit product or brand mention']
    : competitive.length && speciesContext ? ['competitive_context',competitive,'same-category alternative or comparison']
    : need.length && speciesContext ? ['unmet_need',need,'product-relevant dog problem or use context'] : ['irrelevant',[],'no supported semantic link'];
  return {relevance_tier:tier, semantic_link:link, evidence_reason:hits.length ? `matched: ${hits.join(', ')}` : 'no relevant evidence term', confidence:hits.length ? Math.min(.98,.55 + hits.length * .12) : 0};
}

function partitionRecords(rows) {
  const result = {trusted:[],partial:[],blocked:[],excluded:[]};
  for (const row of mergeComments(rows)) {
    if (row.relevance_tier === 'irrelevant' || !isValidComment(row)) result.excluded.push(row);
    else if (row.audit_status === 'PASS') result.trusted.push(row);
    else if (row.audit_status === 'PARTIAL') result.partial.push(row);
    else if (row.audit_status === 'BLOCKED') result.blocked.push(row);
    else result.excluded.push(row);
  }
  return result;
}
function reconcileVideoAudits(rows, audits = {}) {
  return mergeComments((rows || []).map(row => {
    const status = audits[row.video_id || row.source_specific?.video_id] || row.audit_status;
    return {...row,audit_status:status,source_specific:{...(row.source_specific || {}),audit_status:status}};
  }));
}

function countTrustedUnique(rows) { return partitionRecords(rows).trusted.length; }

function emptyCheckpoint() {
  return {schema_version:'youtube_checkpoint_v2_raw',input_asins:[],product_contexts:[],query_plan:[],searched_queries:[],completed_video_ids:[],partial_video_ids:[],blocked_video_ids:[],collected_comment_ids:[],expanded_reply_controls:[],incomplete_frontier:[],discovery_round:1,raw_captured_count:0,technical_duplicate_count:0,final_collected_count:0,duplicate_count:0,filtered_count:0,stop_reason:null,video_audits:{},updated_at:new Date().toISOString()};
}
function migrateCheckpoint(value = {}) { return {...emptyCheckpoint(),...value,video_audits:{...(value.video_audits || {})}}; }
function loadCheckpoint(file) { return migrateCheckpoint(JSON.parse(fs.readFileSync(file,'utf8'))); }
function saveCheckpoint(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
  const temp = `${file}.tmp`; const data = {...migrateCheckpoint(value),updated_at:new Date().toISOString()};
  fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n','utf8'); fs.renameSync(temp,file); return data;
}
function shouldVisitVideo(checkpoint, videoId, options = {}) {
  const status = checkpoint?.video_audits?.[videoId];
  if (status === 'PASS' || status === 'BLOCKED') return false;
  if (status === 'PARTIAL') return Boolean(options.retryPartial || options.forceReauditPartial);
  return true;
}
function requeueQueriesForResume(checkpoint, targetComments) {
  if (!checkpoint || Number(checkpoint.final_collected_count ?? checkpoint.trusted_comment_count ?? 0) >= Number(targetComments)) return 0;
  if ((checkpoint.candidate_pool || []).length) return 0;
  const plan = checkpoint.query_plan || [];
  let round = Number(checkpoint.discovery_round || 1);
  if (!plan.some(row => Number(row.discovery_round || 1) === round)) {
    round = Math.max(1,...plan.filter(row=>row.executed).map(row=>Number(row.discovery_round || 1)));
    checkpoint.discovery_round = round;
  }
  const rows = plan.filter(row => Number(row.discovery_round || 1) === round && row.executed);
  if (!rows.length || plan.some(row => Number(row.discovery_round || 1) === round && !row.executed)) return 0;
  rows.forEach(row => { row.executed = false; row.resume_replay = true; });
  checkpoint.resume_replayed_queries = true;
  return rows.length;
}

function shouldCircuitBreak(state) { return BLOCKED.has(state); }
function auditVideo(facts = {}) {
  if (shouldCircuitBreak(facts.access_state) || facts.access_state === 'comments_unavailable') return {audit_status:'BLOCKED',reason:facts.access_state};
  if (!facts.relevant) return {audit_status:'BLOCKED',reason:'irrelevant_video'};
  if (facts.remaining_reply_controls > 0 || facts.orphan_count > 0 || (facts.stagnant_rounds ?? 0) < 3) return {audit_status:'PARTIAL',reason:'incomplete_frontier'};
  return {audit_status:'PASS',reason:'visible_frontier_exhausted'};
}

async function runPreflight(probes) {
  const result = {};
  for (const name of ['amazon','seller','youtube','video','comments']) result[name] = await probes[name]();
  result.ready = ['amazon','youtube','video','comments'].every(name => result[name] === 'ready');
  result.formal_collection_started = false;
  return result;
}

function deriveEvidenceQueries(comments, round, existing = [], conversationMap = {}) {
  const used = new Set((existing || []).map(x => String(x.query || x).toLowerCase())), out = [];
  const anchors = unique((conversationMap.products || []).flatMap(product => {
    const brand = String(product.brand || '').trim();
    const brandWords = brand.split(/\s+/).filter(word => word.length >= 5);
    return [brand, brandWords.slice(-2).join(' '), ...brandWords.slice(-1)];
  }).filter(Boolean)).sort((a,b) => b.length-a.length);
  const stop = new Set(['the','and','with','this','that','from','have','been','were','your','their','after','before','into','for','my','our','its','product','video','review']);
  for (const row of comments || []) {
    if (row.relevance_tier === 'irrelevant') continue;
    const original = String(row.body || '');
    if (/https?:\/\/|www\.|\blink to\b|\bcheck out\b|\bsubscribe\b|\bfeatured in this video\b/i.test(original)) continue;
    const anchor = anchors.find(value => original.toLowerCase().includes(value.toLowerCase()));
    if (!anchor) continue;
    const anchorTokens = new Set(anchor.toLowerCase().split(/\s+/));
    const words = original.toLowerCase().replace(/[^a-z0-9\s-]/g,' ').split(/\s+/)
      .filter(word => word.length > 2 && !stop.has(word) && !anchorTokens.has(word));
    const query = unique([anchor,...words.slice(0,5)]).join(' ').trim();
    if (query.split(/\s+/).length < 2) continue;
    if (used.has(query)) continue; used.add(query);
    out.push({query,query_family:row.relevance_tier || 'observed_language',generation_source:'youtube_comment',source_video_ids:unique([row.video_id]),evidence_comment_ids:unique([row.comment_id]),matched_asins:unique(row.matched_asins || []),semantic_link:row.semantic_link || 'observed YouTube wording',discovery_round:round,priority:80,executed:false,videos_found:0,trusted_comments_found:0,marginal_yield:0});
  }
  return out;
}

function evaluateStop({trusted=0,targetComments=Infinity,rounds=[],maxRounds=Infinity,minNew=0,duplicateRateStop=1,inspectedVideos=0,maxVideos=Infinity,accessState,userStopped=false} = {}) {
  if (userStopped) return {stop:true,stop_reason:'user_stopped'};
  if (shouldCircuitBreak(accessState)) return {stop:true,stop_reason:`access_${accessState}`};
  if (trusted >= targetComments) return {stop:true,stop_reason:'target_comments_reached'};
  if (inspectedVideos >= maxVideos) return {stop:true,stop_reason:'max_videos_reached'};
  if (rounds.length >= maxRounds) return {stop:true,stop_reason:'max_discovery_rounds'};
  const last = rounds.slice(-2);
  if (last.length === 2 && last.every(x => Number(x.new_trusted || 0) < minNew)) return {stop:true,stop_reason:'low_marginal_yield'};
  if (last.length === 2 && last.every(x => Number(x.duplicate_rate || 0) >= duplicateRateStop)) return {stop:true,stop_reason:'duplicate_saturation'};
  return {stop:false,stop_reason:null};
}

module.exports = {auditVideo,buildConversationMap,classifyCommentRelevance,cleanKeywordPlan,countTrustedUnique,dedupeVideos,deriveEvidenceQueries,emptyCheckpoint,evaluateStop,flattenCommentTree,isReplyExpansionLabel,isValidComment,loadCheckpoint,mergeComments,migrateCheckpoint,parseAsinInputs,partitionRecords,reconcileVideoAudits,requeueQueriesForResume,runPreflight,saveCheckpoint,scoreVideoRelevance,shouldCircuitBreak,shouldVisitVideo,unique};
