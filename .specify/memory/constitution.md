# Distributed Wagering Processor Constitution

## Core Principles

### I. Correção Financeira (NÃO NEGOCIÁVEL)

- Valores monetários NÃO DEVEM ser representados por `number`, `float` ou `double` em nenhuma
  camada (domínio, contratos, persistência, testes).
- Dinheiro DEVE ser um value object imutável (`Money`), com escala fixa de 2 casas, recebido e
  serializado como string decimal, e com moeda ISO-4217 explícita.
- Operações entre moedas diferentes DEVEM falhar com erro de domínio.
- O saldo de uma wallet NUNCA pode ficar negativo.
- Toda alteração de saldo DEVE ter exatamente um lançamento correspondente no ledger, e todo
  lançamento DEVE corresponder a uma alteração de saldo. A invariante
  `saldo materializado == saldo reconstruído pelo ledger` DEVE valer ao final de qualquer
  operação, falha ou reinício.
- O ledger é append-only: lançamentos NÃO DEVEM ser alterados nem excluídos.

**Rationale**: o sistema movimenta dinheiro real; arredondamento, duplicidade ou perda de
lançamento são falhas eliminatórias e destroem a auditabilidade.

### II. Invariantes Garantidas pelo Banco de Dados

- Unicidade (wallet por jogador + moeda, idempotency key, mensagem de inbox, lançamento por
  transação + wallet), imutabilidade do ledger e não-negatividade do saldo DEVEM ser aplicadas
  por constraints, índices únicos e/ou triggers no schema, além do código de aplicação.
- O código de aplicação é a primeira linha de defesa; o schema é a garantia final.
- Migrations DEVEM ser versionadas e reversíveis.

**Rationale**: com múltiplas instâncias e falhas parciais, só o banco compartilhado observa
todas as escritas; uma regra que vive só em código pode ser contornada por uma corrida.

### III. Idempotência Persistente

- O efeito de cada operação DEVE ocorrer no máximo uma vez, mesmo com entrega at-least-once,
  redelivery, retries e requisições paralelas idênticas.
- A deduplicação DEVE ser persistente e transacional. Cache em memória NÃO DEVE ser usado como
  garantia de idempotência.
- A mesma chave de idempotência com payload de negócio diferente é conflito, nunca replay.
- Um replay DEVE devolver o resultado original, incluindo o saldo observado naquele momento.

**Rationale**: entrega exactly-once não existe em sistemas distribuídos; o que se garante é
efeito exactly-once.

### IV. Concorrência por Wallet e Correção Multi-instância

- A unidade de concorrência é a wallet. NÃO DEVE existir lock global compartilhado por todas
  as wallets; wallets distintas DEVEM poder ser processadas em paralelo.
- Saldo NÃO DEVE ser atualizado por `read → calculate → update` sem controle de concorrência
  (lock pessimista, versão otimista com retry limitado ou update atômico condicionado).
- A solução DEVE estar correta com três ou mais instâncias simultâneas da aplicação.
- Recursos de ordenação e deduplicação do broker (ex.: SQS FIFO) são otimização, nunca a
  garantia de consistência.

**Rationale**: lost update em saldo é perda financeira direta e falha eliminatória.

### V. Atomicidade e Mensageria Confiável

- Registro da transação, alteração de saldo, lançamento no ledger, registro de inbox (entrada
  por fila) e evento de integração (outbox) DEVEM ser confirmados na mesma transação SQL.
- Eventos NÃO DEVEM ser publicados antes do commit da transação financeira.
- Mensagens de fila DEVEM ser confirmadas (ack) somente após o commit.
- Erros DEVEM ser classificados em negócio (terminal, ack), transitório (retry com backoff) e
  permanente (DLQ após limite de tentativas).
- Publicação da outbox é at-least-once e DEVE suportar múltiplos publishers concorrentes sem
  perder eventos; consumidores DEVEM tolerar eventos duplicados.
- No shutdown (`SIGTERM`) o processo DEVE concluir o trabalho em andamento ou devolvê-lo.

**Rationale**: o problema do dual write (banco + broker) só é resolvido sem perda nem anúncio
falso quando o evento nasce dentro da mesma transação que o efeito.

### VI. Domínio Encapsulado

- Agregados, entidades e value objects DEVEM ter construtor `private`/`protected` e factories
  estáticas explícitas (`create`/`open`/`from` validam; `rehydrate` apenas reconstrói estado
  persistido, sem revalidar transições).
