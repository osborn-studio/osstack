"""Tests for the osstack evaluation-spec protocol in ds-review/ds-verify.

Run from the repo root:

    python3 -m unittest discover legacy-python/deepseek/tests

Stdlib only; the end-to-end test fakes the DeepSeek API with a local HTTP
server so no key or network is needed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
CAPABILITY_ROOT = HERE.parent
sys.path.insert(0, str(CAPABILITY_ROOT / "lib"))

import evaluation_specs  # noqa: E402

SPECS = [
    {
        "id": "no-bypass",
        "mode": "semantic_review",
        "description": "No authorization bypass.",
        "acceptance": "Reject constant allow/deny values.",
        "required": True,
        "weight": 1,
    },
    {
        "id": "docs-updated",
        "mode": "semantic_review",
        "description": "Docs cover the change.",
        "required": True,
        "weight": 1,
    },
]


class LoadSpecsTest(unittest.TestCase):
    def test_missing_env_or_file_or_bad_json_returns_empty(self):
        self.assertEqual(evaluation_specs.load_specs(environ={}), [])
        self.assertEqual(
            evaluation_specs.load_specs(environ={evaluation_specs.ENV_VAR: "/nope/missing.json"}),
            [],
        )
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            fh.write("not json")
            path = fh.name
        try:
            self.assertEqual(
                evaluation_specs.load_specs(environ={evaluation_specs.ENV_VAR: path}),
                [],
            )
        finally:
            os.unlink(path)

    def test_loads_valid_specs_and_skips_malformed_entries(self):
        payload = SPECS + ["junk", {"mode": "command"}, {"id": "  "}]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(payload, fh)
            path = fh.name
        try:
            specs = evaluation_specs.load_specs(environ={evaluation_specs.ENV_VAR: path})
        finally:
            os.unlink(path)
        self.assertEqual([spec["id"] for spec in specs], ["no-bypass", "docs-updated"])


class PromptBlocksTest(unittest.TestCase):
    def test_appendix_and_criteria_mention_ids_and_acceptance(self):
        appendix = evaluation_specs.judgment_prompt_appendix(SPECS)
        self.assertIn("no-bypass, docs-updated", appendix)
        self.assertIn('{"evaluations"', appendix)

        block = evaluation_specs.criteria_user_block(SPECS)
        self.assertIn("- no-bypass (semantic_review): No authorization bypass.", block)
        self.assertIn("Acceptance: Reject constant allow/deny values.", block)

    def test_empty_specs_produce_empty_strings(self):
        self.assertEqual(evaluation_specs.judgment_prompt_appendix([]), "")
        self.assertEqual(evaluation_specs.criteria_user_block([]), "")


class ExtractJudgmentsTest(unittest.TestCase):
    def test_extracts_from_fenced_block_and_filters_bad_entries(self):
        content = (
            "# DS Review Report\n...\n"
            "```json\n"
            '{"evaluations":[{"id":"no-bypass","pass":false,"summary":"constant allow"},'
            '{"id":"docs-updated","pass":true},'
            '{"id":"unknown-spec","pass":true},'
            '{"id":"no-bypass","pass":"yes"}]}\n'
            "```\n"
        )
        judgments = evaluation_specs.extract_judgments(content, SPECS)
        self.assertEqual(judgments, [
            {"id": "no-bypass", "pass": False, "summary": "constant allow"},
            {"id": "docs-updated", "pass": True},
        ])

    def test_last_wellformed_object_wins_and_raw_json_works(self):
        content = (
            'first: {"evaluations":[{"id":"no-bypass","pass":true}]}\n'
            'later: {"evaluations":[{"id":"no-bypass","pass":false,"summary":"regressed"}]}\n'
        )
        judgments = evaluation_specs.extract_judgments(content, SPECS)
        self.assertEqual(judgments, [{"id": "no-bypass", "pass": False, "summary": "regressed"}])

    def test_no_judgments_or_no_specs_returns_empty(self):
        self.assertEqual(evaluation_specs.extract_judgments("nothing here", SPECS), [])
        self.assertEqual(evaluation_specs.extract_judgments('{"evaluations":[]}', SPECS), [])
        self.assertEqual(evaluation_specs.extract_judgments("x", []), [])

    def test_emit_line_round_trips_through_the_adapter_convention(self):
        judgments = [{"id": "no-bypass", "pass": False, "summary": "bad"}]
        line = evaluation_specs.emit_line(judgments)
        self.assertTrue(line.startswith(evaluation_specs.PREFIX))
        parsed = json.loads(line[len(evaluation_specs.PREFIX):])
        self.assertEqual(parsed, {"evaluations": judgments})
        self.assertEqual(evaluation_specs.emit_line([]), "")


class FakeDeepSeekHandler(BaseHTTPRequestHandler):
    """Returns a canned review whose tail carries the judgment block."""

    def do_POST(self):  # noqa: N802 (stdlib naming)
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        review = (
            "# DS Review Report\n## Summary\nok\n## Findings\nnone\n## Pass / Fail\nPASS\n\n"
            "```json\n"
            '{"evaluations":[{"id":"no-bypass","pass":false,"summary":"constant allow found"},'
            '{"id":"docs-updated","pass":true,"summary":"docs cover it"}]}\n'
            "```\n"
        )
        body = json.dumps({"choices": [{"message": {"content": review}}]}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence
        pass


class DsReviewEndToEndTest(unittest.TestCase):
    def test_ds_review_emits_judgment_line_from_faked_api(self):
        server = HTTPServer(("127.0.0.1", 0), FakeDeepSeekHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                specs_path = Path(tmp) / "specs.json"
                specs_path.write_text(json.dumps(SPECS), encoding="utf-8")
                output_path = Path(tmp) / "review.md"
                env = {
                    **os.environ,
                    "DEEPSEEK_API_KEY": "test-key",
                    "DEEPSEEK_BASE_URL": f"http://127.0.0.1:{server.server_port}",
                    evaluation_specs.ENV_VAR: str(specs_path),
                }
                result = subprocess.run(
                    [sys.executable, str(CAPABILITY_ROOT / "bin" / "ds-review"),
                     "--output", str(output_path), "--timeout", "10"],
                    input="diff --git a/x b/x\n+changed\n",
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env=env,
                    cwd=tmp,
                )
                report_text = output_path.read_text(encoding="utf-8") if output_path.exists() else ""
        finally:
            server.shutdown()
            thread.join(timeout=5)

        self.assertEqual(result.returncode, 0, result.stderr)
        judgment_lines = [
            line for line in result.stdout.splitlines()
            if line.startswith(evaluation_specs.PREFIX)
        ]
        self.assertEqual(len(judgment_lines), 1, result.stdout)
        parsed = json.loads(judgment_lines[0][len(evaluation_specs.PREFIX):])
        self.assertEqual(parsed["evaluations"], [
            {"id": "no-bypass", "pass": False, "summary": "constant allow found"},
            {"id": "docs-updated", "pass": True, "summary": "docs cover it"},
        ])
        self.assertIn("# DS Review Report", report_text)

    def test_ds_review_without_specs_emits_no_judgment_line(self):
        server = HTTPServer(("127.0.0.1", 0), FakeDeepSeekHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                env = {
                    **os.environ,
                    "DEEPSEEK_API_KEY": "test-key",
                    "DEEPSEEK_BASE_URL": f"http://127.0.0.1:{server.server_port}",
                }
                env.pop(evaluation_specs.ENV_VAR, None)
                result = subprocess.run(
                    [sys.executable, str(CAPABILITY_ROOT / "bin" / "ds-review"),
                     "--timeout", "10"],
                    input="diff --git a/x b/x\n+changed\n",
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env=env,
                    cwd=tmp,
                )
        finally:
            server.shutdown()
            thread.join(timeout=5)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(evaluation_specs.PREFIX, result.stdout)


if __name__ == "__main__":
    unittest.main()
