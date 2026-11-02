# Feature Specification: Distributed Wagering Processor

**Feature Branch**: `spec/wagering-processor`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "Analisar o requerimento do desafio técnico da Jungle Gaming
(README.md): serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS,
REFUND, ROLLBACK) recebidas de múltiplos provedores de jogos, por HTTP e por fila, mantendo
correção financeira sob duplicidade, entrega fora de ordem, concorrência entre instâncias e
falhas de processo."

## Clarifications

### Session 2026-11-02

- Q: Se o provedor mandar a mesma transação (mesmo provedor + id externo) com outra chave de
  idempotência, é conflito? → A: Sim. A chave de idempotência e o par (provedor, id externo)
  são únicos ao mesmo tempo; chave diferente para o mesmo par é conflito, sem efeito.
- Q: Quando a referência aguardada chega rejeitada (ou já estava rejeitada), o que acontece
  com a reversão? → A: É rejeitada imediatamente com `REFERENCE_NOT_PROCESSED`, sem esperar o
  prazo; a espera só vale enquanto a referência ainda pode mudar de estado.
- Q: Rejeição de negócio é erro ou operação concluída com resultado "rejeitada"? → A: Tem
  categoria de resposta própria, distinta de sucesso e dos demais erros (HTTP 422 com
  `failureCode`); cada situação tem seu código e o replay repete o código do resultado original.
- Q: Por quanto tempo uma operação aguarda a referência, e com que ritmo de tentativas? → A:
  TTL de 1 hora desde a chegada; backoff exponencial a partir de 1 s, teto de 5 min, com jitter
  (cerca de 20 tentativas); todos os valores configuráveis.
- Q: Quando uma transação termina em `FAILED`, e qual a diferença para a DLQ? → A: `FAILED` só
  para erro permanente não-negocial com banco acessível (bug, constraint inesperada, tentativas
  esgotadas), gravado com código e evento, seguido de ack; DLQ quando não é possível gravar
  (banco inacessível ou mensagem ilegível). Erro transitório nunca vira `FAILED`.

## User Scenarios & Testing *(mandatory)*

**Atores**:

- **Provedor de jogos**: sistema externo que envia operações de uma rodada para a carteira do
  jogador e decide, pela resposta, se reenvia, corrige ou desiste.
- **Operador da plataforma**: abre carteiras, consulta saldos e extratos, audita e reconcilia.
- **Sistemas consumidores**: serviços internos que reagem aos eventos financeiros publicados.
- **Equipe de operação (SRE)**: monitora saúde, filas, falhas e métricas.

### User Story 1 - Abrir carteira com saldo inicial (Priority: P1)

O operador abre uma carteira para um jogador, em uma moeda, opcionalmente com saldo inicial.
O saldo inicial é registrado como um crédito auditável de abertura.

**Why this priority**: toda outra operação depende de uma carteira existente e auditável.

**Independent Test**: abrir uma carteira com saldo inicial e verificar que o saldo, o extrato
(um crédito de abertura) e a versão inicial estão corretos; tentar abrir uma segunda carteira
para o mesmo jogador e moeda e receber conflito.

**Acceptance Scenarios**:

1. **Given** um jogador sem carteira em BRL, **When** o operador abre uma carteira com
   `1000.00 BRL`, **Then** a carteira é criada com saldo `1000.00 BRL`, versão 1 e exatamente
   um lançamento de crédito de abertura no extrato.
2. **Given** um jogador sem carteira, **When** o operador abre uma carteira com saldo `0.00`,
   **Then** a carteira é criada sem nenhum lançamento no extrato.
3. **Given** um jogador que já tem carteira em BRL, **When** o operador tenta abrir outra em
   BRL, **Then** a operação falha como conflito e nada é criado.
4. **Given** um pedido com saldo inicial inválido (negativo, mais de 2 casas, notação
   científica, vazio), **When** é submetido, **Then** é rejeitado como payload inválido.

---

### User Story 2 - Debitar aposta com segurança (Priority: P1)

O provedor envia uma aposta (BET). O valor é debitado se houver saldo; caso contrário, a
aposta é rejeitada com um código de falha estável, sem alterar saldo.

**Why this priority**: é a operação financeira central e a mais sujeita a corridas.

**Independent Test**: com saldo `100.00`, enviar simultaneamente duas apostas de `80.00` e
verificar exatamente uma processada, uma rejeitada por saldo insuficiente, saldo final
`20.00` e um único débito no extrato.

**Acceptance Scenarios**:

