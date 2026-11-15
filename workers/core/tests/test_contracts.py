import unittest

from workers.core.contracts.ai import (AiRefused, ClassifiedPart, EchoProvider, NoneRouter, OperatorProvider,
                                       _LOADER_TOKEN, check)
from workers.core.contracts.classes import DataClass

OPS = {
    "local": OperatorProvider("local", "local", DataClass.C3, ()),
    "cloud": OperatorProvider("cloud", "external", DataClass.C1, ("api.example.com",)),
}


def part(c: DataClass) -> ClassifiedPart:
    return ClassifiedPart("text", "x", c, _token=_LOADER_TOKEN)


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


if __name__ == "__main__":
    unittest.main()
