import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { reenviarEnvio } from "@/app/acciones";
import { BotonAccion } from "@/app/componentes/boton-accion";
import { InsigniaEstado } from "@/app/componentes/insignia-estado";
import { configGeneral } from "@/lib/config";
import { eventosDeEnvio, obtenerEnvio } from "@/lib/recordatorios/consultas";
import { ESTADOS_REENVIABLES } from "@/lib/recordatorios/tipos";
import { formatearFechaCorta, formatearFechaHora, formatearMoneda } from "@/lib/utilidades";

export const maxDuration = 300;

export default function DetalleEnvio(props: PageProps<"/envios/[id]">) {
  return (
    <div className="flex flex-col gap-6">
      <Link href="/" className="text-sm font-semibold text-morado underline-offset-2 hover:underline">
        ← Volver al panel
      </Link>
      <Suspense fallback={<p className="py-20 text-center text-sm text-neutral-600">Cargando envío…</p>}>
        <Contenido params={props.params} />
      </Suspense>
    </div>
  );
}

async function Contenido({ params }: { params: PageProps<"/envios/[id]">["params"] }) {
  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) notFound();

  const [envio, eventos] = await Promise.all([obtenerEnvio(id), eventosDeEnvio(id)]);
  if (!envio) notFound();

  const { APP_TIMEZONE: zona, APP_URL, MONEDA } = configGeneral();
  const hora = (fecha: Date | null) => formatearFechaHora(fecha, zona) || "—";
  const linkRecordatorio = APP_URL ? `${APP_URL.replace(/\/$/, "")}/p/${envio.token}` : `/p/${envio.token}`;

  const datos: [string, ReactNode][] = [
    ["Etapa", envio.etapa],
    ["Programado para", formatearFechaCorta(envio.fecha_programada)],
    ["Vencimiento", formatearFechaCorta(envio.fecha_vencimiento)],
    ["Cuota", `#${envio.cuota_id}${envio.concepto ? ` · ${envio.concepto}` : ""}`],
    ["Valor", formatearMoneda(envio.valor, MONEDA) || "—"],
    ["Cliente", envio.cliente_id ?? "—"],
    ["Teléfono (fuente)", envio.telefono ?? "—"],
    ["Teléfono enviado", envio.telefono_e164 ?? "—"],
    ["Email", envio.email ?? "—"],
    [
      "Link de pago",
      envio.link_pago ? (
        <a href={envio.link_pago} target="_blank" rel="noreferrer" className="break-all text-morado underline">
          {envio.link_pago}
        </a>
      ) : (
        "—"
      ),
    ],
    ["Botón de la plantilla", <code key="boton" className="break-all text-xs">{linkRecordatorio}</code>],
    ["Contacto GHL", envio.ghl_contact_id ?? "—"],
    ["Intentos", envio.intentos],
    ["Enviado a GHL", hora(envio.enviado_en)],
    ["Confirmado por workflow", hora(envio.confirmado_workflow_en)],
    ["Entregado", hora(envio.entregado_en)],
    ["Leído", hora(envio.leido_en)],
    ["Clics en el botón", `${envio.clicks}${envio.primer_click_en ? ` (primero: ${hora(envio.primer_click_en)})` : ""}`],
  ];

  return (
    <>
      <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-morado/10 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-morado">{envio.nombre || "Sin nombre"}</h1>
            <div className="mt-2 flex items-center gap-2">
              <InsigniaEstado estado={envio.estado} />
              <span className="text-xs text-neutral-600">Envío #{envio.id}</span>
            </div>
          </div>
          {ESTADOS_REENVIABLES.includes(envio.estado) && (
            <BotonAccion
              accion={reenviarEnvio}
              campos={{ id: envio.id }}
              etiqueta={envio.estado === "pendiente" ? "Enviar ahora" : "Reenviar"}
              etiquetaPendiente="Enviando…"
              confirmar={envio.estado === "enviado" ? "Este recordatorio ya se envió. ¿Reenviarlo de todos modos?" : undefined}
            />
          )}
        </div>
        {envio.ultimo_error && (
          <p className="mt-4 rounded-2xl bg-red-50 p-3 text-sm text-red-900 ring-1 ring-red-200">{envio.ultimo_error}</p>
        )}
        <dl className="mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {datos.map(([termino, valor]) => (
            <div key={termino}>
              <dt className="text-xs font-semibold text-neutral-600">{termino}</dt>
              <dd className="text-sm">{valor}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="titulo-bitacora" className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-morado/10 sm:p-6">
        <h2 id="titulo-bitacora" className="mb-3 text-lg font-bold text-morado">
          Bitácora
        </h2>
        {eventos.length === 0 ? (
          <p className="text-sm text-neutral-600">Sin eventos todavía.</p>
        ) : (
          <ol className="divide-y divide-neutral-100">
            {eventos.map((ev) => (
              <li key={ev.id} className="py-3">
                <p className="text-sm">
                  <span className="font-semibold">{ev.tipo}</span>{" "}
                  <span className="text-neutral-600">· {hora(ev.creado_en)}</span>
                </p>
                {ev.detalle != null && (
                  <pre className="mt-1 overflow-x-auto rounded-xl bg-lienzo p-2 text-xs">
                    {JSON.stringify(ev.detalle, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
