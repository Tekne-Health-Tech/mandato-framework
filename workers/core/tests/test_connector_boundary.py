"""A module connector that reaches the network by itself fails the static check (design 0003 §9 Static check)."""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / "scripts"))
import check_ai_boundary as B  # noqa: E402


class ConnectorBoundaryTest(unittest.TestCase):
    def findings(self, src: str) -> list[str]:
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "tenants/x/modules/m/worker/m/conn.py"
            p.parent.mkdir(parents=True)
            p.write_text(src)
            return B.check_file(p)

    def test_network_imports_are_refused(self):
        for src in ["import requests", "import httpx", "import urllib.request", "from http.client import HTTPSConnection",
                    "import socket", "from socket import create_connection", "import socket as s"]:
            self.assertTrue(self.findings(src), src)

    def test_ctx_http_is_fine(self):
        self.assertEqual(self.findings("import json\ndef fetch(r, c, ctx):\n    return ctx.http().get(r['url'])\n"), [])


if __name__ == "__main__":
    unittest.main()
