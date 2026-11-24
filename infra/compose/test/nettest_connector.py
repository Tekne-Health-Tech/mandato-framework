"""The reference connector pointed at the network test's stand-in origin `allowed.test` (design 0004 §9). Test-only."""
from workers.core.tests.fixtures.ref_connector import ExemploItens


class ExemploItensNet(ExemploItens):
    manifest = {**ExemploItens.manifest, "hosts": ["allowed.test"], "terms_url": "https://allowed.test/termos"}

    def discover(self, ctx):
        return [{"id": f"itens-{ctx.params['uf']}", "url": "https://allowed.test/api/itens"}]
