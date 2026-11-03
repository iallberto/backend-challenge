import "reflect-metadata";
import { createOrm } from "../../src/infrastructure/persistence/orm";
import { DATABASE_URL } from "./infra";

/** Preload dos testes de integração/concorrência: garante o schema aplicado no Postgres real. */
if (!process.argv.some((a) => a.includes("tests/unit") || a.includes("tests\\unit"))) {
  const orm = await createOrm(DATABASE_URL, 2);
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}
