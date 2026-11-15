import importlib.util
import pathlib
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location("check_ai_boundary", pathlib.Path(__file__).parents[3] / "scripts/check_ai_boundary.py")
cab = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cab)

BYPASSES = {
    "alias of a provider": "from workers.core.contracts.ai import EchoProvider as E\nE().generate('m.t', [], {})\n",
    "module alias + attribute": "import workers.core.contracts.ai as ai\nai.EchoProvider()\n",
    "sdk under alias": "import openai as o\n",
    "assignment alias": "import workers.core.contracts.ai as ai\nE = ai.EchoProvider\nE().generate('m.t', [], {})\n",
    "sdk submodule": "from google.genai import types\n",
    "http client": "import httpx\n",
    "dynamic import": "__import__('open' + 'ai')\n",
    "importlib": "import importlib\n",
    "loader token": "import workers.core.contracts.ai as ai\nx = ai._LOADER_TOKEN\n",
    "building a part": "from workers.core.contracts.ai import ClassifiedPart\nClassifiedPart('text', 'x', 0, _token=None)\n",
    "gateway": "from workers.core.contracts.ai import AiGateway\n",
    "provider package": "from mod_x.providers.cloud import Adapter\n",
}
CLEAN = "from workers.core.contracts.ai import AiRefused, text_part\nfrom workers.core.contracts.classes import DataClass\np = text_part('x', DataClass.C1)\n"


def findings(code: str, sub: str = "worker/m") -> list[str]:
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d, sub, "job.py")
        f.parent.mkdir(parents=True)
        f.write_text(code)
        return cab.check_file(f)


class AiBoundaryTest(unittest.TestCase):
    def test_every_bypass_is_reported(self):
        for name, code in BYPASSES.items():
            with self.subTest(name):
                self.assertTrue(findings(code), name)

    def test_loader_use_is_clean(self):
        self.assertEqual(findings(CLEAN), [])

    def test_providers_package_may_import_its_sdk(self):
        self.assertEqual(findings("import httpx\n", "worker/m/providers"), [])


if __name__ == "__main__":
    unittest.main()