1. **Given** saldo `1000.00 BRL`, **When** chega uma BET de `25.00 BRL`, **Then** ela é
   processada, o saldo passa a `975.00` e há um lançamento de débito com saldo antes `1000.00`
   e depois `975.00`.
2. **Given** saldo `10.00`, **When** chega uma BET de `25.00`, **Then** ela é rejeitada com
   código de saldo insuficiente, o saldo continua `10.00` e nenhum lançamento é criado.
3. **Given** saldo `100.00`, **When** duas BETs de `80.00` distintas chegam ao mesmo tempo
   (inclusive em instâncias diferentes), **Then** exatamente uma é processada, a outra é
   rejeitada por saldo insuficiente, o saldo final é `20.00` e existe um único débito.
4. **Given** uma carteira em BRL, **When** chega uma BET em outra moeda, **Then** ela é
   rejeitada por conflito de moeda sem alterar saldo.
5. **Given** que a carteira, o jogador ou o provedor da operação não correspondem entre si,
   **When** a operação chega, **Then** ela é rejeitada com código específico.

---

### User Story 3 - Reenvio sem efeito duplicado (Priority: P1)

O provedor pode reenviar a mesma operação várias vezes (por timeout, retry ou duplicação no
transporte). O efeito financeiro ocorre uma única vez, e cada reenvio recebe o resultado
original.

**Why this priority**: a entrega é at-least-once; sem isso há crédito/débito duplicado, uma
falha eliminatória.

**Independent Test**: enviar a mesma BET 50 vezes em paralelo e verificar um único débito,
49 respostas marcadas como replay com o mesmo resultado e saldo originais.

**Acceptance Scenarios**:

1. **Given** uma BET já processada, **When** a mesma operação (mesma chave e mesmo conteúdo)
   chega de novo, **Then** a resposta é o resultado original, incluindo o saldo observado na
   época, marcada como replay, e o saldo não muda.
2. **Given** uma BET já processada, **When** chega a mesma chave de idempotência com conteúdo
   de negócio diferente (ex.: outro valor), **Then** a resposta é conflito de idempotência,
   distinta de replay e de rejeição de negócio, e nada é alterado.
3. **Given** a mesma operação enviada 50 vezes em paralelo, **When** todas são processadas,
   **Then** existe exatamente um efeito financeiro e um lançamento.
4. **Given** uma operação rejeitada, **When** ela é reenviada, **Then** a resposta repete a
   rejeição original, com o mesmo código.
5. **Given** que o serviço reiniciou entre o envio original e o reenvio, **When** o reenvio
   chega, **Then** ele ainda é reconhecido como replay.
6. **Given** uma BET processada com id externo `transaction-123`, **When** chega a mesma
   operação com outra chave de idempotência, **Then** a resposta é conflito e não há segundo
   débito.

---

### User Story 4 - Liquidar rodada com ganho ou perda (Priority: P2)

Ao fim de uma rodada o provedor informa o resultado: WIN credita o prêmio; LOSS registra a
perda sem mover saldo.

**Why this priority**: completa o ciclo da rodada; depende das histórias 1–3.

**Independent Test**: após uma BET processada, enviar WIN e verificar o crédito; em outra
rodada enviar LOSS e verificar que o saldo e o extrato não mudam, mas o resultado é registrado.

**Acceptance Scenarios**:

1. **Given** uma BET processada na rodada R, **When** chega WIN de `50.00` na rodada R,
   **Then** o saldo aumenta `50.00` e há um lançamento de crédito.
2. **Given** uma BET processada, **When** chega LOSS, **Then** a operação é registrada como
   processada, o saldo não muda e nenhum lançamento é criado.
3. **Given** um WIN que referencia uma BET, **When** a referência é de outra rodada, outro
   jogador, outra carteira, outra moeda ou outro provedor, **Then** ele é rejeitado.
4. **Given** uma rodada sem nenhuma BET (ex.: free spin), **When** chega WIN sem referência,
   **Then** ele é processado e o saldo é creditado.
5. **Given** uma BET já reembolsada, **When** chega WIN referenciando essa BET, **Then** ele é
   rejeitado com código de referência revertida, sem crédito.
6. **Given** um WIN que referencia uma BET que ainda não chegou, **When** ele é recebido,
   **Then** fica "aguardando referência" e é aplicado quando a BET for processada.

---

### User Story 5 - Reverter operações, inclusive fora de ordem (Priority: P2)

O provedor pode cancelar uma aposta (REFUND) ou desfazer uma operação já aplicada (ROLLBACK).
A reversão pode chegar antes da operação que ela referencia; nesse caso fica aguardando e é
reprocessada automaticamente.

