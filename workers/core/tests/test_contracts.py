import unittest

from workers.core.contracts.ai import (AiGateway, AiRefused, ClassifiedPart, EchoProvider, FixedRouter, NoneProvider,
                                       NoneRouter, OperatorProvider, check, column_part, text_part)
from workers.core.contracts.classes import DataClass

OPS = {
    "local": OperatorProvider("local", "local", DataClass.C3, ()),
    "cloud": OperatorProvider("cloud", "external", DataClass.C1, ("api.example.com",)),
}


def part(c: DataClass) -> ClassifiedPart:
    return column_part("x", c)   # through the public loader, as a module would get it


class GuardTest(unittest.TestCase):
    def test_modules_cannot_build_parts(self):
        with self.assertRaises(TypeError):
            ClassifiedPart("text", "x", DataClass.C0, _token=object())

    def test_class_only_goes_up(self):
        self.assertEqual(part(DataClass.C2).at_least(DataClass.C1).data_class, DataClass.C2)
        self.assertEqual(part(DataClass.C1).at_least(DataClass.C3).data_class, DataClass.C3)

    def test_unknown_class_is_c3(self):
        self.assertEqual(DataClass.parse("C9"), DataClass.C3)
        self.assertEqual(DataClass.parse(None), DataClass.C3)

    def test_effective_class_is_the_maximum(self):
        eff, _ = check("demo.t", DataClass.C0, [part(DataClass.C1)], "cloud", OPS)
        self.assertEqual(eff, DataClass.C1)

    def test_refuses_above_ceiling(self):
        with self.assertRaises(AiRefused):
            check("demo.t", DataClass.C1, [part(DataClass.C2)], "cloud", OPS)

    def test_refuses_unlisted_and_unrouted(self):
        with self.assertRaises(AiRefused):
            check("demo.t", DataClass.C0, [], "other", OPS)
        with self.assertRaises(AiRefused):
            check("demo.t", DataClass.C0, [], NoneRouter().route("demo.t", DataClass.C0), OPS)

    def test_c3_only_local(self):
        self.assertEqual(check("demo.t", DataClass.C3, [], "local", OPS)[1].id, "local")
        bad = dict(OPS, cloud=OperatorProvider("cloud", "external", DataClass.C3, ()))
        with self.assertRaises(AiRefused):
            check("demo.t", DataClass.C3, [], "cloud", bad)

    def test_task_is_namespaced(self):
        with self.assertRaises(AiRefused):
            check("summarize", DataClass.C0, [], "local", OPS)

    def test_echo_is_deterministic(self):
        r = EchoProvider().generate("demo.t", [part(DataClass.C0)], {})
        self.assertEqual(r.output, {"task": "demo.t", "parts": 1})


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.prov = []
        self.ops = {"echo": OperatorProvider("echo", "local", DataClass.C3, ()),
                    "cloud": OperatorProvider("cloud", "external", DataClass.C1, ("api.example.com",))}

    def gw(self, provider_id):
        outer = self

        class Spy(EchoProvider):
            def generate(self, task, parts, schema):
                outer.calls.append(task)
                return super().generate(task, parts, schema)
        spy = Spy()
        spy.id = provider_id
        return AiGateway(FixedRouter(provider_id), {provider_id: spy}, self.ops,
                         lambda *a: (self.prov.append(a), "prov-1")[1])

    def test_guard_runs_before_the_provider(self):
        with self.assertRaises(AiRefused):
            self.gw("cloud").generate("demo.t", DataClass.C1, [text_part("secret", DataClass.C2)], {})
        self.assertEqual(self.calls, [])   # refused before any provider call

    def test_allowed_call_writes_provenance_with_hash_only(self):
        r = self.gw("echo").generate("demo.t", DataClass.C1, [text_part("conteúdo", DataClass.C1)], {})
        self.assertEqual((r.provider_id, r.provenance_id), ("echo", "prov-1"))
        task, pid, model, digest = self.prov[0]
        self.assertEqual(len(digest), 64)
        self.assertNotIn("conteúdo", repr(self.prov))

    def test_a_failing_provider_call_is_still_recorded(self):
        class Boom(EchoProvider):
            def generate(self, task, parts, schema):
                raise RuntimeError("provider failed after receiving the input")
        gw = AiGateway(FixedRouter("echo"), {"echo": Boom()}, self.ops, lambda *a: (self.prov.append(a), "prov-1")[1])
        with self.assertRaises(RuntimeError):
            gw.generate("demo.t", DataClass.C2, [text_part("x", DataClass.C2)], {})
        self.assertEqual(len(self.prov), 1)

    def test_raw_objects_are_not_parts(self):
        with self.assertRaises(AiRefused):
            self.gw("echo").generate("demo.t", DataClass.C0, ["plain string"], {})  # type: ignore[list-item]

    def test_text_part_never_lowers_the_job_class(self):
        self.assertEqual(text_part("x", DataClass.C2).data_class, DataClass.C2)
        self.assertEqual(column_part("x", None).data_class, DataClass.C3)

    def test_local_provider_with_external_egress_is_refused(self):
        bad = {"fake": OperatorProvider("fake", "local", DataClass.C3, ("api.external.example",))}
        with self.assertRaises(AiRefused):
            check("demo.t", DataClass.C3, [], "fake", bad)
        ok = {"ollama": OperatorProvider("ollama", "local", DataClass.C3, ("ollama.internal:11434",))}
        self.assertEqual(check("demo.t", DataClass.C3, [], "ollama", ok)[1].id, "ollama")

    def test_none_provider_refuses(self):
        with self.assertRaises(AiRefused):
            NoneProvider().generate("demo.t", [], {})


if __name__ == "__main__":
    unittest.main()
