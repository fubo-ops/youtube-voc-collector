#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const core = require('./youtube_voc_core.cjs');
const collector = require('./youtube_playwright_collector.cjs');

const USAGE = `USAGE:
  node scripts/rebuild_raw_collection.cjs --source-dir DIR --out-dir DIR --asin ASIN [--excel-name FILE.xlsx]

Rebuilds the raw collection layer from saved comment trees and legacy comment JSONL files.
It performs only stable-ID/exact-fallback technical deduplication.`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') return {help:true};
    if (!token.startsWith('--')) continue;
    out[token.slice(2)] = argv[i + 1]; i += 1;
  }
  return out;
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function files(dir) { return (await fs.readdir(dir,{withFileTypes:true})).filter(x=>x.isFile()).map(x=>path.join(dir,x.name)); }
async function allFiles(dir) {
  const out=[];
  for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if (entry.isDirectory()) out.push(...await allFiles(file)); else if (entry.isFile()) out.push(file);
  }
  return out;
}
async function readJsonl(file) { return (await fs.readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse); }
async function latest(dir, suffix) {
  const matches=(await files(dir)).filter(file=>file.endsWith(suffix));
  const stats=await Promise.all(matches.map(async file=>({file,time:(await fs.stat(file)).mtimeMs})));
  return stats.sort((a,b)=>b.time-a.time)[0]?.file;
}

async function readRecoverableComments(sourceDir) {
  const rows=[];
  const evidence=path.join(sourceDir,'evidence');
  if (await exists(evidence)) {
    for (const entry of await fs.readdir(evidence,{withFileTypes:true})) {
      if (!entry.isDirectory()) continue;
      const file=path.join(evidence,entry.name,'comment_tree.json');
      if (!await exists(file)) continue;
      const value=JSON.parse(await fs.readFile(file,'utf8'));
      if (Array.isArray(value)) rows.push(...value);
    }
  }
  for (const file of await allFiles(sourceDir)) {
    if (!/_(?:raw_comments|trusted_comments|partial_candidates)\.jsonl$/i.test(file)) continue;
    rows.push(...await readJsonl(file));
  }
  return rows.filter(row=>(row.source_specific?.record_type || row.record_type || 'comment') === 'comment');
}

async function main() {
  const args=parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }
  for (const key of ['source-dir','out-dir','asin']) if (!args[key]) throw Error(`Missing required option: --${key}`);
  const sourceDir=path.resolve(args['source-dir']), outDir=path.resolve(args['out-dir']), asin=args.asin.toUpperCase();
  await fs.mkdir(outDir,{recursive:true});
  const captured=await readRecoverableComments(sourceDir);
  const normalized=captured.map(row=>({
    ...row,
    record_type:'comment',
    source_parent_id:row.source_parent_id || `video:${row.video_id || row.source_specific?.video_id}`,
    amazon_asins:row.amazon_asins || row.matched_asins || row.source_specific?.amazon_asins || [],
    matched_query:row.matched_query || row.query || row.query_context?.query || '',
    keyword_sources:row.keyword_sources || row.source_specific?.keyword_sources || row.query_context?.filters?.keyword_sources || [],
    comment_text:row.comment_text ?? row.body ?? row.content?.text ?? '',
    published_at:row.published_at ?? row.created_at_or_visible_time ?? row.source_specific?.comment_time_text ?? null,
    source_specific:{...(row.source_specific || {}),record_type:'comment'},
  }));
  const comments=core.mergeComments(normalized);
  const technicalDuplicates=normalized.length-comments.length;
  const mainCount=comments.filter(row=>!row.parent_comment_id).length;
  const replyCount=comments.length-mainCount;
  const querySource=await latest(sourceDir,'_query_plan.json');
  const manifestSource=await latest(sourceDir,'_manifest.json');
  const queryPlan=querySource ? JSON.parse(await fs.readFile(querySource,'utf8')) : {schema_version:'youtube_query_plan_v2',asins:[asin],queries:[]};
  const legacy=manifestSource ? JSON.parse(await fs.readFile(manifestSource,'utf8')) : {};
  const prefix=`${asin}_youtube_voc_raw_comments`;
  const output={
    jsonl:path.join(outDir,`${prefix}.jsonl`), csv:path.join(outDir,`${prefix}.csv`),
    query:path.join(outDir,`${asin}_youtube_voc_query_plan.json`), manifest:path.join(outDir,`${asin}_youtube_voc_raw_manifest.json`),
    excel:path.join(outDir,args['excel-name'] || `${prefix}.xlsx`),
  };
  const gate=collector.qualityGate(comments,legacy.deduplicated_video_count || legacy.search_candidate_count || 1);
  const manifest={...legacy,schema_version:'youtube_manifest_v3_raw',collection_layer:'raw',asins:legacy.asins || [asin],rebuilt_at:new Date().toISOString(),source_directory:sourceDir,raw_captured_count:normalized.length,technical_duplicate_count:technicalDuplicates,final_collected_count:comments.length,main_comment_count:mainCount,reply_count:replyCount,video_record_count:0,comment_count:comments.length,record_count:comments.length,quality_checks:[gate],validate_result:gate.decision,files:Object.values(output)};
  delete manifest.trusted_comment_count; delete manifest.partial_comment_count; delete manifest.target_comments_complete;
  await Promise.all([
    fs.writeFile(output.jsonl,comments.map(JSON.stringify).join('\n')+(comments.length?'\n':''),'utf8'),
    fs.writeFile(output.csv,collector.recordsToCsv(comments),'utf8'),
    fs.writeFile(output.query,JSON.stringify(queryPlan,null,2)+'\n','utf8'),
    fs.writeFile(output.manifest,JSON.stringify(manifest,null,2)+'\n','utf8'),
  ]);
  await collector.buildExcelOutput({jsonlPath:output.jsonl,queryPlanPath:output.query,manifestPath:output.manifest,excelPath:output.excel});
  console.log(JSON.stringify({raw_captured_count:normalized.length,technical_duplicate_count:technicalDuplicates,final_collected_count:comments.length,main_comment_count:mainCount,reply_count:replyCount,video_record_count:0,files:output},null,2));
}

if (require.main === module) main().catch(error=>{console.error(error.stack || error);console.error(USAGE);process.exit(1);});
module.exports={readRecoverableComments};
