import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COLLECTOR = ROOT / "scripts/youtube_playwright_collector.cjs"
NORMALIZER = ROOT / "scripts/normalize_raw_jsonl.py"
EXCEL_BUILDER = ROOT / "scripts/build_youtube_excel.mjs"
ARTIFACT_TOOL_ENTRY = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs"


class StandaloneYouTubeSkillTests(unittest.TestCase):
    def test_required_files_and_no_voc_dependency(self):
        required = [
            "SKILL.md",
            "agents/openai.yaml",
            "references/collection-guide.md",
            "references/raw-record-schema.md",
            "scripts/youtube_playwright_collector.cjs",
            "scripts/normalize_raw_jsonl.py",
            "scripts/build_youtube_excel.mjs",
        ]
        for name in required:
            self.assertTrue((ROOT / name).is_file(), name)

        text_suffixes = {".md", ".yaml", ".yml", ".py", ".cjs", ".mjs", ".js", ".ps1", ".cmd", ".json", ".toml", ".txt"}
        excluded = {".git", "node_modules", "__pycache__", "dist", "outputs"}
        text = "\n".join(
            path.read_text(encoding="utf-8")
            for path in ROOT.rglob("*")
            if path.is_file()
            and not any(part in excluded for part in path.parts)
            and (path.suffix.lower() in text_suffixes or path.name in {"LICENSE", "VERSION"})
        )
        legacy_root = "D:" + "\\Project\\2026\\SKILL\\" + "VOC"
        legacy_relative = ".." + "/voc-"
        self.assertNotIn(legacy_root, text)
        self.assertNotIn(legacy_relative, text.lower())

    def test_collector_help_is_side_effect_free_and_documents_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = os.environ.copy()
            env["NODE_PATH"] = str(Path(tmp) / "missing-node-modules")
            run = subprocess.run(
                ["node", str(COLLECTOR), "--help"],
                cwd=tmp,
                env=env,
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn("USAGE", run.stdout.upper())
            for option in (
                "--asins",
                "--target-videos",
                "--comments-per-video",
                "--videos-per-query",
                "--detail-concurrency",
                "--seller-term-limit",
                "--expanded-keywords",
                "--max-queries",
                "--headless",
                "--channel",
                "--out-dir",
                "--profile-dir",
            ):
                self.assertIn(option, run.stdout)
            self.assertNotIn("keyword:", run.stdout.lower())
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_collector_accepts_asin_groups_and_builds_keyword_queries(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
const asins = collector.validateAsins(['b0abc12345,B0DEF67890', 'B0ABC12345']);
const amazon = collector.extractAmazonKeywords({{title: 'Dog Wipes for Paws and Body', bullets: ['Gentle pet wipes for sensitive skin']}}, 5);
const seller = collector.selectSellerKeywords('Word Frequency\\ndog wipes (12,300)\\npaw cleaner (8,100)\\nExport Keywords', [], 5);
const contexts = [{{asin: asins[0], amazon_keywords: amazon, seller_keywords: seller}}, {{asin: asins[1], amazon_keywords: ['pet wipes'], seller_keywords: []}}];
const queries = collector.buildQueries({{'expanded-keywords': 'odor control', 'max-queries': '4'}}, contexts);
console.log(JSON.stringify({{asins, amazon, seller, queries}}));
"""
        run = subprocess.run(
            ["node", "-e", script],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual(result["asins"], ["B0ABC12345", "B0DEF67890"])
        self.assertIn("dog wipes", result["seller"])
        queries = [row["query"] for row in result["queries"]]
        self.assertIn("Dog Wipes for Paws and Body", queries)
        self.assertIn("dog wipes", queries)
        self.assertIn("odor control", queries)
        self.assertTrue(all(row["asins"] for row in result["queries"] if row["query"] != "odor control"))
        represented = {asin for row in result["queries"] for asin in row["asins"]}
        self.assertEqual(represented, {"B0ABC12345", "B0DEF67890"})

    def test_query_limit_round_robins_across_asins(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
const contexts = [
  {{asin: 'B0ABC12345', amazon_keywords: ['asin one amazon'], seller_keywords: ['asin one seller']}},
  {{asin: 'B0DEF67890', amazon_keywords: ['asin two amazon'], seller_keywords: ['asin two seller']}}
];
console.log(JSON.stringify(collector.buildQueries({{'max-queries': '2'}}, contexts)));
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        queries = json.loads(run.stdout)
        represented = {asin for row in queries for asin in row["asins"]}
        self.assertEqual(represented, {"B0ABC12345", "B0DEF67890"})

    def test_keyword_cleaning_filters_broad_terms_and_preserves_lineage(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
const rows = [
  {{raw_keyword: 'dog', source: 'sellersprite', asin: 'B003ULL1NQ'}},
  {{raw_keyword: 'dogs', source: 'sellersprite', asin: 'B003ULL1NQ'}},
  {{raw_keyword: 'joint', source: 'sellersprite', asin: 'B003ULL1NQ'}},
  {{raw_keyword: 'Nutramax Cosequin Joint Supplement for Dogs, Chewable Tablets, 132ct', source: 'amazon', asin: 'B003ULL1NQ'}},
  {{raw_keyword: 'Cosequin', source: 'sellersprite', asin: 'B003ULL1NQ'}},
  {{raw_keyword: 'cosequins', source: 'manual', asin: 'B003ULL1NQ'}}
];
console.log(JSON.stringify(collector.cleanKeywordCandidates(rows)));
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        cleaned = json.loads(run.stdout)
        queries = [row["query"].lower() for row in cleaned]
        self.assertNotIn("dog", queries)
        self.assertNotIn("dogs", queries)
        self.assertNotIn("joint", queries)
        product_query = next(row for row in cleaned if "nutramax" in row["query"].lower())
        self.assertLessEqual(len(product_query["query"].split()), 8)
        cosequin = [row for row in cleaned if row["query"].lower() in ("cosequin", "cosequins")]
        self.assertEqual(len(cosequin), 1)
        self.assertEqual(set(cosequin[0]["keyword_sources"]), {"sellersprite", "manual"})
        self.assertEqual(set(cosequin[0]["raw_keywords"]), {"Cosequin", "cosequins"})

    def test_all_cleaned_queries_are_scheduled_when_limit_is_all(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
const contexts = [{{
  asin: 'B003ULL1NQ',
  amazon_keywords: ['Nutramax Cosequin dog joint supplement', 'Cosequin chewable tablets'],
  seller_keywords: ['cosequin', 'glucosamine', 'arthritis']
}}];
const plan = collector.buildKeywordPlan({{'max-queries': 'all'}}, contexts);
console.log(JSON.stringify({{plan, searches: collector.planQuerySearches(plan.queries, 100)}}));
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual(result["plan"]["effective_keyword_count"], len(result["plan"]["queries"]))
        self.assertEqual(len(result["searches"]), len(result["plan"]["queries"]))
        self.assertTrue(all(row["candidate_limit"] >= 1 for row in result["searches"]))
        self.assertTrue(all(row["raw_keywords"] for row in result["plan"]["queries"]))

    def test_numeric_query_target_expands_relevant_product_terms_to_thirty(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
const contexts = [{{
  asin: 'B003ULL1NQ',
  title: 'Nutramax Cosequin Joint Supplement for Dogs, Chewable Tablets, 132ct',
  bullets: ['Contains glucosamine, chondroitin and MSM', 'Daily use for senior and large breed dogs'],
  amazon_keywords: ['Nutramax Cosequin Joint Supplement for Dogs'],
  seller_keywords: []
}}];
console.log(JSON.stringify(collector.buildKeywordPlan({{'max-queries': '30'}}, contexts)));
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        plan = json.loads(run.stdout)
        self.assertEqual(plan["source_raw_keyword_count"], 1)
        self.assertEqual(plan["effective_keyword_count"], 30)
        self.assertEqual(len(plan["queries"]), 30)
        self.assertGreaterEqual(plan["derived_keyword_count"], 29)
        self.assertTrue(all("B003ULL1NQ" in row["asins"] for row in plan["queries"]))
        self.assertTrue(any(any(source.startswith("derived:") for source in row["keyword_sources"]) for row in plan["queries"]))
        self.assertFalse({"dog", "dogs", "joint"}.intersection(row["query"].lower() for row in plan["queries"]))

    def test_videos_per_query_is_fixed_and_candidates_deduplicate_after_scanning(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
const queries = [{{query:'q1'}}, {{query:'q2'}}];
const searchPlan = collector.planQuerySearches(queries, 15);
const merged = collector.deduplicateSearchCandidates([
  [{{video_id:'v1', asins:['A'], keyword_sources:['amazon']}}, {{video_id:'v2', asins:['A'], keyword_sources:['amazon']}}],
  [{{video_id:'v1', asins:['A'], keyword_sources:['sellersprite']}}, {{video_id:'v3', asins:['A'], keyword_sources:['sellersprite']}}]
]);
console.log(JSON.stringify({{searchPlan, merged}}));
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual([row["candidate_limit"] for row in result["searchPlan"]], [15, 15])
        self.assertEqual(result["merged"]["search_candidate_count"], 4)
        self.assertEqual(result["merged"]["duplicate_video_count"], 1)
        self.assertEqual([row["video_id"] for row in result["merged"]["candidates"]], ["v1", "v2", "v3"])
        self.assertEqual(set(result["merged"]["candidates"][0]["keyword_sources"]), {"amazon", "sellersprite"})

    def test_concurrency_pool_caps_parallel_work_and_preserves_order(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
let active = 0;
let peak = 0;
(async () => {{
  const values = await collector.mapWithConcurrency([0,1,2,3,4,5], 3, async (value, index, worker) => {{
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 25 - value));
    active -= 1;
    return {{value: value * 2, index, worker}};
  }});
  console.log(JSON.stringify({{peak, values}}));
}})();
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual(result["peak"], 3)
        self.assertEqual([row["value"] for row in result["values"]], [0, 2, 4, 6, 8, 10])
        self.assertTrue(all(0 <= row["worker"] < 3 for row in result["values"]))

    def test_single_scenario_terms_are_anchored_to_the_product(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
const contexts = [{{
  asin: 'B003ULL1NQ',
  amazon_keywords: ['Nutramax Cosequin Joint Supplement for Dogs'],
  seller_keywords: ['dog', 'joint', 'hip', 'arthritis', 'cosequin']
}}];
console.log(JSON.stringify(collector.buildKeywordPlan({{'max-queries': 'all'}}, contexts)));
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        queries = [row["query"].lower() for row in json.loads(run.stdout)["queries"]]
        self.assertNotIn("dog", queries)
        self.assertNotIn("joint", queries)
        self.assertNotIn("hip", queries)
        self.assertNotIn("arthritis", queries)
        self.assertTrue(any("cosequin" in query and "hip" in query for query in queries))
        self.assertTrue(any("cosequin" in query and "arthritis" in query for query in queries))

    def test_amazon_bullet_queries_keep_the_product_anchor_after_compression(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
const contexts = [{{
  asin: 'B003ULL1NQ',
  amazon_keywords: [
    'Nutramax Cosequin Joint Supplement for Dogs',
    'For Any Breed or Size Whether you have a young or senior dog'
  ],
  seller_keywords: []
}}];
console.log(JSON.stringify(collector.buildKeywordPlan({{'max-queries':'2'}}, contexts).queries));
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        queries = json.loads(run.stdout)
        self.assertIn("cosequin", queries[1]["query"].lower())
        self.assertLessEqual(len(queries[1]["query"].split()), 8)

    def test_comment_loader_stops_at_limit_or_three_stagnant_rounds(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
function fakePage(values) {{
  let index = 0;
  return {{
    locator: () => ({{count: async () => values[Math.min(index++, values.length - 1)]}}),
    mouse: {{wheel: async () => {{}}}},
    waitForTimeout: async () => {{}}
  }};
}}
(async () => {{
  const stagnant = await collector.loadCommentsUntil(fakePage([2, 2, 2, 2, 9]), 20);
  const full = await collector.loadCommentsUntil(fakePage([2, 7, 20, 25]), 20);
  console.log(JSON.stringify({{stagnant, full}}));
}})();
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual(result["stagnant"]["count"], 2)
        self.assertEqual(result["stagnant"]["stagnant_rounds"], 3)
        self.assertEqual(result["full"]["count"], 20)
        self.assertEqual(result["full"]["stagnant_rounds"], 0)

    def test_reply_ledger_counts_modern_comment_view_nodes(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
let selector = null;
const page = {{locator(value) {{ selector = value; return {{count: async () => 7}}; }}}};
collector.countVisibleCommentNodes(page).then(count => console.log(JSON.stringify({{count, selector}})));
"""
        run = subprocess.run(["node", "-e", script], check=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual(result["count"], 7)
        self.assertIn("ytd-comment-thread-renderer #content-text", result["selector"])

    def test_no_comment_reason_classification(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const c = require({collector_path});
const states = [
  c.classifyNoCommentState({{bodyText: '0 comments'}}),
  c.classifyNoCommentState({{bodyText: 'Comments are turned off'}}),
  c.classifyNoCommentState({{bodyText: 'Sign in to continue to YouTube'}}),
  c.classifyNoCommentState({{bodyText: 'This video is not available in your country'}}),
  c.classifyNoCommentState({{bodyText: 'Video unavailable'}}),
  c.classifyNoCommentState({{bodyText: 'ordinary watch page'}}),
  c.classifyVideoError(new Error('page.goto: Timeout 60000ms exceeded')),
  c.classifyVideoError(new Error('navigation failed'))
];
console.log(JSON.stringify(states));
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(
            json.loads(run.stdout),
            [
                "zero_comments",
                "comments_disabled",
                "login_required",
                "age_or_region_restricted",
                "video_unavailable",
                "unknown_no_public_comments",
                "load_timeout",
                "unknown_no_public_comments",
            ],
        )

    def test_collector_emits_only_comments_with_video_traceability(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const collector = require({collector_path});
const args = {{asins: ['B0ABC12345'], 'target-videos': '100', 'comments-per-video': '20'}};
const candidate = {{video_id: 'vid-1', url: 'https://www.youtube.com/watch?v=vid-1', title: 'Dog wipes review', channel_title: 'Channel', query: 'dog wipes', search_dimension: 'sellersprite', search_position: 1, asins: ['B0ABC12345'], keyword_sources: ['sellersprite']}};
const detail = {{title: 'Dog wipes review', description: 'Description', channelTitle: 'Channel', channelUrl: 'https://www.youtube.com/@channel', publishedText: 'today', viewText: '10 views', comments: [{{content: 'Useful', author: 'Viewer', authorUrl: null, timeText: 'now', likeText: '2', commentUrl: 'https://www.youtube.com/watch?v=vid-1&lc=c1', isPinned: false, position: 1}}]}};
const records = collector.buildCommentRecords(candidate, detail, args, '2026-09-14T00:00:00Z');
console.log(JSON.stringify({{records, csv: collector.recordsToCsv(records), gate: collector.qualityGate(records, 1)}}));
"""
        run = subprocess.run(
            ["node", "-e", script], check=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["record_type"], "comment")
        self.assertEqual(record["source_specific"]["record_type"], "comment")
        self.assertEqual(record["source_parent_id"], "video:vid-1")
        self.assertEqual(record["source_specific"]["video_title"], "Dog wipes review")
        self.assertEqual(record["source_specific"]["amazon_asins"], ["B0ABC12345"])
        self.assertIn("amazon_asins", result["csv"].splitlines()[0])
        self.assertIn("video_title", result["csv"].splitlines()[0])
        self.assertIn("video_url", result["csv"].splitlines()[0])
        self.assertIn("channel_title", result["csv"].splitlines()[0])
        self.assertEqual(result["gate"]["metrics"]["captured_video_count"], 1)
        self.assertEqual(result["gate"]["metrics"]["captured_comment_count"], 1)
        self.assertEqual(result["gate"]["metrics"]["missing_parent_id_count"], 0)

    def test_quality_gate_warns_on_missing_ids_and_parent_links(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const {{qualityGate}} = require({collector_path});
const records = [
  {{source_item_id: '', source_parent_id: null, provenance: {{url: 'https://www.youtube.com/watch?v=v1&lc=c1'}}, content: {{text: 'comment'}}, source_specific: {{record_type: 'comment'}}}}
];
console.log(JSON.stringify(qualityGate(records, 1)));
"""
        run = subprocess.run(
            ["node", "-e", script],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        gate = json.loads(run.stdout)
        self.assertEqual(gate["decision"], "warning")
        self.assertEqual(gate["metrics"]["missing_id_count"], 1)
        self.assertEqual(gate["metrics"]["missing_parent_id_count"], 1)

    def test_raw_quality_gate_is_not_a_volume_or_trusted_threshold(self):
        collector_path = json.dumps(str(COLLECTOR))
        script = f"""
const {{qualityGate}} = require({collector_path});
const records = [{{
  source_item_id: 'comment:v1:c1', comment_id: 'c1', source_parent_id: 'video:v1',
  provenance: {{url: 'https://www.youtube.com/watch?v=v1&lc=c1'}},
  content: {{text: 'short'}}, source_specific: {{record_type: 'comment'}}
}}];
console.log(JSON.stringify(qualityGate(records, 100)));
"""
        run = subprocess.run(["node", "-e", script], check=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        gate = json.loads(run.stdout)
        self.assertEqual(gate["decision"], "pass")
        self.assertEqual(gate["blocking_issues"], [])

    def test_normalizer_preserves_comment_parent_relationship(self):
        comment = {
            "record_type": "comment",
            "source_item_id": "comment:vid-1:comment-1",
            "source_parent_id": "video:vid-1",
            "text": "This solved my problem",
            "url": "https://www.youtube.com/watch?v=vid-1&lc=comment-1",
        }
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            source = tmp_path / "input.jsonl"
            output = tmp_path / "normalized.jsonl"
            source.write_text(
                json.dumps(comment) + "\n",
                encoding="utf-8",
            )
            run = subprocess.run(
                [sys.executable, str(NORMALIZER), str(source), str(output), "--source", "youtube"],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            rows = [json.loads(line) for line in output.read_text("utf-8").splitlines()]
            self.assertEqual(rows[0]["source_specific"]["record_type"], "comment")
            self.assertEqual(rows[0]["source_parent_id"], "video:vid-1")

    def test_normalizer_help_contract(self):
        help_run = subprocess.run(
            [sys.executable, str(NORMALIZER), "--help"],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(help_run.returncode, 0, help_run.stderr)
        self.assertIn("--source", help_run.stdout)

    def test_excel_builder_help_contract(self):
        run = subprocess.run(
            ["node", str(EXCEL_BUILDER), "--help"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("USAGE", run.stdout.upper())
        for option in ("--jsonl", "--query-plan", "--manifest", "--output"):
            self.assertIn(option, run.stdout)

    @unittest.skipUnless(ARTIFACT_TOOL_ENTRY.is_file(), "Codex artifact-tool is unavailable")
    def test_excel_builder_creates_formatted_comment_workbook(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            jsonl_path = tmp_path / "comments.jsonl"
            query_path = tmp_path / "query-plan.json"
            manifest_path = tmp_path / "manifest.json"
            output_path = tmp_path / "comments.xlsx"
            record = {
                "source_item_id": "comment:video-001:comment-001",
                "source_parent_id": "video:video-001",
                "content": {"text": "中文评论 — works well"},
                "author": {"display_name": "测试用户"},
                "timestamps": {"published_at": "2026-09-14T01:02:03Z", "collected_at": "2026-09-14T02:03:04Z"},
                "engagement": {"like_count": 12},
                "source_specific": {
                    "record_type": "comment",
                    "video_id": "video-001",
                    "video_title": "Cosequin review",
                    "video_url": "https://www.youtube.com/watch?v=video-001",
                    "channel_title": "Pet Channel",
                    "channel_url": "https://www.youtube.com/@pet-channel",
                    "amazon_asins": ["B003ULL1NQ"],
                    "matched_query": "cosequin review",
                    "keyword_sources": ["amazon", "sellersprite"],
                },
            }
            jsonl_path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
            query_path.write_text(json.dumps({
                "asins": ["B003ULL1NQ"],
                "created_at": "2026-09-14T02:03:04Z",
                "raw_keyword_count": 2,
                "effective_keyword_count": 1,
                "queries": [{
                    "query": "cosequin review",
                    "raw_keywords": ["Cosequin Review", "cosequin reviews"],
                    "keyword_sources": ["amazon", "sellersprite"],
                    "asins": ["B003ULL1NQ"],
                    "found_video_count": 3,
                }],
            }, ensure_ascii=False), encoding="utf-8")
            manifest_path.write_text(json.dumps({
                "asins": ["B003ULL1NQ"],
                "collected_at": "2026-09-14T02:03:04Z",
                "raw_keyword_count": 2,
                "effective_keyword_count": 1,
                "searched_keyword_count": 1,
                "searched_video_count": 3,
                "videos_with_comments": 1,
                "comment_count": 1,
                "video_record_count": 0,
                "failure_reason_counts": {"comments_disabled": 2},
                "quality_checks": [{"decision": "pass", "metrics": {"captured_comment_count": 1}}],
                "files": [str(jsonl_path), str(query_path)],
            }, ensure_ascii=False), encoding="utf-8")

            env = os.environ.copy()
            env["CODEX_ARTIFACT_NODE_MODULES"] = str(
                Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"
            )
            run = subprocess.run(
                ["node", str(EXCEL_BUILDER), "--jsonl", str(jsonl_path), "--query-plan", str(query_path),
                 "--manifest", str(manifest_path), "--output", str(output_path)],
                env=env, check=False, capture_output=True, text=True, timeout=60,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertTrue(output_path.is_file())

            ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
                  "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
                  "p": "http://schemas.openxmlformats.org/package/2006/relationships"}
            with zipfile.ZipFile(output_path) as archive:
                workbook = ET.fromstring(archive.read("xl/workbook.xml"))
                names = [node.attrib["name"] for node in workbook.findall("m:sheets/m:sheet", ns)]
                self.assertEqual(names, ["Raw_Comments", "Query_Plan", "Video_Audit", "Run_Summary", "Quality_Gate"])
                rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
                targets = {node.attrib["Id"]: node.attrib["Target"] for node in rels.findall("p:Relationship", ns)}
                sheet_node = workbook.find("m:sheets/m:sheet", ns)
                target = targets[sheet_node.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]]
                target = target.lstrip("/") if target.startswith("/") else "xl/" + target.lstrip("./")
                comments = ET.fromstring(archive.read(target))
                self.assertEqual(len(comments.findall("m:sheetData/m:row", ns)), 2)
                self.assertEqual(len(comments.findall("m:sheetData/m:row[1]/m:c", ns)), 20)
                table_part = comments.find("m:tableParts/m:tablePart", ns)
                self.assertIsNotNone(table_part)
                sheet_name = Path(target).name
                sheet_rels_path = f"xl/worksheets/_rels/{sheet_name}.rels"
                sheet_rels = ET.fromstring(archive.read(sheet_rels_path))
                table_rel_id = table_part.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
                table_target = next(node.attrib["Target"] for node in sheet_rels.findall("p:Relationship", ns) if node.attrib["Id"] == table_rel_id)
                table_path = table_target.lstrip("/") if table_target.startswith("/") else "xl/" + table_target.replace("../", "")
                table_xml = ET.fromstring(archive.read(table_path))
                self.assertIsNotNone(table_xml.find("m:autoFilter", ns))
                pane = comments.find("m:sheetViews/m:sheetView/m:pane", ns)
                self.assertEqual(pane.attrib.get("state"), "frozen")
                self.assertEqual(pane.attrib.get("ySplit"), "1")
                formulas = [node.text or "" for node in comments.findall(".//m:f", ns)]
                self.assertEqual(sum("HYPERLINK" in formula.upper() for formula in formulas), 2)


if __name__ == "__main__":
    unittest.main()
