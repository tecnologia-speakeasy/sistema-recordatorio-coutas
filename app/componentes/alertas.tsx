import Link from "next/link";
import type { Alerta, ClaveAlerta, FiltrosEnvios } from "@/lib/recordatorios/consultas";
import { formatearFechaCorta, formatearFechaHora } from "@/lib/utilidades";

const MAX_FILAS = 50;

const TEXTOS: Record<ClaveAlerta, { titulo: string; descripcion: string; urgente?: boolean }> = {
  whatsapp_fallido: {
    titulo: "WhatsApp que fallaron",
    descripcion: "No llegaron: falta el link, error de GHL o de WhatsApp (número sin WhatsApp…). Se pueden reenviar.",
    urgente: true,
  },
  sin_contacto_ghl: {
    titulo: "Sin contacto en GHL",
    descripcion:
      "GHL no encontró su correo y el WhatsApp no salió. Crea el contacto en GHL (o corrige el correo en cartera) y reenvía.",
    urgente: true,
  },
  reporto_sin_registro: {
    titulo: "Dijo «Pago realizado» y no figura en cartera",
    descripcion: "Verifica el pago (transferencia, otro correo…) y regístralo en cartera.",
    urgente: true,
  },
  pidio_soporte: {
    titulo: "Pidió soporte",
    descripcion: "Tocó «Soporte». Confirma que el equipo lo atendió.",
  },
  sin_abrir_link: {
    titulo: "Tocó «Realizar pago» y no abrió el link",
    descripcion: "Le llegó el botón «Pagar ahora» pero no lo abrió.",
  },
  abrio_sin_pagar: {
    titulo: "Abrió el link y no ha pagado",
    descripcion: "Hizo clic hace más de 3 h y la cuota sigue sin pagar en cartera.",
  },
  vencida_sin_pagar: {
    titulo: "Venció sin pagar",
    descripcion: "Recibió recordatorios y la cuota venció sin pago en cartera.",
  },
};

export function Alertas({ alertas, filtros, zona }: { alertas: Alerta[]; filtros: FiltrosEnvios; zona: string }) {
  return (
    <section aria-labelledby="titulo-alertas" className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-morado/10 sm:p-6">
      <h2 id="titulo-alertas" className="text-lg font-bold text-morado">
        Requieren atención
      </h2>
      <p className="mb-4 text-xs text-neutral-600">Envíos del rango filtrado. Toca una tarjeta para ver a quiénes.</p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {alertas.map(({ clave, filas }) => {
          const { titulo, descripcion, urgente } = TEXTOS[clave];
          const alerta = urgente && filas.length > 0;
          return (
            <details
              key={clave}
              className={`group rounded-2xl p-4 ring-1 ${alerta ? "bg-red-50 ring-red-200" : "bg-lienzo ring-morado/10"}`}
            >
              <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
                <span>
                  <span className="block text-sm font-bold text-morado">{titulo}</span>
                  <span className="text-xs text-neutral-700">{descripcion}</span>
                </span>
                <span className={`text-2xl font-bold tabular-nums ${alerta ? "text-red-700" : "text-morado"}`}>
                  {filas.length}
                </span>
              </summary>
              {filas.length > 0 && (
                <ul className="mt-3 flex max-h-96 flex-col divide-y divide-morado/10 overflow-y-auto">
                  {filas.slice(0, MAX_FILAS).map((f) => (
                    <li key={`${clave}-${f.envio_id}`} className="py-2 text-xs">
                      <Link href={`/envios/${f.envio_id}`} className="font-semibold text-morado underline-offset-2 hover:underline">
                        {f.nombre || "Sin nombre"}
                      </Link>
                      <span className="block text-neutral-700">
                        {[f.telefono, f.email].filter(Boolean).join(" · ") || "Sin datos de contacto"}
                      </span>
                      <span className="block text-neutral-600">
                        {f.concepto} · vence {formatearFechaCorta(f.fecha_vencimiento)}
                        {f.etapa && ` · ${f.etapa}`}
                        {f.cuando && ` · ${formatearFechaHora(f.cuando, zona)}`}
                      </span>
                      {f.detalle && <span className="mt-0.5 block text-neutral-800">{f.detalle}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {filas.length > MAX_FILAS && (
                <p className="mt-2 text-xs text-neutral-600">Se muestran {MAX_FILAS} de {filas.length}.</p>
              )}
              {(clave === "whatsapp_fallido" || clave === "sin_contacto_ghl") && filas.length > 0 && (
                <Link
                  href={`/?${new URLSearchParams({ desde: filtros.desde, hasta: filtros.hasta, estado: "fallido" })}`}
                  className="mt-2 inline-block text-xs font-semibold text-morado underline"
                >
                  Ver en la tabla para reenviar
                </Link>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}
