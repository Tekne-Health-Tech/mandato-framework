"""The contract suite passes on the reference connector and catches a connector that breaks each rule (design 0003 §8)."""
import copy
import unittest

from workers.core.connectors.loader import ConnectorRefused, check_connector, check_registry
from workers.core.contracts.classes import DataClass
from workers.core.testing.connector_contract import ConnectorContract
from workers.core.tests.fixtures.ref_connector import FIXTURES, ExemploItens


class ReferenceConnectorTest(ConnectorContract, unittest.TestCase):
    connector = ExemploItens()
    module_short = "hello"
    params = {"uf": "EX"}
    fixtures = FIXTURES


def variant(**changes):
    c = ExemploItens()
    c.manifest = {**copy.deepcopy(ExemploItens.manifest), **changes}
    return c


class LoaderRefusesTest(unittest.TestCase):
    def refused(self, c, params=None, short="hello"):
        with self.assertRaises(ConnectorRefused) as e:
            check_connector(c, short, {"uf": "EX"} if params is None else params)
        return e.exception.code

    def test_manifest_rules(self):
        for bad in [dict(data_class=DataClass.C2), dict(auth="oauth"), dict(auth="api_key"),
                    dict(auth="api_key", auth_secret_ref="k", auth_header="bad header"), dict(hosts=[]),
                    dict(hosts=["http://x.gov.br"]), dict(hosts=["localhost"]), dict(rate_limit_per_min=0),
                    dict(rate_limit_per_min=601), dict(natural_key=[]), dict(natural_key=["a b"]),
                    dict(target_table="mod_other.exemplo_item"), dict(target_table="core.data_source"),
                    dict(sync="incremental"), dict(sync="snapshot", deleted_column="removido"), dict(sync="full"),
                    dict(source_id="Bad_Id")]:
            self.assertEqual(self.refused(variant(**bad)), "invalid_manifest", bad)
        c = variant(); del c.manifest["hosts"]
        self.assertEqual(self.refused(c), "invalid_manifest")

    def test_params_schema_must_be_strict(self):
        c = ExemploItens(); c.params_schema = {"type": "object", "properties": {"uf": {"type": "string"}}}
        self.assertEqual(self.refused(c), "invalid_manifest")
        c.params_schema = {"type": "object", "additionalProperties": False, "properties": {"uf": {"type": "string", "format": "x"}}}
        self.assertEqual(self.refused(c), "invalid_manifest")

    def test_params_must_match(self):
        self.assertEqual(self.refused(ExemploItens(), {"uf": "ex"}), "invalid_params")
        self.assertEqual(self.refused(ExemploItens(), {"uf": "EX", "extra": 1}), "invalid_params")
        self.assertEqual(self.refused(ExemploItens(), {}), "invalid_params")

    def test_two_snapshot_connectors_cannot_share_a_table(self):
        a, b = variant(), variant(source_id="outra-fonte")
        with self.assertRaises(ConnectorRefused):
            check_registry([(a, "hello"), (b, "hello")])


class SuiteCatchesBrokenConnectorsTest(unittest.TestCase):
    """Each broken connector must make at least one contract test fail."""

    def run_suite(self, connector):
        cls = type("T", (ConnectorContract, unittest.TestCase), {"connector": connector, "module_short": "hello",
                                                                "params": {"uf": "EX"}, "fixtures": FIXTURES})
        res = unittest.TestResult()
        unittest.defaultTestLoader.loadTestsFromTestCase(cls).run(res)
        return len(res.failures) + len(res.errors)

    def test_reference_passes(self):
        self.assertEqual(self.run_suite(ExemploItens()), 0)

    def test_broken_connectors_fail(self):
        class OtherHost(ExemploItens):
            def discover(self, ctx):
                return [{"id": "x", "url": "https://outro.exemplo.gov.br/api/itens"}]

        class ForgedRefs(ExemploItens):
            def fetch(self, resource, cursor, ctx):
                b = super().fetch(resource, cursor, ctx); b["raw_refs"] = ["0" * 64]; return b

        class BadHeader(ExemploItens):
            def fetch(self, resource, cursor, ctx):
                ctx.http().get(resource["url"], headers={"Authorization": "x"}); return super().fetch(resource, cursor, ctx)

        class NonDeterministic(ExemploItens):
            n = 0
            def normalize(self, raw):
                NonDeterministic.n += 1
                return [dict(r, valor=NonDeterministic.n) for r in super().normalize(raw)]

        class DuplicateKeys(ExemploItens):
            def normalize(self, raw):
                return [dict(r, codigo="1") for r in super().normalize(raw)]

        class LaxValidate(ExemploItens):
            def validate(self, records):
                return {"errors": [], "warnings": []}

        for c in (OtherHost(), ForgedRefs(), BadHeader(), NonDeterministic(), DuplicateKeys(), LaxValidate(),
                  variant(rate_limit_per_min=0)):
            self.assertGreater(self.run_suite(c), 0, type(c).__name__)


if __name__ == "__main__":
    unittest.main()