**Why this priority**: reversões são frequentes em iGaming e são o ponto onde mais surgem
duplicidades e saldos negativos.

**Independent Test**: enviar um ROLLBACK antes da BET correspondente, verificar o estado
"aguardando referência", enviar a BET e verificar que o ROLLBACK é aplicado depois, com saldo
final igual ao inicial.

**Acceptance Scenarios**:

1. **Given** uma BET processada de `25.00`, **When** chega REFUND de `25.00` referenciando-a,
   **Then** `25.00` volta ao saldo com um lançamento de crédito.
2. **Given** uma BET já reembolsada, **When** chega outro REFUND para ela, **Then** ele é
   rejeitado por reversão já aplicada.
3. **Given** um WIN processado de `50.00`, **When** chega ROLLBACK referenciando-o, **Then** o
   saldo diminui `50.00` com lançamento de débito.
4. **Given** um ROLLBACK de WIN cujo débito deixaria o saldo negativo, **When** ele é
   processado, **Then** é rejeitado com código próprio (diferente de saldo insuficiente em
   aposta) e fica auditável.
5. **Given** um REFUND/ROLLBACK com valor diferente da referência, **When** ele chega,
   **Then** é rejeitado (reversão parcial fora de escopo).
6. **Given** um REFUND que referencia algo que não é BET, **When** ele chega, **Then** é
   rejeitado.
7. **Given** um ROLLBACK cuja referência ainda não existe, **When** ele chega, **Then** fica
   em "aguardando referência" e é retentado automaticamente com espera crescente; se a
   referência chegar dentro do limite, a reversão é aplicada.
8. **Given** um ROLLBACK aguardando referência, **When** o limite de tentativas ou tempo se
   esgota, **Then** ele é rejeitado com código de referência inexistente e um evento de
   rejeição é emitido.
9. **Given** um REFUND ou ROLLBACK sem identificador de referência, **When** ele chega,
   **Then** é rejeitado como payload inválido.
10. **Given** um REFUND aguardando referência, **When** a BET referenciada chega e é rejeitada
    por saldo insuficiente, **Then** o REFUND é rejeitado na próxima verificação com
    `REFERENCE_NOT_PROCESSED`, sem esperar o prazo e sem alterar saldo.
11. **Given** uma BET já rejeitada, **When** chega um REFUND referenciando-a, **Then** ele é
    rejeitado imediatamente com `REFERENCE_NOT_PROCESSED`.

---

### User Story 6 - Processar operações recebidas por fila, com recuperação de falhas (Priority: P2)

Provedores também enviam operações por uma fila. O consumo segue as mesmas regras da entrada
síncrona, tolera mensagens duplicadas, reentregues ou interrompidas por queda do processo, e
separa falhas definitivas para análise.

**Why this priority**: é o caminho de maior volume e onde ocorrem as falhas parciais.

**Independent Test**: publicar uma mensagem, matar o worker depois de confirmar a transação
e antes de confirmar a mensagem, deixar a mensagem ser reentregue e verificar um único efeito.

**Acceptance Scenarios**:

1. **Given** uma mensagem válida na fila, **When** é consumida, **Then** produz o mesmo
   resultado que a submissão síncrona equivalente.
2. **Given** uma mensagem já processada, **When** ela é reentregue, **Then** não há novo
   efeito.
3. **Given** um worker que cai depois de gravar o resultado e antes de confirmar a mensagem,
   **When** a mensagem reaparece, **Then** ela é reconhecida como já processada e confirmada,
   sem novo efeito.
4. **Given** uma rejeição de negócio, **When** a mensagem é consumida, **Then** a mensagem é
   confirmada (não é retentada).
5. **Given** indisponibilidade temporária do banco, **When** a mensagem é consumida, **Then**
   ela é retentada com espera crescente, sem efeito parcial.
6. **Given** uma mensagem que falha repetidamente até o limite de tentativas, **When** o
   limite é atingido, **Then** ela vai para a fila de mensagens mortas (DLQ).
7. **Given** um sinal de desligamento, **When** há mensagens em andamento, **Then** elas são
   concluídas ou devolvidas à fila, sem perda nem efeito duplicado.
8. **Given** uma mensagem que tenta submeter uma operação de abertura (OPENING), **When** é
   consumida, **Then** é rejeitada: aberturas são internas.

---

### User Story 7 - Notificar sistemas consumidores sem perda (Priority: P2)

Cada resultado relevante gera um evento de integração entregue a sistemas consumidores somente
depois de confirmado, sem perda mesmo se o processo cair, e seguro de entregar mais de uma vez.

