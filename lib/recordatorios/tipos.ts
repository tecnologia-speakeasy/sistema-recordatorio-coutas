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

export const ETIQUETAS_ESTADO: Record<EstadoEnvio, string> = {
  pendiente: "Pendiente",
  procesando: "Procesando",
  enviado: "Enviado",
  entregado: "Entregado",
  leido: "Leído",
  fallido: "Fallido",
  omitido: "Omitido",
};

/** Estados desde los que se permite reenviar manualmente. */
export const ESTADOS_REENVIABLES: readonly EstadoEnvio[] = ["fallido", "omitido", "enviado", "pendiente"];

/** Etapa que se crea con el clic en el link de pago (plantilla "¿pudiste pagar?"). */
export const ETAPA_SEGUIMIENTO = "SEG";

/** Botones de respuesta rápida que el workflow informa por webhook. */
export const RESPUESTAS = {
  pago_realizado: "Pago realizado",
  realizar_pago: "Realizar pago",
  soporte: "Soporte",
} as const;

export type Respuesta = keyof typeof RESPUESTAS;

/**
 * Lo que informa el workflow (por el mismo webhook de respuestas) cuando "Find
 * Contact" no encuentra el correo del estudiante en GHL. No es un botón.
 */
export const AVISO_SIN_CONTACTO = "contacto_no_encontrado";

/**
 * Inicio de `ultimo_error` de los envíos que no salieron porque GHL no tiene el
 * contacto (o cartera no tiene correo): así los separa el panel de alertas.
 */
export const PREFIJO_SIN_CONTACTO = "Sin contacto en GHL";

export const PASARELAS = { hotmart: "Hotmart", stripe: "Stripe" } as const;
export type Pasarela = keyof typeof PASARELAS;

/** Planes con link de pago propio (número total de cuotas). */
export const CUOTAS_CON_LINK = [2, 3, 4, 5, 6] as const;

/** Las 4 columnas de links por producto: pasarela x con/sin descuento de referido. */
export const COLUMNAS_LINK: { pasarela: Pasarela; referido: boolean; titulo: string }[] = [
  { pasarela: "hotmart", referido: false, titulo: "Hotmart" },
  { pasarela: "hotmart", referido: true, titulo: "Hotmart · referido" },
  { pasarela: "stripe", referido: false, titulo: "Stripe" },
  { pasarela: "stripe", referido: true, titulo: "Stripe · referido" },
];

/** Nombre del campo del formulario: link_hotmart_4, link_hotmart_ref_4... */
export const campoLink = (pasarela: Pasarela, referido: boolean, cuotas: number) =>
  `link_${pasarela}${referido ? "_ref" : ""}_${cuotas}`;

export interface Envio {
  id: string;
  cuota_id: string;
  compra_id: string;
  producto_id: string;
  cuota_numero: number;
  total_cuotas: number;
  etapa: string;
  fecha_vencimiento: string;
  fecha_programada: string;
  programado_para: Date | null;
  origen_envio_id: string | null;
  nombre: string | null;
  telefono: string | null;
  telefono_e164: string | null;
  email: string | null;
  pais: string | null;
  producto: string | null;
  metodo_pago: string | null;
  pasarela: Pasarela | null;
  referido: boolean;
  descuento: string | null;
  concepto: string | null;
  link_pago: string | null;
  token: string;
  estado: EstadoEnvio;
  simulado: boolean;
  intentos: number;
  ultimo_error: string | null;
  ghl_contact_id: string | null;
  ghl_conversation_id: string | null;
  ghl_message_id: string | null;
  enviado_en: Date | null;
  entregado_en: Date | null;
  leido_en: Date | null;
  clicks: number;
  primer_click_en: Date | null;
  respuesta: Respuesta | null;
  respondido_en: Date | null;
  realizar_pago_en: Date | null;
  soporte_en: Date | null;
  pago_reportado_en: Date | null;
  creado_en: Date;
  actualizado_en: Date;
}

export interface Etapa {
  codigo: string;
  nombre: string;
  /** null = seguimiento (no se planifica por fecha). */
  offset_dias: number | null;
  plantilla: string | null;
  ghl_webhook_url: string | null;
  activa: boolean;
  orden: number;
}

/** Fila de recordatorios.v_cuotas_fuente (ver db/migraciones/002_vista_fuente.sql). */
export interface CuotaFuente {
  cuota_id: string;
  compra_id: string;
  producto_id: string;
  producto: string;
  cuota_numero: number;
  total_cuotas: number;
  concepto: string;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  pais: string | null;
  metodo_pago: string | null;
  pasarela: Pasarela;
  fecha_vencimiento: string;
  pagada: boolean;
  link_pago: string | null;
  /** Descuento de referido: usa los links "DESCUENTO REFERIDO N CUOTAS". */
  referido: boolean;
  descuento: string | null;
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
