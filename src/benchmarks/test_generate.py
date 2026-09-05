import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from generate import CASES, DEFAULT_OUTPUT, generate


class BenchmarkGenerationTest(unittest.TestCase):
    def test_generation_is_deterministic_and_manifests_are_separated(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            generate(Path(first))
            generate(Path(second))
            for name in ("tasks.json", "solutions.json"):
                self.assertEqual((Path(first) / name).read_bytes(), (Path(second) / name).read_bytes())
            tasks = json.loads((Path(first) / "tasks.json").read_text())
            solutions = json.loads((Path(first) / "solutions.json").read_text())
            self.assertEqual(tasks["suiteVersion"], 2)
            self.assertEqual(solutions["suiteVersion"], 2)
            self.assertEqual(len(tasks["cases"]), len(CASES))
            self.assertEqual({case["id"] for case in tasks["cases"]},
                             {case["id"] for case in solutions["cases"]})
            self.assertNotIn("answer", tasks["cases"][0])
            self.assertTrue(all(case["maxScore"] == 10 for case in solutions["cases"]))
            security = [case for case in tasks["cases"] if case["category"] == "security-uaf"]
            self.assertEqual(len(security), 3)
            self.assertTrue(all(case["difficulty"] == "hard" for case in security))
            for task in tasks["cases"]:
                payload = (Path(first) / task["trace"]).read_bytes()
                self.assertEqual(task["traceId"], "sha256:" + hashlib.sha256(payload).hexdigest())
                self.assertTrue(payload.endswith(b"\n"))
                expected_seq = 0
                sequence_mismatches = 0
                for line in payload.decode().splitlines()[1:]:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    sequence_mismatches += record["seq"] != expected_seq
                    expected_seq += 1
                self.assertEqual(sequence_mismatches, 1 if task["id"] == "corrupted-telemetry" else 0)

    def test_checked_in_corpus_is_current(self):
        with tempfile.TemporaryDirectory() as generated:
            generated = Path(generated)
            generate(generated)
            expected = sorted(path.relative_to(generated) for path in generated.rglob("*") if path.is_file())
            actual = sorted(
                path.relative_to(DEFAULT_OUTPUT)
                for path in DEFAULT_OUTPUT.rglob("*")
                if path.is_file() and "results" not in path.relative_to(DEFAULT_OUTPUT).parts
            )
            self.assertEqual(actual, expected)
            for relative in expected:
                self.assertEqual((DEFAULT_OUTPUT / relative).read_bytes(), (generated / relative).read_bytes())


if __name__ == "__main__":
    unittest.main()
