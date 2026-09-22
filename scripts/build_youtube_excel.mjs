#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `USAGE
  node scripts/build_youtube_excel.mjs --jsonl RAW_COMMENTS.jsonl --query-plan QUERY_PLAN.json --manifest MANIFEST.json --output REPORT.xlsx

Required options:
  --jsonl PATH        Raw comment-only JSONL input
  --partial-jsonl PATH  Optional legacy comments input, merged into Raw_Comments
  --query-plan PATH   YouTube query plan JSON
  --manifest PATH     Collection manifest JSON
  --output PATH       Native Excel .xlsx output
  --help              Show this help and exit without loading artifact-tool`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    args[key] = value;
    i += 1;
  }
  for (const key of ["jsonl", "query-plan", "manifest", "output"]) {
    if (!args[key]) throw new Error(`Missing required option: --${key}`);
  }
  return args;
}

async function loadArtifactTool() {
  const candidates = [
    process.env.CODEX_ARTIFACT_TOOL_ENTRY,
    process.env.CODEX_ARTIFACT_NODE_MODULES && path.join(process.env.CODEX_ARTIFACT_NODE_MODULES, "@oai", "artifact-tool", "dist", "artifact_tool.mjs"),
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "@oai", "artifact-tool", "dist", "artifact_tool.mjs"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return import(pathToFileURL(candidate).href);
    } catch {
      // Try the next standalone runtime location.
    }
  }
  throw new Error("@oai/artifact-tool was not found. Set CODEX_ARTIFACT_NODE_MODULES to its node_modules directory.");
}

const valueAt = (record, ...paths) => {
  for (const parts of paths) {
    let value = record;
    for (const part of parts) value = value?.[part];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
};

const joined = (value) => Array.isArray(value) ? value.join(", ") : (value ?? "");
const cleanCell = (value) => typeof value === "string" ? value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "") : value;
const excelQuoted = (value) => String(value ?? "").replaceAll('"', '""');
const hyperlinkFormula = (url) => url ? `=HYPERLINK("${excelQuoted(url)}","${excelQuoted(url)}")` : "";

function commentRows(records) {
  return records.map((row) => {
    const specific = row.source_specific || {};
    return [
      joined(valueAt(row, ["source_specific", "amazon_asins"], ["query_context", "filters", "amazon_asins"], ["amazon_asins"])),
      String(valueAt(row, ["source_item_id"])),
      String(valueAt(row, ["comment_id"])),
      String(valueAt(row, ["parent_comment_id"])),
      String(valueAt(row, ["source_parent_id"])),
      valueAt(row, ["content", "text"], ["comment_text"], ["text"]),
      valueAt(row, ["author", "display_name"], ["author", "handle"], ["author"]),
      valueAt(row, ["timestamps", "published_at"], ["published_at"], ["source_specific", "comment_time_text"]),
      valueAt(row, ["engagement", "like_count"], ["engagement", "likes"], ["like_count"]),
      String(valueAt(row, ["source_specific", "video_id"], ["video_id"])),
      valueAt(row, ["source_specific", "video_title"], ["video_title"], ["content", "title"]),
      specific.video_url || row.video_url || row.provenance?.thread_url || "",
      valueAt(row, ["source_specific", "channel_title"], ["channel_title"]),
      valueAt(row, ["source_specific", "channel_url"], ["channel_url"]),
      valueAt(row, ["matched_query"], ["query_context", "query"], ["source_specific", "matched_query"]),
      joined(valueAt(row, ["source_specific", "keyword_sources"], ["query_context", "filters", "keyword_sources"], ["keyword_sources"])),
      valueAt(row, ["collected_at"], ["timestamps", "collected_at"]),
      valueAt(row, ["depth"]),
      valueAt(row, ["relevance_tier"]),
      valueAt(row, ["audit_status"], ["source_specific", "audit_status"]),
    ].map(cleanCell);
  });
}

function queryRows(plan) {
  const rows = [];
  for (const query of plan.queries || []) {
    const records = query.raw_keyword_records?.length
      ? query.raw_keyword_records
      : (query.raw_keywords || [query.query]).map((keyword) => ({ keyword, source: joined(query.keyword_sources), asins: query.asins }));
    for (const record of records) {
      rows.push([
        record.keyword || record.raw_keyword || "",
        query.query || "",
        record.source || joined(query.keyword_sources),
        joined(record.asins || query.asins || plan.asins),
        query.found_video_count ?? query.videos_found ?? 0,
      ]);
    }
  }
  return rows;
}

function summaryRows(manifest, plan, inputs, outputPath) {
  return [
    ["amazon_asins", joined(manifest.asins || plan.asins)],
    ["raw_keyword_count", manifest.raw_keyword_count ?? plan.raw_keyword_count ?? 0],
    ["effective_keyword_count", manifest.effective_keyword_count ?? plan.effective_keyword_count ?? 0],
    ["searched_keyword_count", manifest.searched_keyword_count ?? (plan.queries || []).length],
    ["searched_video_count", manifest.searched_video_count ?? manifest.deduplicated_video_count ?? 0],
    ["videos_with_comments", manifest.videos_with_comments ?? manifest.quality_checks?.[0]?.metrics?.captured_video_count ?? 0],
    ["comment_count", manifest.comment_count ?? manifest.record_count ?? 0],
    ["collected_at", manifest.collected_at || plan.created_at || ""],
    ["jsonl_file", inputs.jsonl],
    ["query_plan_file", inputs["query-plan"]],
    ["manifest_file", inputs.manifest],
    ["excel_file", outputPath],
  ];
}

function qualityRows(manifest) {
  const rows = [];
  for (const [index, gate] of (manifest.quality_checks || []).entries()) {
    rows.push([`quality_gate_${index + 1}`, "decision", gate.decision || ""]);
    for (const [metric, value] of Object.entries(gate.metrics || {})) rows.push([`quality_gate_${index + 1}`, metric, value]);
  }
  for (const [reason, count] of Object.entries(manifest.failure_reason_counts || {})) rows.push(["video_failure_reason", reason, count]);
  rows.push(["record_type", "independent_video_record_count", manifest.video_record_count ?? 0]);
  return rows;
}

function styleSheet(sheet, rowCount, colCount, textColumns = []) {
  const endRow = Math.max(1, rowCount);
  const header = sheet.getRangeByIndexes(0, 0, 1, colCount);
  header.format = {
    fill: "#1F4E78",
    font: { bold: true, color: "#FFFFFF" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };
  sheet.getRangeByIndexes(0, 0, endRow, colCount).format.verticalAlignment = "top";
  sheet.freezePanes.freezeRows(1);
  for (const column of textColumns) sheet.getRangeByIndexes(1, column, Math.max(1, endRow - 1), 1).format.numberFormat = "@";
}

function addFilteredTable(sheet, rowCount, colCount, name) {
  const endRow = Math.max(1, rowCount);
  const range = sheet.getRangeByIndexes(0, 0, endRow, colCount);
  const table = sheet.tables.add(range, true, name);
  table.style = "TableStyleMedium2";
  table.showFilterButton = true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const [{ SpreadsheetFile, Workbook }, jsonlText, partialText, queryText, manifestText] = await Promise.all([
    loadArtifactTool(), fs.readFile(args.jsonl, "utf8"), args["partial-jsonl"] ? fs.readFile(args["partial-jsonl"], "utf8") : "", fs.readFile(args["query-plan"], "utf8"), fs.readFile(args.manifest, "utf8"),
  ]);
  const records = jsonlText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const videos = records.filter((row) => (row.source_specific?.record_type || row.record_type) === "video");
  if (videos.length) throw new Error(`Comment workbook rejected ${videos.length} independent video record(s).`);
  const comments = [...records, ...partialText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))]
    .filter((row) => (row.source_specific?.record_type || row.record_type || "comment") === "comment");
  const queryPlan = JSON.parse(queryText);
  const manifest = JSON.parse(manifestText);
  const workbook = Workbook.create();

  const commentsSheet = workbook.worksheets.add("Raw_Comments");
  const commentsHeaders = ["amazon_asins", "source_item_id", "comment_id", "parent_comment_id", "source_parent_id", "comment_text", "author", "published_at", "like_count", "video_id", "video_title", "video_url", "channel_title", "channel_url", "matched_query", "keyword_sources", "collected_at", "depth", "relevance_tier", "audit_status"];
  const commentsData = commentRows(comments);
  commentsSheet.getRangeByIndexes(0, 0, commentsData.length + 1, commentsHeaders.length).values = [commentsHeaders, ...commentsData];
  for (let i = 0; i < commentsData.length; i += 1) {
    const source = commentsData[i];
    commentsSheet.getCell(i + 1, 11).formulas = [[hyperlinkFormula(source[11])]];
    commentsSheet.getCell(i + 1, 13).formulas = [[hyperlinkFormula(source[13])]];
  }
  styleSheet(commentsSheet, commentsData.length + 1, commentsHeaders.length, [0, 1, 2, 3, 4, 9]);
  commentsSheet.getRangeByIndexes(1, 5, Math.max(1, commentsData.length), 1).format.wrapText = true;
  commentsSheet.getRangeByIndexes(1, 16, Math.max(1, commentsData.length), 1).format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  addFilteredTable(commentsSheet, commentsData.length + 1, commentsHeaders.length, "RawCommentsTable");
  const commentWidths = [16,30,28,28,24,58,20,20,12,16,38,42,22,42,32,24,24,10,18,16];
  commentWidths.forEach((width, index) => { commentsSheet.getRangeByIndexes(0, index, 1, 1).format.columnWidth = width; });

  const querySheet = workbook.worksheets.add("Query_Plan");
  const queryHeaders = ["raw_keyword", "cleaned_keyword", "source", "amazon_asin", "search_result_count"];
  const queries = queryRows(queryPlan);
  querySheet.getRangeByIndexes(0, 0, queries.length + 1, queryHeaders.length).values = [queryHeaders, ...queries];
  styleSheet(querySheet, queries.length + 1, queryHeaders.length, [3]);
  addFilteredTable(querySheet, queries.length + 1, queryHeaders.length, "QueryPlanTable");
  [50, 45, 18, 18, 20].forEach((width, index) => { querySheet.getRangeByIndexes(0, index, 1, 1).format.columnWidth = width; });
  querySheet.getRangeByIndexes(1, 0, Math.max(1, queries.length), 2).format.wrapText = true;

  const auditSheet = workbook.worksheets.add("Video_Audit");
  const auditHeaders = ["video_id","video_title","video_url","channel_title","channel_url","matched_query","matched_keywords","matched_asins","relevance_score","audit_status","audit_reason","visible_comment_count"];
  const auditRows = (manifest.video_audits || []).map(row => auditHeaders.map(key => cleanCell(joined(row[key]))));
  auditSheet.getRangeByIndexes(0,0,auditRows.length+1,auditHeaders.length).values=[auditHeaders,...auditRows];
  for(let i=0;i<auditRows.length;i+=1){auditSheet.getCell(i+1,2).formulas=[[hyperlinkFormula(auditRows[i][2])]];auditSheet.getCell(i+1,4).formulas=[[hyperlinkFormula(auditRows[i][4])]];}
  styleSheet(auditSheet,auditRows.length+1,auditHeaders.length,[0]);addFilteredTable(auditSheet,auditRows.length+1,auditHeaders.length,"VideoAuditTable");
  [16,38,42,22,42,30,30,20,16,14,28,18].forEach((width,index)=>{auditSheet.getRangeByIndexes(0,index,1,1).format.columnWidth=width;});

  const summarySheet = workbook.worksheets.add("Run_Summary");
  const summary = summaryRows(manifest, queryPlan, args, path.resolve(args.output));
  summarySheet.getRangeByIndexes(0, 0, summary.length + 1, 2).values = [["metric", "value"], ...summary];
  styleSheet(summarySheet, summary.length + 1, 2, [1]);
  addFilteredTable(summarySheet, summary.length + 1, 2, "CollectionSummaryTable");
  summarySheet.getRange("A:A").format.columnWidth = 28;
  summarySheet.getRange("B:B").format.columnWidth = 80;
  summarySheet.getRange("B:B").format.wrapText = true;
  summarySheet.getRange("B9").format.numberFormat = "yyyy-mm-dd hh:mm:ss";

  const qualitySheet = workbook.worksheets.add("Quality_Gate");
  const quality = qualityRows(manifest);
  qualitySheet.getRangeByIndexes(0, 0, quality.length + 1, 3).values = [["section", "metric", "value"], ...quality];
  styleSheet(qualitySheet, quality.length + 1, 3);
  addFilteredTable(qualitySheet, quality.length + 1, 3, "QualityGateTable");
  [26, 38, 18].forEach((width, index) => { qualitySheet.getRangeByIndexes(0, index, 1, 1).format.columnWidth = width; });

  workbook.recalculate();
  await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(path.resolve(args.output));
  console.log(JSON.stringify({ output: path.resolve(args.output), raw_comments: comments.length, video_records: videos.length }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});

export { commentRows, queryRows, qualityRows, summaryRows };
