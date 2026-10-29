import "server-only";
import { Pool, types, type QueryResultRow } from "pg";
import { configGeneral } from "./config";

// DATE -> 'YYYY-MM-DD' (evita que pg lo convierta a Date en la zona del servidor).
types.setTypeParser(1082, (valor) => valor);

const globalParaPool = globalThis as unknown as { __poolRecordatorios?: Pool };

function pool(): Pool {
  if (!globalParaPool.__poolRecordatorios) {
    const nuevo = new Pool({
      connectionString: configGeneral().DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    nuevo.on("error", (error) => console.error("[db] error en cliente inactivo", error));
    globalParaPool.__poolRecordatorios = nuevo;
  }
  return globalParaPool.__poolRecordatorios;
}

export async function consultar<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
  const resultado = await pool().query<T>(sql, params);
  return resultado.rows;
}

export async function consultarUno<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
  const filas = await consultar<T>(sql, params);
  return filas[0] ?? null;
}

/**
 * Ejecuta `trabajo` solo si nadie más tiene el bloqueo `nombre`. Devuelve null
 * si estaba tomado. El bloqueo expira solo tras `ttlSeg` por si el proceso muere.
 */
export async function conBloqueo<T>(nombre: string, ttlSeg: number, trabajo: () => Promise<T>): Promise<T | null> {
  const tomado = await consultarUno<{ nombre: string }>(
    `INSERT INTO recordatorios.bloqueos (nombre, tomado_hasta)
     VALUES ($1, now() + make_interval(secs => $2))
     ON CONFLICT (nombre) DO UPDATE SET tomado_hasta = EXCLUDED.tomado_hasta
       WHERE recordatorios.bloqueos.tomado_hasta < now()
     RETURNING nombre`,
    [nombre, ttlSeg],
  );
  if (!tomado) return null;
  try {
    return await trabajo();
  } finally {
    await consultar("UPDATE recordatorios.bloqueos SET tomado_hasta = now() WHERE nombre = $1", [nombre]);
  }
}
