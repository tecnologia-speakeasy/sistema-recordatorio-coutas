import "server-only";
import { createSign } from "node:crypto";
import { configSheets } from "./config";

/**
 * Cliente mínimo de Google Sheets API v4 con cuenta de servicio (JWT RS256),
 * sin dependencias. La hoja debe estar compartida como Editor con GOOGLE_SA_EMAIL.
 * Se usa valueInputOption=RAW para que ningún dato (p. ej. un nombre que empiece
 * por "=") se interprete como fórmula.
 */

const API = "https://sheets.googleapis.com/v4/spreadsheets";
let tokenCache: { valor: string; expira: number } | null = null;

const base64url = (entrada: string | Buffer) => Buffer.from(entrada).toString("base64url");

async function tokenDeAcceso(email: string, llavePrivada: string): Promise<string> {
  if (tokenCache && tokenCache.expira > Date.now() + 60_000) return tokenCache.valor;

  const iat = Math.floor(Date.now() / 1000);
  const encabezado = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const reclamos = base64url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    }),
  );
  const firma = createSign("RSA-SHA256").update(`${encabezado}.${reclamos}`).sign(llavePrivada);
  const assertion = `${encabezado}.${reclamos}.${base64url(firma)}`;

  const respuesta = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    cache: "no-store",
  });
  if (!respuesta.ok) throw new Error(`Google OAuth ${respuesta.status}: ${await respuesta.text()}`);

  const { access_token, expires_in } = (await respuesta.json()) as { access_token: string; expires_in: number };
  tokenCache = { valor: access_token, expira: Date.now() + expires_in * 1000 };
  return access_token;
}

async function llamar<T>(metodo: "GET" | "POST" | "PUT", ruta: string, cuerpo?: unknown): Promise<T> {
  const config = configSheets();
  if (!config) throw new Error("Google Sheets no está configurado");
  const token = await tokenDeAcceso(config.GOOGLE_SA_EMAIL, config.GOOGLE_SA_PRIVATE_KEY);

  const respuesta = await fetch(`${API}/${config.GOOGLE_SHEETS_ID}${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!respuesta.ok) throw new Error(`Google Sheets ${metodo} ${ruta} -> ${respuesta.status}: ${await respuesta.text()}`);
  return (await respuesta.json()) as T;
}

/** Notación A1 con la pestaña escapada: 'Mi pestaña'!A1 */
const a1 = (pestana: string, celdas: string) => `'${pestana.replace(/'/g, "''")}'!${celdas}`;
const rango = (pestana: string, celdas: string) => encodeURIComponent(a1(pestana, celdas));

export type Celda = string | number | null;

export async function asegurarEncabezados(pestana: string, encabezados: string[]): Promise<void> {
  const { values } = await llamar<{ values?: Celda[][] }>("GET", `/values/${rango(pestana, "A1:A1")}`);
  if (values?.[0]?.[0]) return;
  await llamar("PUT", `/values/${rango(pestana, "A1")}?valueInputOption=RAW`, { values: [encabezados] });
}

/** Agrega filas al final y devuelve el número de fila asignado a cada una. */
export async function anexarFilas(pestana: string, filas: Celda[][]): Promise<number[]> {
  const respuesta = await llamar<{ updates: { updatedRange: string } }>(
    "POST",
    `/values/${rango(pestana, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: filas },
  );
  const inicio = Number(/![A-Z]+(\d+)/.exec(respuesta.updates.updatedRange)?.[1]);
  if (!Number.isFinite(inicio)) throw new Error(`Rango inesperado de Sheets: ${respuesta.updates.updatedRange}`);
  return filas.map((_, i) => inicio + i);
}

export async function actualizarFilas(pestana: string, filas: { fila: number; valores: Celda[] }[]): Promise<void> {
  if (!filas.length) return;
  await llamar("POST", "/values:batchUpdate", {
    valueInputOption: "RAW",
    data: filas.map(({ fila, valores }) => ({
      range: a1(pestana, `A${fila}`),
      values: [valores],
    })),
  });
}