- Transições de estado DEVEM ser explícitas; estados terminais (`PROCESSED`, `REJECTED`,
  `FAILED`) não mudam, e tentar transicioná-los é erro de programação.
- O domínio NÃO DEVE depender do framework (NestJS) nem de tipos do ORM; infraestrutura entra
  por portas e adaptadores.
- Entrada HTTP e entrada por fila DEVEM reutilizar o mesmo caso de uso.

**Rationale**: invariantes encapsuladas não podem ser violadas por quem usa o objeto, e o
domínio fica testável sem infraestrutura.

### VII. Testes com Infraestrutura Real

- Testes de integração e concorrência DEVEM rodar contra PostgreSQL e SQS (LocalStack/MiniStack)
  reais em containers; substituí-los completamente por mocks é proibido.
- Testes de concorrência DEVEM usar paralelismo real (incluindo múltiplos processos), não
  execuções sequenciais simuladas.
- Todo teste que movimenta saldo DEVE verificar ao final que o saldo materializado é igual ao
  saldo reconstruído pelo ledger.
- Testes DEVEM ser determinísticos.

**Rationale**: corridas e falhas parciais só aparecem com a infraestrutura e o paralelismo reais.

### VIII. Observabilidade, Clareza e Simplicidade

- Logs DEVEM ser estruturados (JSON) e carregar `correlationId`, `messageId`, `transactionId`,
  `walletId` e `providerId`, sem dados sensíveis nem payloads financeiros completos.
- Métricas DEVEM cobrir, no mínimo: transações por status, duplicatas detectadas, retries,
  mensagens em DLQ, conflitos de lock, outbox lag e latência de processamento.
- Liveness e readiness DEVEM ser expostos separadamente e sem autenticação.
- Divergências de reconciliação NÃO DEVEM ser corrigidas silenciosamente.
- Toda decisão técnica relevante, trade-off e limitação DEVE ser justificada em
  `ARCHITECTURE.md`. Complexidade adicional DEVE ser justificada; na dúvida, a solução mais
  simples que preserve as invariantes vence.

**Rationale**: a avaliação valoriza raciocínio claro e decisões justificadas tanto quanto o código.

## Stack e Restrições Técnicas

- Runtime, gerenciador de pacotes e test runner: Bun 1.x.
- Linguagem: TypeScript em modo estrito.
- Framework: NestJS.
- Banco: PostgreSQL. ORM: MikroORM (preferencial) ou TypeORM; Prisma e outros ORMs estão fora
  do escopo.
- Mensageria: AWS SQS via LocalStack ou MiniStack, com filas `wager-transactions.fifo` e
  `wager-transactions-dlq.fifo`.
- Orquestração local: Docker Compose.
- Autenticação, se implementada, DEVE usar um Identity Provider externo (ex.: Keycloak,
  Zitadel); autenticação artesanal com tabela de usuários e hash de senha é proibida.
- Escopo monetário: uma única moeda operacional (`BRL`) é aceita, desde que o modelo continue
  multi-moeda e os conflitos de moeda sejam testados.

## Fluxo de Desenvolvimento e Quality Gates

- Fluxo spec-driven: constitution → specify → clarify → plan → tasks → implement.
- Antes de considerar qualquer entrega pronta, as falhas eliminatórias DEVEM ser verificadas
  como ausentes: `number` para dinheiro; saldo negativo por race; débito ou crédito duplicado;
  idempotência só em memória; correção só com uma instância; evento publicado antes do commit;
  ausência de ledger auditável; testes que substituem totalmente PostgreSQL e SQS por mocks.
- Os cenários obrigatórios de concorrência e falha da especificação DEVEM ter testes
  automatizados correspondentes.
- `README.md` DEVE conter setup e comandos; `ARCHITECTURE.md` DEVE conter decisões, trade-offs
  e limitações.

## Governance

- Esta constituição prevalece sobre qualquer outra prática do projeto. Planos, tarefas e
  revisões DEVEM verificar conformidade com ela.
- Emendas DEVEM ser documentadas neste arquivo, com justificativa e atualização de versão.
- Versionamento semântico: MAJOR para remoção ou redefinição incompatível de princípio; MINOR
  para princípio ou seção nova; PATCH para esclarecimentos de redação.
- Qualquer violação consciente de um princípio DEVE ser registrada em `ARCHITECTURE.md` com
  motivo e alternativa rejeitada.

**Version**: 1.0.0 | **Ratified**: 2026-11-02 | **Last Amended**: 2026-11-02