**Why this priority**: consumidores (saldo em tela, antifraude, contabilidade) dependem de
eventos corretos; publicar algo não confirmado ou perder um evento confirmado é eliminatório.

**Independent Test**: confirmar uma transação, matar o processo antes de publicar, subir outra
instância e verificar que o evento é publicado; rodar dois publicadores ao mesmo tempo e
verificar que nenhum evento é perdido.

**Acceptance Scenarios**:

1. **Given** uma transação processada, **When** é confirmada, **Then** é emitido um evento de
   transação processada (inclusive para LOSS) e, se o saldo mudou, um evento de saldo alterado.
2. **Given** uma rejeição de negócio, **When** é confirmada, **Then** é emitido um evento de
   rejeição; nenhum evento de saldo alterado é emitido.
3. **Given** uma operação em "aguardando referência", **When** é registrada, **Then** é
   emitido um evento correspondente.
4. **Given** uma transação cuja confirmação falhou, **When** o processo continua, **Then**
   nenhum evento sobre ela é emitido.
5. **Given** uma confirmação seguida de queda antes da publicação, **When** outra instância
   assume, **Then** o evento é publicado.
6. **Given** dois ou mais publicadores simultâneos, **When** publicam, **Then** nenhum evento é
   perdido e duplicatas ocasionais carregam o mesmo identificador de evento.

---

### User Story 8 - Consultar, auditar e reconciliar (Priority: P3)

O operador consulta carteira, extrato paginado e transações (por id interno ou pelo id do
provedor), e pede a reconciliação de uma carteira para provar que saldo e extrato batem.

**Why this priority**: é a prova de correção financeira; não muda saldo.

**Independent Test**: após uma sequência de operações, pedir reconciliação e verificar
`consistent: true`, diferença zero e número de lançamentos verificados.

**Acceptance Scenarios**:

1. **Given** uma carteira com histórico, **When** o operador pede o extrato com limite 50,
   **Then** recebe até 50 lançamentos e um cursor opaco e estável para a próxima página, sem
   repetições nem lacunas mesmo com novos lançamentos durante a paginação.
2. **Given** uma transação, **When** é consultada pelo id do provedor, **Then** retorna o
   mesmo registro que a consulta pelo id interno.
3. **Given** saldo e extrato coerentes, **When** é pedida a reconciliação, **Then** a resposta
   mostra saldo guardado, saldo calculado, diferença zero e `consistent: true`.
4. **Given** uma divergência, **When** é pedida a reconciliação, **Then** a divergência é
   sinalizada na resposta, registrada em log e métrica, e nada é corrigido automaticamente.

---

### User Story 9 - Operar e diagnosticar o serviço (Priority: P3)

A equipe de operação sabe se o processo está vivo, se está pronto para receber tráfego, e
acompanha falhas, retries, filas e atrasos.

**Why this priority**: necessário para rodar em produção, mas não altera a lógica financeira.

**Independent Test**: derrubar o banco e verificar que o processo continua "vivo" mas deixa de
estar "pronto"; verificar que as métricas mínimas são expostas.

**Acceptance Scenarios**:

1. **Given** o processo rodando, **When** a verificação de vida é chamada, **Then** responde
   ok sem autenticação.
2. **Given** banco ou fila inacessível, **When** a verificação de prontidão é chamada,
   **Then** responde não-pronto.
3. **Given** qualquer processamento, **When** os logs são inspecionados, **Then** são
   estruturados, trazem os identificadores de correlação e não contêm dados sensíveis nem
   payload financeiro completo.

---

### Edge Cases

- Mesma operação chega por HTTP e por fila ao mesmo tempo.
- ROLLBACK de um REFUND (o reembolso é desfeito e o valor volta a ser debitado).
- BET recebe REFUND e depois ROLLBACK (ou o inverso): a segunda reversão é rejeitada.
- BET → REFUND → ROLLBACK do REFUND → novo REFUND da BET: o último é rejeitado; saldo final
  igual ao da BET aplicada.
- REFUND e ROLLBACK da mesma BET chegam ao mesmo tempo em instâncias diferentes: só um é aplicado.
- Reversão chega, aguarda referência, e a referência chega rejeitada (ex.: BET sem saldo):
  a reversão é rejeitada imediatamente com `REFERENCE_NOT_PROCESSED`.
- Referência existe, mas pertence a outra rodada, jogador, carteira, moeda ou provedor.
- BET chega depois de o ROLLBACK que a referencia ter expirado (`REFERENCE_NOT_FOUND`): a BET é
  debitada (limitação conhecida, ver Assumptions).
