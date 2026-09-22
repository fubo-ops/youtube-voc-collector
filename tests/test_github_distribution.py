import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class GitHubDistributionTests(unittest.TestCase):
    def test_reference_repository_shape(self):
        required = (
            ".github/workflows/test.yml",
            ".python-version",
            "pyproject.toml",
            "requirements.txt",
            "package.json",
            "package-lock.json",
            "README.md",
            "SKILL.md",
            "agents/openai.yaml",
            "references/collection-guide.md",
            "scripts/youtube_playwright_collector.cjs",
            "tests/test_standalone_skill.py",
        )
        self.assertEqual([], [name for name in required if not (ROOT / name).is_file()])

    def test_node_dependency_and_repository_ignores(self):
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertIn("playwright", package.get("dependencies", {}))
        ignored = (ROOT / ".gitignore").read_text(encoding="utf-8")
        for item in ("outputs/", "dist/", "node_modules/", "*.xlsx", "*profile*/"):
            self.assertIn(item, ignored)


if __name__ == "__main__":
    unittest.main()
