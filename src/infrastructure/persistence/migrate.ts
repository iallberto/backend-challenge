import "reflect-metadata";
import { loadConfig } from "../config";
import { createOrm } from "./orm";

/** Uso: bun run src/infrastructure/persistence/migrate.ts up|down */
const direction = process.argv[2] ?? "up";
const config = loadConfig();
const orm = await createOrm(config.databaseUrl, 2);
try {
  const migrator = orm.getMigrator();
  const result = direction === "down" ? await migrator.down() : await migrator.up();
  console.log(JSON.stringify({ msg: `migrations ${direction}`, applied: result.map((m) => m.name) }));
} finally {
  await orm.close(true);
}
