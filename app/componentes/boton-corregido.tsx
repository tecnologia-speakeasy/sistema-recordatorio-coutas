import { marcarCorregido } from "@/app/acciones";
import type { EstadoEnvio } from "@/lib/recordatorios/tipos";
import { BotonAccion } from "./boton-accion";

/** "Corregido" en un envío fallido; "Quitar corregido" en uno ya marcado. Nada en los demás. */
export function BotonCorregido({
  envio,
  variante = "sutil",
}: {
  envio: { id: string; estado: EstadoEnvio };
  variante?: "sutil" | "secundario";
}) {
  if (envio.estado !== "fallido" && envio.estado !== "corregido") return null;
  const deshacer = envio.estado === "corregido";
  return (
    <BotonAccion
      accion={marcarCorregido}
      campos={{ id: envio.id, deshacer: deshacer ? "si" : undefined }}
      etiqueta={deshacer ? "Quitar corregido" : "Corregido"}
      etiquetaPendiente="Guardando…"
      variante={variante}
      mostrarResultado={variante !== "sutil"}
    />
  );
}
