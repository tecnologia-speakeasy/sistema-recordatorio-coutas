import "server-only";
import { z } from "zod";

/**
 * Configuración tipada por dominio. Cada grupo se valida solo cuando se usa,
 * para que el dashboard funcione aunque, por ejemplo, Sheets no esté configurado.
 */

const booleano = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const opcional = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined);

const esquemaGeneral = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  // URL pública de esta app: base del link rastreado que recibe el estudiante (/p/<token>).
  APP_URL: z.url("APP_URL es obligatoria (URL pública de esta app)").transform((v) => v.replace(/\/+$/, "")),
  APP_TIMEZONE: z.string().default("America/Bogota"),
  // Solo se usa si el país de la compra no se reconoce y el número no trae indicativo.
  TELEFONO_CODIGO_PAIS: z.string().regex(/^\d{1,3}$/).default("57"),
  // Ventana horaria (zona APP_TIMEZONE) en la que el cron puede despachar: [inicio, fin).
  HORA_INICIO_ENVIO: z.coerce.number().int().min(0).max(23).default(8),
  HORA_FIN_ENVIO: z.coerce.number().int().min(1).max(24).default(20),
  // Tiempo máximo que una ejecución dedica a despachar (debe ser < maxDuration del endpoint).
  PRESUPUESTO_EJECUCION_SEG: z.coerce.number().int().min(10).default(240),
  // Separación mínima entre dos envíos al mismo contacto (mismo correo), para que la
  // verificación asocie cada mensaje de WhatsApp a su envío.
  ESPERA_MISMO_CONTACTO_SEG: z.coerce.number().int().min(0).default(60),
  // Horas entre el primer clic en el link de pago y el mensaje de seguimiento.
  SEGUIMIENTO_HORAS: z.coerce.number().min(0).max(72).default(3),
});

const esquemaGhl = z.object({
  // Solo lectura (verificar entregas). Sin token, los envíos quedan en "enviado".
  GHL_TOKEN: opcional,
  GHL_LOCATION_ID: opcional,
  GHL_API_URL: z.url().default("https://services.leadconnectorhq.com"),
  GHL_DRY_RUN: booleano,
});

const esquemaSheets = z.object({
  // Webhook de n8n (Webhook → Split Out → Google Sheets "Append or Update").
  SHEETS_WEBHOOK_URL: z.url("SHEETS_WEBHOOK_URL debe ser la URL de producción del webhook de n8n"),
});

const esquemaSeguridad = z.object({
  CRON_SECRET: z.string().min(16, "CRON_SECRET debe tener al menos 16 caracteres"),
  DASHBOARD_USUARIO: z.string().min(1),
  DASHBOARD_CLAVE: z.string().min(12, "DASHBOARD_CLAVE debe tener al menos 12 caracteres"),
  GHL_WEBHOOK_SECRET: z.string().min(16).optional(),
});

export class ErrorConfiguracion extends Error {
  constructor(grupo: string, error: z.ZodError) {
    super(`Configuración inválida (${grupo}): ${z.prettifyError(error)}`);
    this.name = "ErrorConfiguracion";
  }
}

function cargar<T extends z.ZodType>(grupo: string, esquema: T): z.output<T> {
  const resultado = esquema.safeParse(process.env);
  if (!resultado.success) throw new ErrorConfiguracion(grupo, resultado.error);
  return resultado.data;
}

/** Lectura independiente para el dashboard, que no necesita el resto de la config de GHL. */
export const modoSimulacion = () => booleano.safeParse(process.env.GHL_DRY_RUN).data ?? false;

export const configGeneral = () => cargar("general", esquemaGeneral);
export const configGhl = () => cargar("GHL", esquemaGhl);
export const configSeguridad = () => cargar("seguridad", esquemaSeguridad);

/** La API de GHL (token + location) solo se necesita para verificar entregas. */
export function apiGhlConfigurada(): boolean {
  const { GHL_TOKEN, GHL_LOCATION_ID } = configGhl();
  return Boolean(GHL_TOKEN && GHL_LOCATION_ID);
}

/** null = Google Sheets no está configurado (la sincronización se salta). */
export function configSheets() {
  if (!process.env.SHEETS_WEBHOOK_URL) return null;
  return cargar("Google Sheets", esquemaSheets);
}
