#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const ASIN_RE = /^[A-Z0-9]{10}$/;
const BROAD = new Set(['product','products','item','items','review','reviews','best','buy']);
const BLOCKED = new Set(['captcha','login_required','age_restricted','region_restricted','rate_limited','access_denied','member_only','private_video']);
const STOP_WORDS = new Set(['a','an','and','are','as','at','be','by','for','from','in','is','it','of','on','or','the','this','to','with','your']);
const SPECIES = {
  dog:/\b(?:dog|dogs|puppy|puppies|pup|canine)\b/i,
  cat:/\b(?:cat|cats|kitten|kittens|feline)\b/i,
  horse:/\b(?:horse|horses|equine)\b/i,
  human:/\b(?:human|humans|men|women|people|person)\b/i,
};

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
    const row = map.get(source.video_id) || {...source, matched_queries:[], matched_keywords:[], matched_asins:[], keyword_sources:[]};
    row.matched_queries = unique([...row.matched_queries, source.matched_query, ...(source.matched_queries || [])]);
    row.matched_keywords = unique([...row.matched_keywords, ...(source.matched_keywords || [])]);
    row.matched_asins = unique([...row.matched_asins, ...(source.matched_asins || source.asins || [])]);
    row.keyword_sources = unique([...row.keyword_sources, ...(source.keyword_sources || [])]);
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

function phrases(values, pattern) {
  return unique((values || []).map(value=>String(value || '').replace(/\s+/g,' ').trim()).filter(value=>value && (!pattern || pattern.test(value))));
}

function inferSpecies(text) {
  return Object.entries(SPECIES).find(([,pattern])=>pattern.test(String(text || '')))?.[0] || null;
}

