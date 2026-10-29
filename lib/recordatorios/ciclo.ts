import "server-only";
import { configGeneral } from "../config";
import { conBloqueo, consultar, consultarUno } from "../db";
import { hoyEnZona, mensajeDeError } from "../utilidades";
import { despacharPendientes } from "./despachador";
import { planificar, prepararDia } from "./planificador";
import { sincronizarSheets } from "./sincronizar-sheets";
import type { ResumenCiclo } from "./tipos";
import { verificarEntregas } from "./verificador";

export interface OpcionesCiclo {
  origen: "cron" | "manual";
  /** Solo para pruebas: simula que hoy es esta fecha (YYYY-MM-DD). */
  fecha?: string;
  /** Ignora la ventana horaria de envío (ejecución manual). */
  forzarVentana?: boolean;
}

/**
 * Un ciclo completo e idempotente: se puede ejecutar varias veces al día.
 *   1. higiene (colgados -> fallido, pendientes vencidos -> omitido)
 *   2. planificación del día
 *   3. despacho (solo dentro de la ventana horaria)
 *   4. verificación de entregas en GHL
 *   5. sincronización con Google Sheets
 * Cada paso registra su error y no impide los siguientes.
 */
export async function ejecutarCiclo(opciones: OpcionesCiclo): Promise<ResumenCiclo | null> {
  const general = configGeneral();
  // TTL del bloqueo holgado respecto al presupuesto de despacho.
  return conBloqueo("ciclo", general.PRESUPUESTO_EJECUCION_SEG + 120, () => cicloSinBloqueo(opciones));
}

async function cicloSinBloqueo({ origen, fecha, forzarVentana }: OpcionesCiclo): Promise<ResumenCiclo> {
  const general = configGeneral();
  const inicio = Date.now();
  const fechaRef = fecha ?? hoyEnZona(general.APP_TIMEZONE);

  const ejecucion = await consultarUno<{ id: string }>(
    "INSERT INTO recordatorios.ejecuciones (origen, fecha_referencia) VALUES ($1, $2::date) RETURNING id",
    [origen, fechaRef],
  );

  const resumen: ResumenCiclo = {
    ejecucionId: ejecucion!.id,
    fecha: fechaRef,
    planificados: 0,
    expirados: 0,
    enviados: 0,
    fallidos: 0,
    omitidos: 0,
    verificados: 0,
    sincronizadosSheets: 0,
    despachoEnVentana: forzarVentana || dentroDeVentana(general),
    errores: [],
  };

  const paso = async (nombre: string, trabajo: () => Promise<void>) => {
    try {
      await trabajo();
    } catch (error) {
      console.error(`[ciclo] ${nombre}:`, error);
      resumen.errores.push(`${nombre}: ${mensajeDeError(error)}`);
    }
  };

  await paso("preparación", async () => {
    resumen.expirados = await prepararDia(fechaRef);
  });
  await paso("planificación", async () => {
    resumen.planificados = await planificar(fechaRef);
  });
  if (resumen.despachoEnVentana) {
    await paso("despacho", async () => {
      const limiteMs = general.PRESUPUESTO_EJECUCION_SEG * 1000 - (Date.now() - inicio);
      Object.assign(resumen, await despacharPendientes({ fecha: fechaRef }, limiteMs));
    });
  }
  await paso("verificación", async () => {
    resumen.verificados = await verificarEntregas();
  });
  await paso("Google Sheets", async () => {
    resumen.sincronizadosSheets = await sincronizarSheets();
  });

  await consultar(
    `UPDATE recordatorios.ejecuciones
     SET finalizada_en = now(), planificados = $2, enviados = $3, fallidos = $4,
         omitidos = $5, verificados = $6, sincronizados_sheets = $7, error = $8
     WHERE id = $1`,
    [
      resumen.ejecucionId,
      resumen.planificados,
      resumen.enviados,
      resumen.fallidos,
      resumen.omitidos + resumen.expirados,
      resumen.verificados,
      resumen.sincronizadosSheets,
      resumen.errores.length ? resumen.errores.join(" | ") : null,
    ],
  );

  return resumen;
}

function dentroDeVentana({ APP_TIMEZONE, HORA_INICIO_ENVIO, HORA_FIN_ENVIO }: ReturnType<typeof configGeneral>) {
  const hora = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, hour: "numeric", hourCycle: "h23" }).format(new Date()),
  );
  return hora >= HORA_INICIO_ENVIO && hora < HORA_FIN_ENVIO;
}
