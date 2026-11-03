import "server-only";
import { configSheets } from "./config";
import { esperar } from "./utilidades";

/**
 * Google Sheets a través de n8n. El sistema no habla con Google: envía las filas
 * al webhook del workflow integraciones/n8n-google-sheets.json, que hace
 * "Append or Update" por la columna ID con la cuenta de Google conectada en n8n.
 *
 * El nodo de Sheets de n8n escribe toda una ejecución en una sola pestaña, así
 * que cada llamada lleva las filas de una sola pestaña.
 */

export type Celda = string | number | null;
export type FilaSheets = Record<string, Celda>;

export async function enviarFilas(pestana: string, filas: FilaSheets[]): Promise<void> {
  if (!filas.length) return;
  const config = configSheets();
  if (!config) throw new Error("Google Sheets no está configurado (SHEETS_WEBHOOK_URL)");

  for (let intento = 1; ; intento++) {
    const respuesta = await fetch(config.SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pestana, filas }),
      cache: "no-store",
      // n8n responde cuando Google Sheets terminó de escribir.
      signal: AbortSignal.timeout(90_000),
    });
    if (respuesta.ok) return;

    const reintentable = respuesta.status === 429 || respuesta.status >= 500;
    if (reintentable && intento < 3) {
      await esperar(3000 * intento);
      continue;
    }
    const detalle = (await respuesta.text()).slice(0, 300);
    throw new Error(`n8n (Google Sheets, pestaña "${pestana}") -> ${respuesta.status}: ${detalle || respuesta.statusText}`);
  }
}
