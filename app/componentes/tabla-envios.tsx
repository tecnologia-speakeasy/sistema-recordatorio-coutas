import Link from "next/link";
import { reenviarEnvio } from "@/app/acciones";
import { TAMANO_PAGINA, type FiltrosEnvios } from "@/lib/recordatorios/consultas";
import { ESTADOS_REENVIABLES, type Envio } from "@/lib/recordatorios/tipos";
import { formatearFechaCorta, formatearFechaHora, formatearMoneda } from "@/lib/utilidades";
import { BotonAccion } from "./boton-accion";
import { InsigniaEstado } from "./insignia-estado";

interface Props {
  filas: Envio[];
  total: number;
  filtros: FiltrosEnvios;
  zona: string;
  moneda: string;
}

export function TablaEnvios({ filas, total, filtros, zona, moneda }: Props) {
  if (!filas.length) {
    return <p className="py-10 text-center text-sm text-neutral-600">No hay envíos con estos filtros.</p>;
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <caption className="sr-only">Envíos de recordatorios</caption>
          <thead className="border-b border-neutral-200 text-xs text-neutral-600">
            <tr>
              <th scope="col" className="py-2 pr-3 font-semibold">Programado</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Destinatario</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Cuota</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Estado</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Detalle</th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">Clics</th>
              <th scope="col" className="py-2 font-semibold">
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {filas.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="py-3 pr-3 whitespace-nowrap">
                  <span className="block font-semibold text-morado">{e.etapa}</span>
                  <span className="text-xs text-neutral-600">{formatearFechaCorta(e.fecha_programada)}</span>
                </td>
                <td className="py-3 pr-3">
                  <span className="block font-medium">{e.nombre || "Sin nombre"}</span>
                  <span className="text-xs text-neutral-600">{e.telefono_e164 ?? e.telefono ?? "Sin teléfono"}</span>
                </td>
                <td className="py-3 pr-3">
                  <span className="block">{formatearMoneda(e.valor, moneda) || "—"}</span>
                  <span className="text-xs text-neutral-600">
                    Vence {formatearFechaCorta(e.fecha_vencimiento)} · #{e.cuota_id}
                  </span>
                </td>
                <td className="py-3 pr-3 whitespace-nowrap">
                  <InsigniaEstado estado={e.estado} />
                  <span className="mt-1 block text-xs text-neutral-600">
                    {e.enviado_en ? formatearFechaHora(e.enviado_en, zona) : `${e.intentos} intentos`}
                  </span>
                </td>
                <td className="max-w-72 py-3 pr-3 text-xs text-neutral-700">
                  <span className="line-clamp-2" title={e.ultimo_error ?? undefined}>
                    {e.ultimo_error}
                  </span>
                </td>
                <td className="py-3 pr-3 text-right tabular-nums">{e.clicks}</td>
                <td className="py-3">
                  <div className="flex items-center justify-end gap-2">
                    <Link
                      href={`/envios/${e.id}`}
                      className="px-1 text-sm font-semibold text-morado underline-offset-2 hover:underline"
                    >
                      Ver
                    </Link>
                    {ESTADOS_REENVIABLES.includes(e.estado) && (
                      <BotonAccion
                        accion={reenviarEnvio}
                        campos={{ id: e.id }}
                        etiqueta={e.estado === "pendiente" ? "Enviar ahora" : "Reenviar"}
                        etiquetaPendiente="Enviando…"
                        variante="sutil"
                        mostrarResultado={false}
                        confirmar={
                          e.estado === "enviado"
                            ? `Este recordatorio ya se envió a ${e.nombre ?? "este contacto"}. ¿Reenviarlo de todos modos?`
                            : undefined
                        }
                      />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Paginacion total={total} filtros={filtros} />
    </>
  );
}

function Paginacion({ total, filtros }: { total: number; filtros: FiltrosEnvios }) {
  const paginas = Math.max(1, Math.ceil(total / TAMANO_PAGINA));
  const enlace = (pagina: number) => {
    const params = new URLSearchParams();
    for (const [clave, valor] of Object.entries({ ...filtros, pagina: String(pagina) })) {
      if (valor) params.set(clave, String(valor));
    }
    return `/?${params}`;
  };

  return (
    <nav aria-label="Paginación" className="mt-4 flex items-center justify-between text-sm">
      <p className="text-neutral-600">
        {total} envíos · página {filtros.pagina} de {paginas}
      </p>
      <div className="flex gap-2">
        {filtros.pagina > 1 && (
          <Link href={enlace(filtros.pagina - 1)} className="rounded-full px-4 py-1.5 font-semibold text-morado ring-1 ring-morado/25">
            Anterior
          </Link>
        )}
        {filtros.pagina < paginas && (
          <Link href={enlace(filtros.pagina + 1)} className="rounded-full px-4 py-1.5 font-semibold text-morado ring-1 ring-morado/25">
            Siguiente
          </Link>
        )}
      </div>
    </nav>
  );
}