- Reenvio de uma reversão já rejeitada por prazo: replay da rejeição, nunca reprocessamento.
- Mesma chave de idempotência com campos de transporte diferentes, mas negócio idêntico
  (deve ser replay).
- Mesmo provedor + id externo com chave de idempotência diferente (ex.: provedor mudou o
  formato da chave): conflito, sem segundo débito.
- Valores-limite: `0.00`, `0.01`, valores muito grandes, `"25.0"`, `"25.000"`, `"1e3"`,
  `"NaN"`, `"Infinity"`, string vazia.
- Processo cai antes do commit (nada deve ter efeito) e depois do commit (efeito único,
  evento publicado depois).
- Banco ou fila indisponíveis temporariamente durante consumo e publicação: nada é gravado e
  nada vira `FAILED`; a operação é retentada.
- Mensagem ilegível (JSON corrompido) na fila: vai para a DLQ após o limite de tentativas.
- Violação inesperada de constraint (bug) com banco acessível: transação `FAILED`, auditável.
- Muitas operações concorrentes na mesma carteira ("hot wallet") enquanto outras carteiras
  seguem em paralelo.
- Tentativa de submeter OPENING pela entrada pública ou pela fila.
- Novos lançamentos durante a paginação do extrato.

## Requirements *(mandatory)*

### Functional Requirements

**Dinheiro**

- **FR-001**: O sistema MUST representar valores monetários de forma exata, com 2 casas
  decimais fixas e moeda explícita, recebidos e devolvidos como string decimal.
- **FR-002**: O sistema MUST rejeitar valores inválidos: NaN, infinito, notação científica,
  vazio, mais de 2 casas decimais e negativos em contratos de entrada.
- **FR-003**: O sistema MUST rejeitar qualquer operação cuja moeda difira da moeda da carteira.

**Carteira**

- **FR-004**: O sistema MUST permitir no máximo uma carteira por jogador e moeda; duplicata é
  conflito.
- **FR-005**: O sistema MUST registrar o saldo inicial maior que zero como crédito interno de
  abertura, confirmado junto com a criação da carteira.
- **FR-006**: O saldo de uma carteira MUST nunca ficar negativo, inclusive sob concorrência.
- **FR-007**: A versão da carteira MUST iniciar em 1 e incrementar somente quando o saldo muda.

**Extrato (ledger)**

- **FR-008**: Toda alteração de saldo MUST gerar exatamente um lançamento com direção, valor,
  saldo antes e saldo depois aritmeticamente coerentes; toda transação gera no máximo um
  lançamento por carteira.
- **FR-009**: Lançamentos MUST ser imutáveis: nunca alterados nem excluídos.
- **FR-010**: LOSS e transações rejeitadas MUST NOT gerar lançamento nem alterar saldo.

**Operações de aposta**

- **FR-011**: O sistema MUST aceitar BET, WIN, LOSS, REFUND e ROLLBACK de provedores; OPENING
  MUST ser rejeitado em qualquer entrada externa.
- **FR-012**: BET MUST debitar o valor ou ser rejeitada por saldo insuficiente.
- **FR-013**: WIN MUST creditar o valor; quando referenciar uma BET, a referência MUST ser
  validada como nas reversões.
- **FR-014**: LOSS MUST ser registrado como processado sem mover saldo.
- **FR-015**: REFUND e ROLLBACK MUST exigir identificador de referência do provedor.
- **FR-016**: A referência MUST ser resolvida pelo par (provedor, id externo referenciado) e
  pertencer ao mesmo provedor, jogador, carteira, moeda e rodada.
- **FR-017**: REFUND MUST referenciar somente BET processada; ROLLBACK MUST referenciar BET,
  WIN ou REFUND processados e aplicar o efeito inverso da referência.
- **FR-018**: Uma referência MUST NOT ser revertida duas vezes pelo mesmo tipo de operação.
- **FR-019**: O valor de REFUND/ROLLBACK MUST ser igual ao da referência.
- **FR-020**: Uma reversão que deixaria o saldo negativo MUST ser rejeitada com código próprio,
  distinto do de aposta sem saldo, e permanecer auditável.
- **FR-021**: Transações MUST seguir o ciclo de estados pendente → processada | rejeitada |
  falha | aguardando referência; aguardando referência → processada | rejeitada | falha.
  Processada, rejeitada e falha são terminais.

**Referências fora de ordem**

- **FR-022**: Operação com referência ausente MUST ser registrada como "aguardando referência"
  e retentada automaticamente com espera exponencial (base 1 s, teto 5 min, com variação
  aleatória) por até 1 hora desde a chegada. Base, teto e prazo MUST ser configuráveis, para que
  os testes usem segundos.