function compact(value, maxWords = 8) {
  return String(value || '').replace(/[^a-z0-9&+/' -]+/gi,' ').replace(/\s+/g,' ').trim().split(/\s+/).slice(0,maxWords).join(' ');
}

function buildProductContext(raw = {}) {
  const title = compact(raw.product_title || raw.title || raw.asin, 12);
  const bullets = phrases(raw.core_attributes || raw.bullets || []);
  const sellerKeywords = phrases(raw.seller_keywords || []);
  const corpus = `${title} ${bullets.join(' ')} ${sellerKeywords.join(' ')}`;
  const meaningfulTitle = title.split(/\s+/).filter(word=>word.length > 1 && !STOP_WORDS.has(word.toLowerCase()));
  const productName = compact(raw.product_name || title, 7);
  const category = compact(raw.category || sellerKeywords.find(value=>value.split(/\s+/).length <= 5) || meaningfulTitle.slice(-4).join(' '),5);
  const useCases = phrases([...(raw.use_cases || []),...bullets],/\b(?:for|during|serve|serving|use|using|when|while|with)\b/i);
  const problems = phrases([...(raw.user_problems || []),...(raw.pain_points || []),...bullets],/\b(?:reduce|prevent|relief|anxiety|boredom|pain|stress|difficulty|slow|bloat|mess|problem)\w*\b/i);
  const effects = phrases([...(raw.primary_functions || []),...bullets],/\b(?:support|promot|improv|reduc|help|keep|encourag|protect|calm|engag)\w*\b/i);
  const components = phrases([...(raw.ingredients_or_components || []),...bullets],/\b(?:with|contain|ingredient|material|made of|construction|formula|base)\b/i);
  const attributes = unique([...(raw.core_attributes || []),...bullets,...sellerKeywords]).slice(0,24);
  const alternatives = unique([...(raw.competing_products || []),...sellerKeywords.filter(value=>/\b(?:vs|versus|alternative|compare|comparison)\b/i.test(value))]);
  const brand = compact(raw.brand || meaningfulTitle.slice(0,2).join(' '),4);
  return {
    ...raw,
    asin:raw.asin,
    title,
    product_title:title,
    product_name:productName,
    brand,
    category,
    target_species:raw.target_species || inferSpecies(corpus),
    common_product_names:unique([productName,title,...(raw.common_product_names || []),...sellerKeywords.slice(0,4)]),
    core_attributes:attributes,
    primary_functions:effects,
    ingredients_or_components:components,
    use_cases:useCases,
    user_problems:problems,
    pain_points:unique([...(raw.pain_points || []),...problems]),
    competing_products:alternatives,
    purchase_intents:unique([...(raw.purchase_intents || []),'review','best','worth it','price','where to buy']),
    seller_keywords:sellerKeywords,
  };
}

function buildProductQueries(productContexts = []) {
  const out = [], seen = new Set();
  const add = (context, family, phrase, suffix='') => {
    const anchor = compact(context.product_name || context.product_title || context.asin,3);
    const value = compact(phrase,5);
    const query = compact(`${anchor} ${suffix} ${keywordSignature(value) === keywordSignature(anchor) ? '' : value}`,12);
    const key = keywordSignature(query);
    if (!query || seen.has(key)) return;
    seen.add(key);
    out.push({query,query_family:family,dimension:family,generation_source:'product_context',source_video_ids:[],evidence_comment_ids:[],matched_asins:[context.asin].filter(Boolean),asins:[context.asin].filter(Boolean),keyword_sources:[`product_context:${family}`],semantic_link:`${family} from Amazon/SellerSprite product context`,priority:90,executed:false,videos_found:0,marginal_yield:0});
  };
  for (const source of productContexts) {
    const context = buildProductContext(source);
    for (const suffix of ['review','demo','how to use','customer experience']) add(context,'product',context.product_name,suffix);
    for (const suffix of ['review','best options','comparison']) add(context,'category',context.category,suffix);
    for (const value of (context.core_attributes.length?context.core_attributes:[context.category]).slice(0,4)) add(context,'attribute',value,'feature review');
    for (const value of (context.use_cases.length?context.use_cases:[context.category]).slice(0,4)) add(context,'use_case',value,'how to use');
    for (const value of (context.user_problems.length?context.user_problems:[context.category]).slice(0,4)) add(context,'problem',value,'problem solution');
    for (const value of (context.primary_functions.length?context.primary_functions:[context.category]).slice(0,4)) add(context,'effect',value,'benefits results');
    for (const value of (context.ingredients_or_components.length?context.ingredients_or_components:[context.category]).slice(0,4)) add(context,'component',value,'materials ingredients');
    for (const intent of context.purchase_intents.slice(0,6)) add(context,'purchase_intent',intent,'buying guide');
    for (const value of (context.competing_products.length?context.competing_products:[context.category]).slice(0,3)) add(context,'alternative',value,'alternatives comparison');
    for (const keyword of context.seller_keywords.slice(0,12)) add(context,'seller_keyword',keyword);
  }
  return out;
}

function buildConversationMap(productContexts = []) {
  const products = productContexts.map(buildProductContext);
  const targetSpecies = unique(products.map(p=>p.target_species).filter(Boolean))[0] || null;
  const directTerms = unique(products.flatMap(p=>{
    const brand=String(p.brand || '').trim(), brandWords=brand.split(/\s+/).filter(Boolean);
    return [brand,brandWords.length > 1 ? brandWords.at(-1) : null,...p.common_product_names].filter(Boolean);
  }));
  const categoryTerms = unique(products.flatMap(p=>[p.category,...p.seller_keywords].filter(Boolean)));
  const needTerms = unique(products.flatMap(p=>[...p.primary_functions,...p.use_cases,...p.user_problems,...p.pain_points,...p.ingredients_or_components]));
  return {schema_version:'youtube_conversation_map_v2',products,direct_terms:directTerms,category_terms:categoryTerms,competitive_terms:unique(products.flatMap(p=>p.competing_products)),need_terms:needTerms,semantic_terms:unique([...directTerms,...categoryTerms,...needTerms]),target_species:targetSpecies,created_at:new Date().toISOString()};
}

function scoreVideoRelevance(video, map) {
  const text = `${video.title || ''} ${video.description || ''}`;
  const title = String(video.title || '');
  const direct = matchingTerms(text,map.direct_terms), category = matchingTerms(text,map.category_terms), competitive = matchingTerms(text,map.competitive_terms), need = matchingTerms(text,map.need_terms);
  const lowerTitle = title.toLowerCase();
  const ownSpecies = map.target_species && SPECIES[map.target_species]?.test(lowerTitle);
  const mismatch = Boolean(map.target_species && Object.entries(SPECIES).some(([name,pattern])=>name !== map.target_species && pattern.test(lowerTitle)) && !ownSpecies);
  const asmrDrift = /\basmr\b/i.test(lowerTitle) && !/\b(?:review|how to|use|recipe|test|comparison)\b/i.test(lowerTitle);
  const speciesContext = !map.target_species || ownSpecies;
  const hits = unique([...direct,...category,...competitive,...need]);
  const relevant = !mismatch && !asmrDrift && (direct.length > 0 || (speciesContext && (category.length > 0 || competitive.length > 0 || need.length > 0)));
  const rejectionReason = mismatch?'species_mismatch':asmrDrift?'unrelated_asmr':relevant?'matched_semantics':'cross_category_or_missing_product_anchor';
  return {relevant,relevance_score:relevant?Math.min(1,hits.length / 3):0,evidence_terms:hits,rejection_reason:rejectionReason};
}

function classifyCommentRelevance(comment, map) {
  const body = comment.body ?? comment.content?.text ?? '';
  const direct = matchingTerms(body,map.direct_terms), competitive = matchingTerms(body,map.competitive_terms), need = matchingTerms(body,map.need_terms);
  const speciesContext = !map.target_species || !SPECIES[map.target_species] || SPECIES[map.target_species].test(body);
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
  return {schema_version:'youtube_checkpoint_v3_raw',input_asins:[],product_contexts:[],query_plan:[],candidate_pool:[],searched_queries:[],completed_video_ids:[],partial_video_ids:[],blocked_video_ids:[],collected_comment_ids:[],expanded_reply_controls:[],incomplete_frontier:[],discovery_round:1,raw_captured_count:0,technical_duplicate_count:0,final_collected_count:0,duplicate_count:0,filtered_count:0,stop_reason:null,video_audits:{},updated_at:new Date().toISOString()};
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
  void targetComments;
  return checkpoint ? 0 : 0;
}

function mergeResumeQueries(checkpoint, incoming = []) {
  const plan = checkpoint.query_plan || (checkpoint.query_plan=[]);
  const used = new Set(plan.map(row=>keywordSignature(row.query)));
  const pendingRounds = plan.filter(row=>!row.executed).map(row=>Number(row.discovery_round || 1));
  const nextRound = pendingRounds.length ? Math.min(...pendingRounds) : Math.max(Number(checkpoint.discovery_round || 1),...plan.map(row=>Number(row.discovery_round || 1))) + 1;
  let added = 0;
  for (const source of incoming) {
    const key = keywordSignature(source.query);
    if (!key || used.has(key)) continue;
    used.add(key); added += 1;
    plan.push({...source,discovery_round:nextRound,executed:false,videos_found:0,marginal_yield:0});
  }
  if (added) checkpoint.discovery_round = Math.min(Number(checkpoint.discovery_round || nextRound),nextRound);
  return added;
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
  const anchors = unique([...(conversationMap.direct_terms || []),...(conversationMap.category_terms || []),...(conversationMap.products || []).flatMap(product => {
    const brand = String(product.brand || '').trim();
    const brandWords = brand.split(/\s+/).filter(word => word.length >= 5);
    return [brand,product.product_name,product.category,...(product.common_product_names || []),brandWords.slice(-2).join(' '), ...brandWords.slice(-1)];
  })].filter(Boolean)).sort((a,b) => b.length-a.length);
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

function parseViews(values = []) {
  const text = (Array.isArray(values)?values:[values]).join(' ');
  const match = text.match(/([\d,.]+)\s*([KMB])?\s*views?/i);
  if (!match) return 0;
  const multiplier = {K:1e3,M:1e6,B:1e9}[String(match[2] || '').toUpperCase()] || 1;
  return Number(match[1].replace(/,/g,'')) * multiplier || 0;
}

function prioritizeVideos(rows = []) {
  return [...rows].sort((a,b)=>{
    const score = row => Math.log10(parseViews(row.search_metadata)+1) * 20 + (row.matched_queries?.length || 1) * 5 - Number(row.search_position || 99) / 10;
    return score(b)-score(a);
  });
}

function evaluateStop({trusted=0,targetComments=Infinity,rounds=[],maxRounds=Infinity,minNew=0,duplicateRateStop=1,inspectedVideos=0,maxVideos=Infinity,accessState,userStopped=false} = {}) {
  if (userStopped) return {stop:true,stop_reason:'user_stopped'};
  if (shouldCircuitBreak(accessState)) return {stop:true,stop_reason:`access_${accessState}`};
  if (trusted >= targetComments) return {stop:true,stop_reason:'target_comments_reached'};
  if (inspectedVideos >= maxVideos) return {stop:true,stop_reason:'max_videos_reached'};
  if (rounds.length >= maxRounds) return {stop:true,stop_reason:'max_discovery_rounds'};
  const last = rounds.slice(-2);
  if (last.length === 2 && last.every(x => Number(x.new_collected ?? x.new_trusted ?? 0) < minNew)) return {stop:true,stop_reason:'product_query_exhausted'};
  if (last.length === 2 && last.every(x => Number(x.duplicate_rate || 0) >= duplicateRateStop) && last.every(x=>Number(x.new_collected ?? x.new_trusted ?? 0) === 0)) return {stop:true,stop_reason:'product_query_exhausted'};
  return {stop:false,stop_reason:null};
}

module.exports = {auditVideo,buildConversationMap,buildProductContext,buildProductQueries,classifyCommentRelevance,cleanKeywordPlan,countTrustedUnique,dedupeVideos,deriveEvidenceQueries,emptyCheckpoint,evaluateStop,flattenCommentTree,isReplyExpansionLabel,isValidComment,loadCheckpoint,mergeComments,mergeResumeQueries,migrateCheckpoint,parseAsinInputs,partitionRecords,prioritizeVideos,reconcileVideoAudits,requeueQueriesForResume,runPreflight,saveCheckpoint,scoreVideoRelevance,shouldCircuitBreak,shouldVisitVideo,unique};
