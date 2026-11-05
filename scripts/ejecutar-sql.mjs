// Ejecuta un archivo .sql contra DATABASE_URL y muestra las filas que devuelva.
// Uso: npm run db:sql -- db/pruebas/compras-prueba.sql   (lee DATABASE_URL de .env.local)
import { readFile } from "node:fs/promises";
import pg from "pg";

const archivo = process.argv[2];
if (!archivo) {
  console.error("Indica el archivo: npm run db:sql -- ruta/al/archivo.sql");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("Falta DATABASE_URL (define .env.local).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
client.on("notice", (aviso) => console.log(aviso.message));

try {
  const resultados = [await client.query(await readFile(archivo, "utf8"))].flat();
  for (const r of resultados) if (r.rows?.length) console.table(r.rows);
  console.log(`✓ ${archivo}`);
} catch (error) {
  console.error(`✗ ${archivo}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