- **FR-023**: Esgotado o limite de tentativas/tempo, a reversão MUST ser rejeitada com código
  de referência inexistente (`REFERENCE_NOT_FOUND`) e um evento de rejeição emitido. (Limite
  padrão adotado: ver Assumptions.)
- **FR-023a**: Se a referência existe mas está em estado terminal diferente de processada
  (rejeitada ou falha), a operação que a referencia MUST ser rejeitada imediatamente com
  `REFERENCE_NOT_PROCESSED`, tanto na chegada quanto no reprocessamento de "aguardando
  referência", sem esperar o prazo. A espera só se aplica enquanto a referência não existe.

**Idempotência**

- **FR-024**: Toda submissão MUST trazer uma chave de idempotência, que é a fonte da verdade
  para deduplicação.
- **FR-025**: O sistema MUST calcular uma impressão digital determinística do conteúdo de
  negócio da operação (independente da ordem dos campos e excluindo metadados de transporte).
- **FR-026**: Mesma chave com mesma impressão digital MUST devolver o resultado original,
  incluindo o saldo observado na época, sinalizado como replay.
- **FR-027**: Mesma chave com impressão digital diferente MUST ser tratada como conflito.
- **FR-028**: A deduplicação MUST sobreviver a reinícios e funcionar entre múltiplas
  instâncias.
- **FR-028a**: O par (provedor, id externo da transação) MUST ser único, além da chave de
  idempotência. Uma submissão com chave nova para um par já existente MUST ser tratada como
  conflito (distinto de replay e de rejeição de negócio), sem efeito financeiro. Assim a
  consulta por id externo e a resolução de referências sempre apontam para uma única transação.

**Entrada por fila**

- **FR-029**: Operações recebidas por fila MUST seguir exatamente as mesmas regras da entrada
  síncrona.
- **FR-030**: Mensagens MUST ser deduplicadas de forma persistente por (consumidor, id da
  mensagem).
- **FR-031**: Uma mensagem MUST ser confirmada somente depois de seu resultado estar
  confirmado.
- **FR-032**: Erros MUST ser classificados em negócio (terminal, confirmar), transitório
  (retentar com espera crescente) e permanente (enviar à DLQ após o limite de tentativas).
- **FR-032a**: Um erro permanente não-negocial (falha de programação, violação inesperada de
  constraint, tentativas esgotadas) com o banco acessível MUST levar a transação ao estado
  `FAILED`, com código de falha e evento, na mesma transação SQL, seguido da confirmação da
  mensagem. Quando não é possível gravar (banco inacessível ou mensagem ilegível), a mensagem
  MUST ir para a DLQ ao atingir o limite de tentativas.
- **FR-032b**: Um erro transitório MUST NOT levar a transação ao estado `FAILED`, para que um
  reenvio posterior com a mesma chave seja processado normalmente.
- **FR-033**: No desligamento, o consumidor MUST concluir mensagens em andamento ou
  devolvê-las.

**Atomicidade e eventos**

- **FR-034**: Registro da transação, alteração de saldo, lançamento, registro da mensagem
  recebida e evento a publicar MUST ser confirmados juntos, ou nenhum deles.
- **FR-035**: Eventos MUST ser publicados somente após a confirmação e MUST NOT ser perdidos
  em caso de queda; podem ser publicados mais de uma vez, sempre com o mesmo identificador.
- **FR-036**: O sistema MUST emitir, no mínimo: transação processada (inclusive LOSS),
  transação rejeitada, saldo alterado (somente quando o saldo muda) e transação aguardando
  referência. Eventos MUST ter envelope versionado com id, tipo, versão, agregado,
  correlação, causa e instante, e valores monetários como string decimal.
- **FR-037**: A publicação MUST funcionar com múltiplos publicadores simultâneos.

**Concorrência**

- **FR-038**: Operações na mesma carteira MUST NOT causar lost update; operações em carteiras
  diferentes MUST poder ocorrer em paralelo, sem bloqueio global.
- **FR-039**: Todas as garantias MUST valer com três ou mais instâncias simultâneas.

**Respostas ao provedor**

