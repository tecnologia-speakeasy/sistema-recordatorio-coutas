import { io } from "next/cache";
import { Suspense } from "react";
import { z } from "zod";
import { ejecutarCicloAhora, reenviarFallidos, sincronizarSheetsAhora } from "@/app/acciones";
import { apiGhlConfigurada, configGeneral, modoSimulacion } from "@/lib/config";
import {
  alertas,
  ejecucionesRecientes,
  kpis,
  listarEnvios,
  listarEtapas,
  listarLanzamientos,
  leerLinkSoporte,
  listarProductos,
  planesSinLink,
  type FiltrosEnvios,
} from "@/lib/recordatorios/consultas";
import { ESTADOS_ENVIO, PASARELAS } from "@/lib/recordatorios/tipos";
import { formatearFechaCorta, hoyEnZona, mensajeDeError, sumarDias } from "@/lib/utilidades";
import { Alertas } from "./componentes/alertas";
import { BotonAccion } from "./componentes/boton-accion";
import { Ejecuciones } from "./componentes/ejecuciones";
import { Filtros } from "./componentes/filtros";
import { FormularioAjustes } from "./componentes/formulario-ajustes";
import { FormularioEtapa } from "./componentes/formulario-etapa";
import { FormularioProducto } from "./componentes/formulario-producto";
import { TablaEnvios } from "./componentes/tabla-envios";
import { TarjetasKpi } from "./componentes/tarjetas-kpi";

// Aplica también a las server actions de la página (reenvíos masivos, ciclo manual).
export const maxDuration = 300;

const esquemaBusqueda = z.object({
  desde: z.iso.date().optional().catch(undefined),
  hasta: z.iso.date().optional().catch(undefined),
  estado: z.enum(ESTADOS_ENVIO).optional().catch(undefined),
  etapa: z.string().max(10).optional().catch(undefined),
  q: z.string().max(100).optional().catch(undefined),
  pagina: z.coerce.number().int().min(1).optional().catch(undefined),
});

