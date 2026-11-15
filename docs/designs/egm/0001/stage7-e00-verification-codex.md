<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

### (a) DoD ausente ou não conforme

- **blocker — Projeções não são validadas contra Appendix A.** [publish.js](packages/core-publish/src/publish.js:8) usa regex de prefixos. Expressão C0 falsa como `to_jsonb(app_user)` gera SQL e publica `pii_name`/`pii_email`.

- **blocker — CI não implementa checks estáticos de provider exigidos por §7.5.** [ci.yml](.github/workflows/ci.yml:18) não detecta SDKs externos fora de `providers`, instanciação direta de provider ou chamadas HTTP externas.

- **should-fix — Auditoria não cobre todas tabelas C1+.** Lista de triggers em [0001_core.sql](packages/db/migrations/0001_core.sql:517) omite `data_source`, `data_source_run`, `job`, `ai_provenance`, `role`, `permission`, `idempotency` e `rate_counter`. Atualização de `data_source.cursor`, por exemplo, deixa nenhum evento.

- **should-fix — Identificação de linhas auditadas incompleta.** [audit.row_trigger](packages/db/migrations/0001_core.sql:504) extrai somente coluna `id`. Alteração em `content_version`, `content_cause` ou `role_permission` grava `entity_id = null`.

- **should-fix — Retenção de auditoria não implementada.** Existem `audit_archiver` e triggers imutáveis, mas falta procedimento de arquivamento, cópia, hash e exclusão após cinco anos exigido por §4.5. Também falta purga de `audit.tx_lease` após uma hora.

- **should-fix — Comentários divergem de Appendix A.** Gerador em [0001_core.sql](packages/db/migrations/0001_core.sql:372) classifica `core.data_source.created_at` e `updated_at` como C0; Appendix A define C1.

- **should-fix — Fixture de manifest não valida contra próprio schema.** [manifest-v1.json](packages/core-publish/vectors/manifest-v1.json:1) contém `note_unicode`, rejeitado por `additionalProperties: false` em [bundle.schema.json](packages/core-publish/schema/bundle.schema.json:5).

- **should-fix — Demo semanticamente incompleto.** [tenant.yaml](tenants/demo/tenant.yaml:28) referencia `ibge-municipios`, `core.content` e `core.agenda`, mas nenhum manifest/connector correspondente existe. CI valida somente formato JSON Schema.

- **should-fix — Module schema aceita colisões de autoridade.** [module.schema.json](packages/core-contracts/schema/module.schema.json:15) não exige namespace em roles/permissões. Manifest declarando role `chefe_gabinete` e permission `core.content.publish` passa.

- **should-fix — Demo module migration não entra no CI.** Workflow compila TS, mas nunca aplica [0001_hello.sql](tenants/demo/modules/hello/db/migrations/0001_hello.sql:1).

- **note — Artefatos literais ausentes.** §11 cita `NoneProvider`; [ai.py](workers/core/contracts/ai.py:98) contém somente `NoneRouter` e `EchoProvider`. Layout E0.0 também lista `apps/web`, `apps/mobile` e `packages/core-domain`; paths não existem.

### (b) Defeitos de segurança não cobertos

- **blocker — Superfície PostgREST não fica fail-closed (§4.1).** Migração não revoga `USAGE` de `public` para `anon`/`authenticated` e CI não verifica exposed schema igual a `api`. Cenário: instalação mantém PostgREST em `public`; cliente acessa objeto público apesar da promessa “only `api`”.

- **blocker — Roles preexistentes preservam privilégios perigosos (§4.1).** [0001_core.sql](packages/db/migrations/0001_core.sql:8) só endurece roles quando cria. Cenário: `worker_c1` já existe com `BYPASSRLS`; migração termina e role continua ignorando RLS. Teste usa banco fresco, portanto não detecta.

- **blocker — Sessão anônima `api_rt` alcança wrapped C2 keys (§4.1/§4.6).** Policy em [0001_core.sql](packages/db/migrations/0001_core.sql:673) não exige `aal2`, staff ou permission. Cenário: SQL injection em endpoint público executado como `api_rt` lê `core.data_key` C2, contrariando regra de que claims anônimos alcançam somente tabelas abertas para público.

- **blocker — `audit.write` aceita valores pessoais arbitrários (§4.5).** [audit.write](packages/db/migrations/0001_core.sql:447) persiste qualquer `p_details`. Cenário: endpoint público chama `audit.write(..., '{"pii_email":"pessoa@example.org"}')`; plaintext C2 entra em tabela C1 retida por cinco anos.

- **blocker — Revogação assinada de chave é ignorada (§6.3).** [evaluateManifest](packages/core-publish/src/manifest.js:34) não processa `keyring_update`. Cenário confirmado: manifest válido com `keyring_update.revoke=["demo-test"]` retorna `accept: true`, sem revogar chave; manifest posterior assinado por chave comprometida continua aceito.

- **should-fix — Keyring admite estado ambíguo (§6.3).** [tenant.schema.json](packages/core-config/schema/tenant.schema.json:111) aceita duas entradas `current` idênticas ou mesmo `key_id` com chaves diferentes. Cenário: verificador escolhe primeira entrada; rotação pretendida fica inacessível.

- **blocker — Guard AI não controla chamada real (§7.5).** `AiGateway` é somente `Protocol`; `check()` fica solto em [ai.py](workers/core/contracts/ai.py:76). Cenário: módulo instancia `AiProvider` e chama `generate()` diretamente; ceiling, locality e provenance são ignorados, e CI não acusa.

- **blocker — Configuração permite C3 “local” com egress externo (§7.5).** Schema aceita `{locality:"local", max_data_class:"C3", egress:["api.external.example"]}` e `check()` aprova. Cenário: sidecar rotulado local recebe C3 e alcança host externo permitido.

### (c) Testes verdes pelo motivo errado

- **blocker — Negative projection testa nome, não classe.** [contracts.test.js](tests/contracts.test.js:49) e [demo-published.test.js](tests/demo-published.test.js:58) rejeitam `pii_email` literal; `to_jsonb(app_user)` passa e vaza mesmas colunas.

- **should-fix — Grant matrix prova reprodução, não mínimo privilégio.** [ci.yml](.github/workflows/ci.yml:62) compara saída atual com snapshot atual. Grants desnecessários como `audit.row_trigger()` para runtime roles permanecem verdes; regra “nothing granted that no lane needs” nunca é avaliada.

- **should-fix — RFC 8785 vector é autocertificado.** [make-vectors.js](packages/core-publish/vectors/make-vectors.js:4) usa mesma `canonicalize()` testada para produzir valor esperado. Mesmo bug no gerador e verificador mantém teste verde.

- **blocker — Teste “revoked key” não testa rotação assinada.** [manifest.test.js](tests/manifest.test.js:26) injeta `revoked: true` diretamente no keyring. Não testa `keyring_update`; implementação ignora mecanismo real.

- **should-fix — Teste de opacidade importa segredo construtor.** [test_contracts.py](workers/core/tests/test_contracts.py:3) importa `_LOADER_TOKEN` e constrói `ClassifiedPart`. Teste verde não prova “only framework constructs it”; demonstra que qualquer módulo pode construir.

- **should-fix — Demo tenant “valid” prova apenas sintaxe.** [contracts.test.js](tests/contracts.test.js:23) não resolve modules, `settings_schema` ou connector `source_id`. Referências inexistentes permanecem verdes.

E0.0 not accepted