- **FR-040**: As respostas MUST distinguir de forma consistente, em todos os pontos de entrada,
  cada situação por uma categoria de resposta própria, sem que o provedor precise ler texto:

  | Situação | Categoria (HTTP) | Ação esperada do provedor |
  |---|---|---|
  | Processada | 201 | seguir |
  | Aguardando referência | 202 | aguardar evento |
  | Payload inválido | 400 | corrigir e reenviar |
  | Provedor declarado ≠ chamador (`PROVIDER_MISMATCH`, não persistido) | 403 | corrigir credencial/payload |
  | Conflito de idempotência | 409 | investigar |
  | Rejeição de negócio | 422 + `failureCode` | desistir |
  | Falha transitória | 503 + tempo sugerido para nova tentativa | reenviar com a mesma chave |
  | Falha permanente (`FAILED`) | 500 + `failureCode` | acionar suporte; não reenviar |

- **FR-040a**: Um replay MUST devolver a mesma categoria de resposta do resultado original
  (ex.: replay de rejeição devolve 422), sinalizado como replay.
- **FR-040b**: Uma falha transitória MUST NOT deixar nenhum efeito persistido, de modo que o
  reenvio com a mesma chave seja processado do zero.
- **FR-041**: Toda rejeição e falha MUST carregar um código estável e legível por máquina, de
  uma taxonomia documentada.

**Consultas e reconciliação**

- **FR-042**: O sistema MUST permitir consultar carteira, transação por id interno e transação
  por (provedor, id externo).
- **FR-043**: O extrato MUST ser paginado por cursor opaco e estável.
- **FR-044**: A reconciliação MUST comparar o saldo guardado com o saldo reconstruído pelo
  extrato, informar diferença, consistência e número de lançamentos, e MUST NOT corrigir
  divergências automaticamente; divergências MUST ser registradas e contabilizadas.

**Operação e acesso**

- **FR-045**: O sistema MUST expor verificações separadas de vida e de prontidão (banco e fila
  alcançáveis), sem autenticação.
- **FR-046**: O sistema MUST emitir logs estruturados com identificadores de correlação e sem
  dados sensíveis ou payload financeiro completo.
- **FR-047**: O sistema MUST expor métricas de transações por status, duplicatas, retries,
  mensagens em DLQ, conflitos de concorrência, atraso de publicação de eventos e latência.
- **FR-048**: A identidade do chamador MUST ser obtida por um ponto de extensão substituível
  (porta de identidade do provedor). Na entrega mínima, o mecanismo é de desenvolvimento
  (identidade declarada pelo chamador), explicitamente marcado como não seguro; a autenticação
  com provedor de identidade externo (credenciais de cliente máquina-a-máquina com token
  assinado) fica documentada e plugável, sem alterar o domínio.
- **FR-048a**: Independentemente do mecanismo de autenticação, uma operação síncrona cujo
  provedor declarado no conteúdo difira da identidade do chamador MUST ser rejeitada com código
  de falha próprio (ex.: `PROVIDER_MISMATCH`), sem efeito financeiro. Esta é uma regra de
  autorização de domínio, obrigatória e testada.
- **FR-049**: Cada transação MUST ser revertida no máximo uma vez, por qualquer tipo de
  reversão (REFUND ou ROLLBACK). Uma segunda reversão da mesma referência MUST ser rejeitada
  com código próprio (ex.: `REFERENCE_ALREADY_REVERSED`), inclusive quando as duas chegam
  simultaneamente. A reversão de uma reversão (ROLLBACK de um REFUND) é permitida, pois
  referencia outra transação; como ROLLBACK não referencia ROLLBACK, a cadeia sempre termina.
  Uma transação revertida continua revertida mesmo que sua reversão seja desfeita depois.
  Interpretação mais restritiva que a regra literal ("mesmo tipo"), que permitiria crédito
  duplicado via REFUND + ROLLBACK da mesma BET.
- **FR-050**: O sistema é autoridade sobre o dinheiro, não sobre o resultado do jogo:
  - WIN sem referência MUST ser aceito mesmo sem BET na rodada (free spins, jackpots, torneios
    e entrega fora de ordem);
  - LOSS sem referência MUST ser aceito (não move saldo);
  - WIN ou LOSS com referência MUST validar a referência como nas reversões (mesmo provedor,
    jogador, carteira, moeda e rodada; referência deve ser BET processada); referência ausente
    MUST levar a "aguardando referência";
  - WIN ou LOSS que referencia uma BET já revertida MUST ser rejeitado com código próprio
    (ex.: `REFERENCE_REVERSED`).

### Key Entities

- **Dinheiro (Money)**: valor exato com 2 casas e moeda; imutável; compara e opera apenas com a
  mesma moeda.
- **Carteira (Wallet)**: pertence a um jogador em uma moeda; tem saldo, versão e datas; é a
  unidade de concorrência e consistência.
