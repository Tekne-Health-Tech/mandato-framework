"""Stand-in origin for the network test (design 0004 §9): serves the reference connector's two pages over HTTPS.
Test-only; runs on the `outside` network with a certificate from the test CA.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import json
import ssl
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PAGES = {"1": ([{"id": 1, "nome": " Alfa ", "valor": 10}, {"id": 2, "nome": "Beta", "valor": 20}], True),
         "2": ([{"id": 3, "nome": "Gama", "valor": None}], False)}


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urlsplit(self.path)
        if u.path == "/api/itens":
            items, more = PAGES.get(parse_qs(u.query).get("pagina", ["1"])[0], ([], False))
            body = json.dumps({"itens": items, "proxima": more}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        else:
            body = b"not found"
            self.send_response(404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


cert, key = sys.argv[1], sys.argv[2]
srv = ThreadingHTTPServer(("0.0.0.0", 443), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
