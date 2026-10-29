// Aplica en orden los archivos de db/migraciones/*.sql que aún no se han aplicado.
// Uso: npm run db:migrar   (lee DATABASE_URL de .env.local)
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const DIR = new URL("../db/migraciones/", import.meta.url);

if (!process.env.DATABASE_URL) {
  console.error("Falta DATABASE_URL (define .env.local).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS recordatorios;
    CREATE TABLE IF NOT EXISTS recordatorios._migraciones (
      archivo    text PRIMARY KEY,
      aplicada_en timestamptz NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await client.query("SELECT archivo FROM recordatorios._migraciones");
  const aplicadas = new Set(rows.map((r) => r.archivo));
  const archivos = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();

  for (const archivo of archivos) {
    if (aplicadas.has(archivo)) continue;
    const sql = await readFile(new URL(archivo, DIR), "utf8");
    process.stdout.write(`→ ${archivo} ... `);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO recordatorios._migraciones (archivo) VALUES ($1)", [archivo]);
      await client.query("COMMIT");
      console.log("ok");
    } catch (error) {
      await client.query("ROLLBACK");
      console.log("ERROR");
      throw error;
    }
  }
  console.log("Migraciones al día.");
} finally {
  await client.end();
}