- **Transação de aposta (WagerTransaction)**: operação de um provedor sobre uma carteira em
  uma rodada e jogo; tem tipo, valor, chave de idempotência, impressão digital do conteúdo,
  referência opcional ao id externo de outra transação, estado, código de falha e instante de
  processamento.
- **Lançamento de extrato (WalletLedgerEntry)**: registro imutável de uma movimentação: carteira,
  transação, direção (débito/crédito), valor, saldo antes, saldo depois.
- **Mensagem recebida (InboxMessage)**: registro de que um consumidor já tratou uma mensagem
  de fila, com impressão digital e instantes de recebimento e processamento.
- **Evento a publicar (OutboxMessage)**: evento de integração confirmado junto com a mudança,
  com tentativas, próximo horário de tentativa e instante de publicação.
- **Evento de integração**: envelope versionado (id, tipo, versão, agregado, correlação, causa,
  instante, dados).
- **Código de falha**: taxonomia estável que diz ao provedor se deve reenviar, corrigir ou
  desistir.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A mesma operação enviada 50 vezes em paralelo produz exatamente 1 efeito
  financeiro e 1 lançamento, em 100% das execuções do teste.
- **SC-002**: Com saldo `100.00` e duas apostas simultâneas de `80.00`, 100% das execuções
  terminam com 1 processada, 1 rejeitada por saldo insuficiente, saldo `20.00` e 1 débito.
- **SC-003**: Com três ou mais instâncias processando a mesma carteira ao mesmo tempo, nenhuma
  execução produz saldo negativo, débito/crédito duplicado ou divergência saldo × extrato.
- **SC-004**: Ao final de todo cenário de teste (inclusive quedas e reinícios), a reconciliação
  de todas as carteiras envolvidas retorna diferença zero.
- **SC-005**: 100% dos eventos de transações confirmadas são publicados ao menos uma vez após
  queda do processo entre a confirmação e a publicação; 0 eventos são publicados para
  transações não confirmadas.
- **SC-006**: Uma mensagem reentregue após queda do worker entre confirmação e ack gera 0
  efeitos adicionais.
- **SC-007**: Uma reversão que chega antes da referência é aplicada automaticamente quando a
  referência chega dentro do limite, ou rejeitada com código de referência inexistente ao fim
  dele, em 100% dos casos.
- **SC-008**: O provedor consegue decidir entre reenviar, corrigir ou desistir apenas pelo
  tipo de resposta e código de falha, sem interpretar texto, para 100% dos cenários de erro
  documentados.
- **SC-009**: Carteiras diferentes processadas em paralelo não esperam umas pelas outras: o
  tempo total para N carteiras independentes cresce bem menos que N vezes o tempo de uma.
- **SC-010**: Uma divergência injetada entre saldo e extrato é detectada e sinalizada pela
  reconciliação em 100% dos casos, sem correção automática.

## Assumptions

- Uma única moeda operacional (BRL) é suficiente, mas o modelo é multi-moeda e conflitos de
  moeda são testados.
- Chave de idempotência padrão: `{providerId}:{externalTransactionId}`.
- A impressão digital usa apenas campos de negócio (provedor, id externo, jogador, carteira,
  rodada, jogo, tipo, valor, moeda, referência), serializados de forma canônica.
- Prazo para referências pendentes: 1 hora, cobrindo com folga timeouts e retries típicos de
  provedores (decisão de clarificação, 2026-11-02, ver FR-022).
- Limitação conhecida: uma BET que chega depois de o ROLLBACK que a referencia já ter sido
  rejeitado por prazo é debitada normalmente. O prazo longo reduz a chance; a mitigação
  (rejeitar BET que já tem reversão expirada apontando para ela) fica registrada em
  `ARCHITECTURE.md` como evolução.
- Limite padrão de entregas antes da DLQ: 5 recebimentos.
- Reversão parcial está fora de escopo.
- WIN pode existir sem referência explícita; quando referencia, a referência é validada
  (decisão Q3, 2026-11-02, ver FR-050).
- Cada transação é revertida no máximo uma vez, por qualquer tipo de reversão (decisão Q2,
  2026-11-02, ver FR-049).
- Mensagens vindas da fila são canal interno confiável quanto a autenticação, mas seu conteúdo
  passa pelas mesmas validações de domínio.
- Verificações de saúde ficam abertas.
- Autenticação real (provedor de identidade externo) não pontua e o prazo é curto: fica como
  ponto de extensão documentado; só é implementada se o núcleo financeiro estiver concluído e
  testado (decisão Q1, 2026-11-02).
- Ledger de partidas dobradas e teste de carga são diferenciais opcionais, fora do escopo mínimo.
