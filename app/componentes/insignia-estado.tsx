import type { EstadoEnvio } from "@/lib/recordatorios/tipos";

export const ETIQUETAS_ESTADO: Record<EstadoEnvio, string> = {
  pendiente: "Pendiente",
  procesando: "Procesando",
  enviado: "Enviado",
  entregado: "Entregado",
  leido: "Leído",
  fallido: "Fallido",
  omitido: "Omitido",
};

const ESTILOS: Record<EstadoEnvio, string> = {
  pendiente: "bg-neutral-100 text-neutral-700 ring-neutral-300",
  procesando: "bg-sky-100 text-sky-900 ring-sky-300",
  enviado: "bg-morado-claro text-morado ring-morado/30",
  entregado: "bg-emerald-100 text-emerald-900 ring-emerald-300",
  leido: "bg-emerald-700 text-white ring-emerald-700",
  fallido: "bg-red-100 text-red-800 ring-red-300",
  omitido: "bg-amber-100 text-amber-900 ring-amber-300",
};

export function InsigniaEstado({ estado }: { estado: EstadoEnvio }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${ESTILOS[estado]}`}>
      {ETIQUETAS_ESTADO[estado]}
    </span>
  );
}
