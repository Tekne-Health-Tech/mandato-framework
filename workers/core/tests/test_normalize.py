import json
import unittest
from pathlib import Path

from workers.core.crypto import normalize

VECTORS = json.loads((Path(__file__).parents[3] / "packages/crypto/vectors/normalize-v1.json").read_text("utf-8"))


class NormalizeVectors(unittest.TestCase):
    def test_vectors(self):
        for kind in ("email", "phone"):
            fn = getattr(normalize, kind)
            for v in VECTORS[kind]:
                with self.subTest(kind=kind, value=v["in"]):
                    if "error" in v:
                        with self.assertRaisesRegex(normalize.NormalizeError, v["error"]):
                            fn(v["in"])
                    else:
                        self.assertEqual(fn(v["in"]), v["out"])
