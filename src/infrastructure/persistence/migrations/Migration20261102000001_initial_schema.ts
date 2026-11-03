import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade vivem aqui,
 * no banco, e não só no código (README §5.9, Constituição II).
 * FKs são DEFERRABLE INITIALLY DEFERRED: checadas no commit, independentes da ordem de flush.
 */
export class Migration20261102000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallet (
        id          UUID PRIMARY KEY,
        player_id   UUID NOT NULL,
        currency    CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     NUMERIC(19,2) NOT NULL CONSTRAINT ck_wallet_balance_non_negative CHECK (balance >= 0),
        version     INTEGER NOT NULL CHECK (version >= 1),
        created_at  TIMESTAMPTZ NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL,
        CONSTRAINT ux_wallet_player_currency UNIQUE (player_id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transaction (
        id                                 UUID PRIMARY KEY,
        provider_id                        TEXT NOT NULL,
        external_transaction_id            TEXT NOT NULL,
        idempotency_key                    TEXT NOT NULL,
        payload_hash                       CHAR(64) NOT NULL,
        wallet_id                          UUID NOT NULL,
        player_id                          UUID NOT NULL,
        round_id                           TEXT NOT NULL,
        game_id                            TEXT NOT NULL,
        kind                               TEXT NOT NULL
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             NUMERIC(19,2) NOT NULL
          CHECK (amount > 0 OR (kind = 'LOSS' AND amount >= 0)),
        currency                           CHAR(3) NOT NULL,
        reference_external_transaction_id  TEXT NULL,
        reference_transaction_id           UUID NULL
          REFERENCES wager_transaction(id) DEFERRABLE INITIALLY DEFERRED,
        status                             TEXT NOT NULL
          CHECK (status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       TEXT NULL,
        result_balance                     NUMERIC(19,2) NULL,
        result_wallet_version              INTEGER NULL,
        attempts                           INTEGER NOT NULL DEFAULT 0,
        next_attempt_at                    TIMESTAMPTZ NULL,
        expires_at                         TIMESTAMPTZ NULL,
        created_at                         TIMESTAMPTZ NOT NULL,
        updated_at                         TIMESTAMPTZ NOT NULL,
        processed_at                       TIMESTAMPTZ NULL,
        CONSTRAINT ux_wager_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT ux_wager_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_wager_reversal_requires_reference
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_failure_code
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wager_processed_at
          CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT ck_wager_pending_schedule
          CHECK (status <> 'PENDING_REFERENCE' OR (next_attempt_at IS NOT NULL AND expires_at IS NOT NULL))
      );
    `);

    // FR-049: cada transação é revertida no máximo uma vez, por qualquer tipo de reversão.
    this.addSql(`
      CREATE UNIQUE INDEX ux_reversal_once ON wager_transaction (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE INDEX ix_pending_due ON wager_transaction (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX ix_pending_ref ON wager_transaction (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE FUNCTION wager_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transaction rows cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager_transaction % is terminal (%)', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount,
            NEW.currency, NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount,
            OLD.currency, OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'business fields of wager_transaction % are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wager_transaction_guard
        BEFORE UPDATE OR DELETE ON wager_transaction
        FOR EACH ROW EXECUTE FUNCTION wager_transaction_guard();
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entry (
        id              UUID PRIMARY KEY,
        seq             BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id       UUID NOT NULL REFERENCES wallet(id) DEFERRABLE INITIALLY DEFERRED,
        transaction_id  UUID NOT NULL REFERENCES wager_transaction(id) DEFERRABLE INITIALLY DEFERRED,
        direction       TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount          NUMERIC(19,2) NOT NULL CHECK (amount > 0),
        currency        CHAR(3) NOT NULL,
        balance_before  NUMERIC(19,2) NOT NULL,
        balance_after   NUMERIC(19,2) NOT NULL CHECK (balance_after >= 0),
        created_at      TIMESTAMPTZ NOT NULL,
        CONSTRAINT ux_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ck_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entry (wallet_id, seq);`);
    this.addSql(`
      CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entry is append-only (% blocked)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entry
        FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entry
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();
    `);

    this.addSql(`
      CREATE TABLE inbox_message (
        consumer_name  TEXT NOT NULL,
        message_id     TEXT NOT NULL,
        payload_hash   CHAR(64) NOT NULL,
        received_at    TIMESTAMPTZ NOT NULL,
        processed_at   TIMESTAMPTZ NULL,
        CONSTRAINT pk_inbox_message PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_message (
        id               UUID PRIMARY KEY,
        aggregate_id     UUID NOT NULL,
        event_type       TEXT NOT NULL,
        event_version    INTEGER NOT NULL,
        payload          JSONB NOT NULL,
        occurred_at      TIMESTAMPTZ NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0,
        next_attempt_at  TIMESTAMPTZ NOT NULL,
        published_at     TIMESTAMPTZ NULL,
        last_error       TEXT NULL
      );
    `);
    this.addSql(`CREATE INDEX ix_outbox_due ON outbox_message (next_attempt_at) WHERE published_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_message;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_message;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entry;`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_immutable();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transaction;`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_transaction_guard();`);
    this.addSql(`DROP TABLE IF EXISTS wallet;`);
  }
}