export default function Inicio(props: PageProps<"/">) {
  return (
    <Suspense fallback={<p className="py-20 text-center text-sm text-neutral-600">Cargando panel…</p>}>
      <Panel searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Panel({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const busqueda = esquemaBusqueda.parse(await searchParams);

  let general: ReturnType<typeof configGeneral>;
  try {
    general = configGeneral();
  } catch (error) {
    return <Aviso titulo="Falta configuración" mensaje={mensajeDeError(error)} />;
  }

  // "Hoy" depende del reloj: se calcula por request, nunca en el shell prerenderizado.
  await io();
  const hoy = hoyEnZona(general.APP_TIMEZONE);
  const filtros: FiltrosEnvios = {
    desde: busqueda.desde ?? sumarDias(hoy, -30),
    hasta: busqueda.hasta ?? hoy,
    estado: busqueda.estado,
    etapa: busqueda.etapa || undefined,
    q: busqueda.q?.trim() || undefined,
    pagina: busqueda.pagina ?? 1,
  };

  const datos = await Promise.all([
    kpis(filtros.desde, filtros.hasta),
    listarEnvios(filtros),
    ejecucionesRecientes(),
    listarEtapas(),
    listarProductos(),
    planesSinLink(hoy).catch(() => []),
    listarLanzamientos().catch(() => []),
    alertas(filtros.desde, filtros.hasta, hoy),
    leerLinkSoporte(),
  ]).catch((error: unknown) => new Error(mensajeDeError(error)));

  if (datos instanceof Error) {
    return (
      <Aviso titulo="No se pudo leer la base de datos" mensaje={`${datos.message}. ¿Ejecutaste "npm run db:migrar"?`} />
    );
  }

  const [resumen, envios, ejecuciones, etapas, productos, sinLink, lanzamientos, atencion, linkSoporte] = datos;
  const simulacion = modoSimulacion();
  const etapasSinWebhook = etapas.filter((e) => e.activa && !e.ghl_webhook_url).map((e) => e.codigo);
  const verificaEntregas = (() => {
    try {
      return apiGhlConfigurada();
    } catch {
      return false;
    }
  })();

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-morado">Envíos de recordatorios</h1>
          <p className="text-sm text-neutral-600">
            Hoy: {formatearFechaCorta(hoy)} · Ventana de envío {general.HORA_INICIO_ENVIO}:00–{general.HORA_FIN_ENVIO}:00 (
            {general.APP_TIMEZONE})
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <BotonAccion
            accion={sincronizarSheetsAhora}
            etiqueta="Sincronizar Sheets"
            etiquetaPendiente="Sincronizando…"
            variante="secundario"
          />
          <BotonAccion
            accion={ejecutarCicloAhora}
            etiqueta="Ejecutar ciclo ahora"
            etiquetaPendiente="Ejecutando…"
            confirmar="Se planificarán y enviarán los recordatorios de hoy, aunque esté fuera de la ventana horaria. ¿Continuar?"
          />
        </div>
      </section>

      {simulacion && (
        <Aviso
          tono="info"
          titulo="Modo simulación activo"
          mensaje="GHL_DRY_RUN=true: los envíos se marcan como enviados sin llamar a GHL."
        />
      )}
      {etapasSinWebhook.length > 0 && (
        <Aviso
          tono="info"
          titulo="Etapas activas sin webhook"
          mensaje={`Pega la URL del webhook entrante del workflow de GHL para: ${etapasSinWebhook.join(", ")}. Sus envíos fallarán hasta entonces.`}
        />
      )}
      {sinLink.length > 0 && (
        <Aviso
          titulo="Planes sin link de pago"
          mensaje={`Sus recordatorios fallarán hasta que configures el link: ${sinLink
            .map(
              (p) =>
                `${PASARELAS[p.pasarela]}${p.referido ? " referido" : ""} · ${p.total_cuotas} cuotas (${p.estudiantes} estudiantes)`,
            )
            .join(", ")}.`}
        />
      )}
      {!linkSoporte && (
        <Aviso
          tono="info"
          titulo="Falta el link del chat de soporte"
          mensaje="Configúralo en «Etapas y workflows de GHL». Mientras tanto, el botón del mensaje de soporte llega sin link."
        />
      )}
      {!verificaEntregas && (
        <Aviso
          tono="info"
          titulo="Sin verificación de entrega"
          mensaje="Sin GHL_TOKEN y GHL_LOCATION_ID los envíos se quedan en «Enviado»: no se detectan los WhatsApp que fallan después de llegar a GHL."
        />
      )}

      <TarjetasKpi kpis={resumen} />

      <Alertas alertas={atencion} filtros={filtros} zona={general.APP_TIMEZONE} />

      <section aria-labelledby="titulo-envios" className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-morado/10 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="titulo-envios" className="text-lg font-bold text-morado">
            Envíos
          </h2>
          {resumen.porEstado.fallido > 0 && (
            <BotonAccion
              accion={reenviarFallidos}
              campos={{ desde: filtros.desde, hasta: filtros.hasta, etapa: filtros.etapa, q: filtros.q }}
              etiqueta="Reenviar fallidos del filtro"
              etiquetaPendiente="Reenviando…"
              confirmar="Se reenviarán hasta 200 envíos fallidos que coinciden con el rango, la etapa y la búsqueda actuales. ¿Continuar?"
            />
          )}
        </div>
        <Filtros filtros={filtros} etapas={etapas} />
        <div className="mt-5">
          <TablaEnvios
            filas={envios.filas}
            total={envios.total}
            filtros={filtros}
            zona={general.APP_TIMEZONE}
          />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="titulo-ejecuciones" className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-morado/10 sm:p-6">
          <h2 id="titulo-ejecuciones" className="mb-2 text-lg font-bold text-morado">
            Últimas ejecuciones
          </h2>
          <Ejecuciones ejecuciones={ejecuciones} zona={general.APP_TIMEZONE} />
        </section>
        <section aria-labelledby="titulo-etapas" className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-morado/10 sm:p-6">
          <h2 id="titulo-etapas" className="text-lg font-bold text-morado">
            Etapas y workflows de GHL
          </h2>
          <p className="mb-3 text-xs text-neutral-600">
            Cada etapa dispara su workflow con un POST a su webhook entrante. Los datos llegan como{" "}
            <code>{"{{inboundWebhookRequest.campo}}"}</code>.
          </p>
          <div className="flex flex-col gap-3">
            <FormularioAjustes linkSoporte={linkSoporte} />
            {etapas.map((etapa) => (
              <FormularioEtapa key={etapa.codigo} etapa={etapa} horasSeguimiento={general.SEGUIMIENTO_HORAS} />
            ))}
          </div>
        </section>
      </div>

      <section aria-labelledby="titulo-productos" className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-morado/10 sm:p-6">
        <h2 id="titulo-productos" className="text-lg font-bold text-morado">
          Productos y links de pago
        </h2>
        <p className="mb-3 text-xs text-neutral-600">
          El link se elige por el método de pago de la compra (Stripe → Stripe; los demás → Hotmart), por su plan de
          cuotas y por si tiene descuento de referido. El estudiante recibe un link rastreado que redirige al de esta
          tabla.
        </p>
        <div className="flex flex-col gap-3">
          {productos.map((producto) => (
            <FormularioProducto key={producto.producto_id} producto={producto} lanzamientos={lanzamientos} />
          ))}
        </div>
      </section>
    </div>
  );
}

function Aviso({ titulo, mensaje, tono = "error" }: { titulo: string; mensaje: string; tono?: "error" | "info" }) {
  const estilos = tono === "error" ? "bg-red-50 text-red-900 ring-red-200" : "bg-fucsia-claro text-morado-oscuro ring-fucsia/30";
  return (
    <div role={tono === "error" ? "alert" : "status"} className={`rounded-2xl p-4 ring-1 ${estilos}`}>
      <p className="font-semibold">{titulo}</p>
      <p className="mt-1 text-sm break-words">{mensaje}</p>
    </div>
  );
}
