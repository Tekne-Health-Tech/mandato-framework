"""Reference connector for the kit's own tests: a fictitious paginated JSON list (design 0003 §9)."""
import json

from workers.core.contracts.classes import DataClass

HOST = "dados.exemplo.gov.br"


class ExemploItens:
    manifest = {
        "source_id": "exemplo-itens", "name": "Itens de exemplo", "terms_url": "https://dados.exemplo.gov.br/termos",
        "robots": "obey", "auth": "none", "auth_secret_ref": None, "auth_header": None, "hosts": [HOST],
        "rate_limit_per_min": 60, "data_class": DataClass.C0, "natural_key": ["codigo"],
        "target_table": "mod_hello.exemplo_item", "sync": "snapshot", "deleted_column": None,
    }
    params_schema = {"type": "object", "additionalProperties": False, "required": ["uf"],
                     "properties": {"uf": {"type": "string", "pattern": "^[A-Z]{2}$"}}}

    def discover(self, ctx):
        return [{"id": f"itens-{ctx.params['uf']}", "url": f"https://{HOST}/api/itens"}]

    def fetch(self, resource, cursor, ctx):
        items, refs, page = [], [], 1
        while True:
            r = ctx.http().get(resource["url"], params={"uf": ctx.params["uf"], "pagina": str(page)}, headers={"Accept": "application/json"})
            refs.append(r["raw_ref"])
            data = json.loads(r["body"])
            items += data["itens"]
            if not data.get("proxima"):
                break
            page += 1
        return {"resource": resource, "fetched_at": None, "items": items, "cursor": {"paginas": page}, "raw_refs": refs}

    def normalize(self, raw):
        return [{"codigo": str(i["id"]), "nome": i["nome"].strip(), "valor": i.get("valor")} for i in raw["items"]]

    def validate(self, records):
        errors = [{"code": "missing_field", "path": f"records[{n}].{k}"}
                  for n, r in enumerate(records) for k in ("codigo", "nome") if not r.get(k)]
        return {"errors": errors, "warnings": []}


def page(items, more):
    return 200, {"content-type": "application/json"}, json.dumps({"itens": items, "proxima": more}).encode()


FIXTURES = {
    f"https://{HOST}/api/itens?pagina=1&uf=EX": page([{"id": 1, "nome": " Alfa ", "valor": 10}, {"id": 2, "nome": "Beta", "valor": 20}], True),
    f"https://{HOST}/api/itens?pagina=2&uf=EX": page([{"id": 3, "nome": "Gama", "valor": None}], False),
}
