<!-- Codex (codex exec, read-only sandbox) review of design 0003 v1, saved as relayed; Codex answered in Portuguese. Only change: absolute local paths rewritten to repo-relative. -->

## Bloqueadores

1. **§§2, 3, 5 — contrato 0.1.2 incompleto.** Design usa `ctx.http()`, `params_schema`, `hosts` e `raw_refs`, mas declara somente duas adições; contratos atuais não possuem `ctx.http()` nem `params_schema` (workers/core/contracts/connector.py:8, workers/core/contracts/job.py:18). Implementação exigiria extensão não congelada. **Mudança:** definir todos os novos campos/tipos, mecanismo que entrega `raw_ref`, contexto restrito do connector e atualização/versionamento atômico dos contratos.

2. **§5.2 — criação de `data_source` impossível.** Runner promete "ensure" da linha, mas `worker_c1` recebe somente `select, update`; nenhum `insert` (packages/db/migrations/0001_core.sql:702). Primeira execução de fonte nova falha antes de criar run. **Mudança:** provisionar fontes via migrator/boot ou criar função definer estreita; não ampliar grant silenciosamente.

3. **§3 — boundary de egress permite SSRF e acesso cruzado.** Allowlist é união global. Connector A pode acessar host autorizado somente para connector B. Validação por hostname não bloqueia loopback, link-local, RFC1918, DNS rebinding ou mudança de IP após redirect. Sidecar e teste de rede ainda ficam fora do escopo. **Mudança:** allowlist por `source_id`; recusar destinos não públicos; resolver e validar cada salto, fixar IP da conexão mantendo TLS/SNI; validar redirects; tornar cliente in-process impossível em produção; bloquear release até teste real do sidecar.

4. **§3 — segredo não fica oculto do connector.** `JobContext` expõe `secret()` (workers/core/contracts/job.py:30); connector também controla `headers` e URL. Pode ler/logar chave ou exfiltrá-la para host permitido. Redirect pode carregar header sensível. `oauth` existe no contrato, mas fluxo não foi definido. **Mudança:** connector recebe contexto sem `secret()`; sidecar resolve referência opaca e injeta credencial somente no host configurado; headers sensíveis proibidos; credenciais removidas em redirects; implementar ou rejeitar explicitamente `oauth`.

5. **§5 — `concurrency = 1` não protege cursor.** `claim_job()` não aplica concorrência por source (packages/db/migrations/0001_core.sql:632). Jobs de minutos diferentes podem sobrepor: ambos leem mesmo cursor, fazem coleta e último commit sobrescreve avanço anterior. **Mudança:** lock DB por `source_id` cobrindo execução ou CAS versionado do cursor; teste com duas execuções simultâneas.

6. **§§4–5 — raw aceito desaparece do inventário.** Blob é gravado durante coleta, mas `raw_object` só entra no caminho `ok`. Runs `rejected`, `failed` ou processo morto deixam objetos sem linha; contradiz "every response body" e impede verificação por run. **Mudança:** registrar cada resposta aceita em transação lease-bound independente do resultado final; definir reconciliação para crash entre object store e DB; testar rejected, failed e kill.

7. **§4 — retenção indefinida tem premissa inválida.** Connector aceita C1, enquanto texto afirma "public C0 data" e conclui ausência de dever LGPD. DOU e APIs públicas ainda podem conter dados pessoais ou conteúdo publicado por engano. **Mudança:** remover conclusão legal; definir retenção configurável, prune auditado e resposta a remoção/takedown antes de produção.

8. **§§5–6 — commit do run e conclusão do job não são atômicos.** Processo pode confirmar normalized data/cursor/run `ok` e morrer antes de `finish_job`; job fica `running` para sempre. Morte durante coleta também não possui reclaim, heartbeat ou expiração de lease. **Mudança:** chamar `finish_job` na mesma transação que estado terminal do run quando possível; definir heartbeat e recuperação de `locked_at` expirado; testar crashes antes/depois de cada commit.

9. **§§4, 7 — novas tabelas não satisfazem contrato DB.** Design menciona owner e grants, mas omite `ENABLE/FORCE RLS`, políticas, classificação por coluna, trigger de auditoria, termos, restrições completas, ownership e atualização de `grants.md`. Tabela C1 ou tabela de módulo pode nascer sem auditoria/RLS, violando §4.3–§4.5. **Mudança:** especificar matriz completa para `raw_object` e tabelas normalizadas; CI deve verificar RLS, grants e audit trigger.

10. **§7 — `upsert_rows` não define formato válido do batch.** Records podem ter conjuntos de colunas diferentes, natural key ausente no runtime ou duplicatas atravessando batches; SQL pode falhar após coleta ou produzir stats incorretos. Contract suite valida somente fixtures. **Mudança:** exigir e validar shape uniforme, natural key não nula/única no lote completo, lista não vazia e colunas permitidas antes do primeiro statement.

11. **§§8–9 — claims DB/licença podem nunca executar.** Verificação crítica é condicional a `TEST_DB`, mas CI atual não define isso para testes Python nem instala `pg8000` (.github/workflows/ci.yml:36). Licença direta BSD não cobre transitivas sem manifesto/lock analisável. **Mudança:** executar contract suite DB obrigatoriamente no job Postgres; adicionar instalação reproduzível com versão exata e hashes; verificar licenças transitivas; eliminar critério temporal não reproduzível de "duas semanas".

## Notas não bloqueantes

- `RETURNING (xmax = 0)` depende de detalhe interno do PostgreSQL; documentar suporte a PG16 e testar triggers/updates.
- Definir comportamento fail-closed para erro/redirect de `robots.txt` e se request de robots consome rate limit.
- Logs de validação/exceção precisam estrutura, limite e redaction; "public" não autoriza despejar records.
- `raw_object` deveria guardar path sanitizado ou identificador de recurso para auditoria útil, sem query string.

Nenhuma alteração feita. Risco residual: revisão documental; migration `0004_core.sql` e implementação ainda inexistentes.

**VERDICT: REQUEST CHANGES — 11 blockers.**
