import { MikroORM } from "@mikro-orm/core";
import { Migrator } from "@mikro-orm/migrations";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Migration20261102000001_initial_schema } from "./migrations/Migration20261102000001_initial_schema";
import { ALL_SCHEMAS } from "./schemas";

export async function createOrm(databaseUrl: string, poolMax = 20): Promise<MikroORM<PostgreSqlDriver>> {
  return MikroORM.init<PostgreSqlDriver>({
    driver: PostgreSqlDriver,
    clientUrl: databaseUrl,
    entities: ALL_SCHEMAS,
    // conecta sob demanda: o processo sobe (e responde /health/live) mesmo com o banco fora
    connect: false,
    pool: { min: 0, max: poolMax, acquireTimeoutMillis: 5_000 },
    driverOptions: { connection: { connectionTimeoutMillis: 3_000 } },
    extensions: [Migrator],
    migrations: {
      tableName: "mikro_orm_migrations",
      transactional: true,
      allOrNothing: true,
      // lista explícita: evita descoberta dinâmica de arquivos (mais previsível no Bun)
      migrationsList: [
        { name: "Migration20261102000001_initial_schema", class: Migration20261102000001_initial_schema },
      ],
    },
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: false,
  });
}
