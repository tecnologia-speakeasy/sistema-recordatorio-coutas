import { bearerValido } from "@/lib/auth";
import { configSeguridad } from "@/lib/config";
import { ejecutarCiclo } from "@/lib/recordatorios/ciclo";
import { esFechaIso, mensajeDeError } from "@/lib/utilidades";

// Debe ser mayor que PRESUPUESTO_EJECUCION_SEG (240 s por defecto).
export const maxDuration = 300;

/**
 * Ejecuta un ciclo completo. Autenticación: `Authorization: Bearer <CRON_SECRET>`
 * (Vercel Cron lo envía solo si CRON_SECRET está definido en el proyecto).
 * Pruebas: `?fecha=YYYY-MM-DD` simula el día de referencia.
 */
async function manejar(request: Request) {
  let secreto: string;
  try {
    secreto = configSeguridad().CRON_SECRET;
  } catch (error) {
    return Response.json({ ok: false, error: mensajeDeError(error) }, { status: 503 });
  }

  if (!bearerValido(request.headers.get("authorization"), secreto)) {
    return Response.json({ ok: false, error: "No autorizado" }, { status: 401 });
  }

  const fecha = new URL(request.url).searchParams.get("fecha") ?? undefined;
  if (fecha && !esFechaIso(fecha)) {
    return Response.json({ ok: false, error: "fecha debe tener formato YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const resumen = await ejecutarCiclo({ origen: "cron", fecha });
    if (!resumen) {
      return Response.json({ ok: false, error: "Hay otra ejecución en curso" }, { status: 409 });
    }
    const ok = resumen.errores.length === 0;
    return Response.json({ ok, ...resumen }, { status: ok ? 200 : 500 });
  } catch (error) {
    console.error("[cron] error no controlado", error);
    return Response.json({ ok: false, error: mensajeDeError(error) }, { status: 500 });
  }
}

export const GET = manejar;
export const POST = manejar;
