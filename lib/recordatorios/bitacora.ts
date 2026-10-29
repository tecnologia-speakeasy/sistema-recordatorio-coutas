import "server-only";
import { consultar } from "../db";

export type TipoEvento =
  | "enviado"
  | "simulado"
  | "error"
  | "omitido"
  | "estado_ghl"
  | "webhook_workflow"
  | "click"
  | "reenvio_manual"
  | "recuperado";

export async function registrarEvento(envioId: string, tipo: TipoEvento, detalle?: unknown): Promise<void> {
  try {
    await consultar("INSERT INTO recordatorios.eventos (envio_id, tipo, detalle) VALUES ($1, $2, $3)", [
      envioId,
      tipo,
      detalle === undefined ? null : JSON.stringify(detalle),
    ]);
  } catch (error) {
    // La bitácora nunca debe interrumpir un envío.
    console.error("[bitacora] no se pudo registrar el evento", { envioId, tipo, error });
  }
}
