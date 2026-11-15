<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

Resultado: 7 fechados, 3 abertos. Um novo blocker introduzido por `2490df6`. Residual cross-module aceito foi excluído.

1. **Aberto — migration ainda pode escapar para `core` em instalação existente.**  
   `0001_core.sql` já aplicado não roda novamente: `bootstrap()` pula quando `core` existe. Logo, `migrator` conserva membership antiga em `core_owner`. Failing SQL, aceito pelo lint:

   ```sql
   SET LOCAL ROLE core_owner;
   SET LOCAL SCHEMA 'core';
   CREATE TABLE escaped(id integer);
   ```

   `SET LOCAL ROLE` e `SET LOCAL SCHEMA` não casam com `FORBIDDEN`. Referências: [migrate.js:32](packages/db/src/migrate.js:32), [migrate.js:69](packages/db/src/migrate.js:69).

2. **Fechado — migration aplicada e apagada.**  
   Log agora é comparado contra conjunto presente para módulos habilitados. [migrate.js:92](packages/db/src/migrate.js:92)

3. **Fechado — `short` duplicado.**  
   `shorts` detecta colisão entre manifests carregados. [load.js:58](packages/core-config/src/load.js:58)

4. **Aberto — credencial inline ainda aceita.**  
   Detecção continua heurística e omite nome comum `key`. Failing input confirmado com `checkTenant()` retornando `[]`:

   ```yaml
   connectors:
     - source_id: example
       schedule: "0 0 * * *"
       params:
         key: SYNTHETIC_CREDENTIAL
   ```

   [check.js:3](packages/core-config/src/check.js:3)

5. **Fechado — compatibilidade e dependências.**  
   `requires_framework` incompatível/malformado e módulo não habilitado agora geram erro. [load.js:75](packages/core-config/src/load.js:75)

6. **Aberto — symlink escapa da raiz.**  
   `inside()` faz contenção lexical, sem `realpath`. Failing input:

   ```text
   tenant/theme-link -> /outside
   theme: theme-link/tokens.json
   ```

   `inside('/tenant', 'theme-link/tokens.json')` retorna `/tenant/theme-link/tokens.json`; `readFileSync` segue symlink. Mesmo problema vale para `settings_schema` e `migrations`. [load.js:29](packages/core-config/src/load.js:29)

7. **Fechado — `--strcit`.**  
   Argumento desconhecido retorna usage/exit 2. [mandato.js:20](packages/core-config/bin/mandato.js:20)

8. **Fechado — cause slug duplicado.**  
   [check.js:33](packages/core-config/src/check.js:33)

9. **Fechado — font family malformada.**  
   Ambos inputs originais, `"` e `foo'bar`, são rejeitados. [tokens.schema.json:30](packages/core-theme/schema/tokens.schema.json:30)

10. **Fechado — JSON referenciado inválido.**  
    Theme, manifest e `settings_schema` retornam erros de validação; compilação AJV também está protegida. [load.js:36](packages/core-config/src/load.js:36)

**Novo finding — upgrade de banco existente fica bloqueado.**  
`2490df6` altera `0001_core.sql`, já registrado por hash. Failing situation: banco criado no commit anterior executa `mandato migrate`; comparação acusa `core:0001_core.sql changed after it was applied`. Nenhuma forward migration entrega revogação de `core_owner`. [migrate.js:101](packages/db/src/migrate.js:101)

Verificação: suíte Node `62/62` verde. Suíte PostgreSQL não executada: servidor local respondeu `no response`. Não marquei wrapper `EXECUTE` como finding sem prova runtime; documentação PostgreSQL confirma execução dinâmica pelo engine e suporte SPI a múltiplos comandos: [PL/pgSQL `EXECUTE`](https://www.postgresql.org/docs/17/plpgsql-statements.html), [`SPI_execute`](https://www.postgresql.org/docs/16/spi-spi-execute.html).

Verdict: ainda bloqueado por 1, 4, 6 e novo finding de upgrade. Nenhum arquivo alterado.