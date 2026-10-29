import type { Kpis } from "@/lib/recordatorios/consultas";

const porcentaje = (parte: number, total: number) => (total ? `${Math.round((parte / total) * 100)} %` : "—");

export function TarjetasKpi({ kpis }: { kpis: Kpis }) {
  const e = kpis.porEstado;
  const enviados = e.enviado + e.entregado + e.leido;
  const entregados = e.entregado + e.leido;

  const tarjetas = [
    { titulo: "Envíos en el rango", valor: kpis.total, nota: `${e.pendiente + e.procesando} en cola` },
    { titulo: "Enviados a GHL", valor: enviados, nota: `${porcentaje(entregados, enviados)} entregados` },
    { titulo: "Leídos", valor: e.leido, nota: `${porcentaje(e.leido, enviados)} de los enviados` },
    { titulo: "Fallidos", valor: e.fallido, nota: "Reenviables desde la tabla", alerta: e.fallido > 0 },
    { titulo: "Omitidos", valor: e.omitido, nota: "Pagadas, sin datos o fuera de fecha" },
    { titulo: "Clic en el botón", valor: kpis.conClick, nota: `${porcentaje(kpis.conClick, enviados)} de los enviados` },
    {
      titulo: "Pagadas tras recordatorio",
      valor: kpis.pagadasTrasRecordatorio ?? "—",
      nota:
        kpis.pagadasTrasRecordatorio === null
          ? "Vista fuente no disponible"
          : `${porcentaje(kpis.pagadasTrasRecordatorio, kpis.cuotasRecordadas)} de ${kpis.cuotasRecordadas} cuotas`,
    },
  ];

  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      {tarjetas.map((t) => (
        <li
          key={t.titulo}
          className={`rounded-3xl bg-white p-4 shadow-sm ring-1 ${t.alerta ? "ring-red-300" : "ring-morado/10"}`}
        >
          <p className="text-xs font-semibold text-neutral-600">{t.titulo}</p>
          <p className={`mt-1 text-3xl font-bold ${t.alerta ? "text-red-700" : "text-morado"}`}>{t.valor}</p>
          <p className="mt-1 text-xs text-neutral-600">{t.nota}</p>
        </li>
      ))}
    </ul>
  );
}
