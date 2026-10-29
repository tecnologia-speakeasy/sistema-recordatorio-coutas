export const ESTADOS_ENVIO = [
  "pendiente",
  "procesando",
  "enviado",
  "entregado",
  "leido",
  "fallido",
  "omitido",
] as const;

export type EstadoEnvio = (typeof ESTADOS_ENVIO)[number];

/** Estados desde los que se permite reenviar manualmente. */
export const ESTADOS_REENVIABLES: readonly EstadoEnvio[] = ["fallido", "omitido", "enviado", "pendiente"];

export interface Envio {
  id: string;
  cuota_id: string;
  etapa: string;
  fecha_vencimiento: string;
  fecha_programada: string;
  cliente_id: string | null;
  nombre: string | null;
  telefono: string | null;
  telefono_e164: string | null;
  email: string | null;
  valor: string | null;
  concepto: string | null;
  link_pago: string | null;
  token: string;
  estado: EstadoEnvio;
  intentos: number;
  ultimo_error: string | null;
  ghl_contact_id: string | null;
  ghl_conversation_id: string | null;
  ghl_message_id: string | null;
  enviado_en: Date | null;
  entregado_en: Date | null;
  leido_en: Date | null;
  confirmado_workflow_en: Date | null;
  clicks: number;
  primer_click_en: Date | null;
  creado_en: Date;
  actualizado_en: Date;
}

export interface Etapa {
  codigo: string;
  nombre: string;
  offset_dias: number;
  ghl_workflow_id: string | null;
  activa: boolean;
  orden: number;
}

/** Fila de recordatorios.v_cuotas_fuente (contrato con la BD de negocio). */
export interface CuotaFuente {
  cuota_id: string;
  cliente_id: string | null;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  valor: string | null;
  concepto: string | null;
  fecha_vencimiento: string;
  pagada: boolean;
  link_pago: string | null;
}

export interface ResultadoDespacho {
  enviados: number;
  fallidos: number;
  omitidos: number;
}

export interface ResumenCiclo extends ResultadoDespacho {
  ejecucionId: string;
  fecha: string;
  planificados: number;
  expirados: number;
  verificados: number;
  sincronizadosSheets: number;
  despachoEnVentana: boolean;
  errores: string[];
}
