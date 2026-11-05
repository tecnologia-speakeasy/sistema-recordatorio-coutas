import { bearerValido } from "@/lib/auth";
import { configSeguridad, modoSimulacion } from "@/lib/config";
import { ejecutarCiclo } from "@/lib/recordatorios/ciclo";
import { esFechaIso, mensajeDeError } from "@/lib/utilidades";

// Debe ser mayor que PRESUPUESTO_EJECUCION_SEG (240 s por defecto).
export const maxDuration = 300;

/**
 * Ejecuta un ciclo completo. Autenticación: `Authorization: Bearer <CRON_SECRET>`
 * (Vercel Cron lo envía solo si CRON_SECRET está definido en el proyecto).
 * Pruebas: `?fecha=YYYY-MM-DD` simula el día de referencia y `?producto=<id de cartera>`
 * limita la planificación y el despacho a ese producto. Con GHL_DRY_RUN=false la fecha
 * simulada exige producto: sin él, enviaría de verdad a todos los estudiantes de esa fecha.
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

  const parametros = new URL(request.url).searchParams;
  const fecha = parametros.get("fecha") ?? undefined;
  const producto = parametros.get("producto") ?? undefined;
  if (fecha && !esFechaIso(fecha)) {
    return Response.json({ ok: false, error: "fecha debe tener formato YYYY-MM-DD" }, { status: 400 });
  }
  if (producto && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(producto)) {
    return Response.json({ ok: false, error: "producto debe ser el id (uuid) del producto en cartera" }, { status: 400 });
  }
  if (fecha && !producto && !modoSimulacion()) {
    return Response.json(
      {
        ok: false,
        error:
          "Con GHL_DRY_RUN=false, simular una fecha exige ?producto=<id> (un producto de prueba); " +
          "sin él se enviaría de verdad a todos los estudiantes de esa fecha.",
      },
      { status: 400 },
    );
  }

  try {
    const resumen = await ejecutarCiclo({ origen: "cron", fecha, producto });
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
