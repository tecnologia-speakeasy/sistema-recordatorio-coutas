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

const esquemaGeneral = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  APP_URL: z.url().optional(),
  APP_TIMEZONE: z.string().default("America/Bogota"),
  TELEFONO_CODIGO_PAIS: z.string().regex(/^\d{1,3}$/).default("57"),
  MONEDA: z.string().length(3).default("COP"),
  // Ventana horaria (zona APP_TIMEZONE) en la que el cron puede despachar: [inicio, fin).
  HORA_INICIO_ENVIO: z.coerce.number().int().min(0).max(23).default(8),
  HORA_FIN_ENVIO: z.coerce.number().int().min(1).max(24).default(20),
  // Tiempo máximo que una ejecución dedica a despachar (debe ser < maxDuration del endpoint).
  PRESUPUESTO_EJECUCION_SEG: z.coerce.number().int().min(10).default(240),
  // Separación mínima entre dos envíos al mismo teléfono: los campos del contacto
  // en GHL se sobrescriben, así que el workflow anterior debe leerlos antes.
  ESPERA_MISMO_CONTACTO_SEG: z.coerce.number().int().min(0).default(60),
});

const esquemaGhl = z.object({
  GHL_TOKEN: z.string().min(1, "GHL_TOKEN es obligatorio"),
  GHL_LOCATION_ID: z.string().min(1, "GHL_LOCATION_ID es obligatorio"),
  GHL_API_URL: z.url().default("https://services.leadconnectorhq.com"),
  GHL_API_VERSION: z.string().default("v3"),
  GHL_DRY_RUN: booleano,
});

const esquemaSheets = z.object({
  GOOGLE_SHEETS_ID: z.string().min(1),
  GOOGLE_SHEETS_PESTANA: z.string().default("Envios"),
  GOOGLE_SA_EMAIL: z.email(),
  GOOGLE_SA_PRIVATE_KEY: z.string().min(1),
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

export function configSheets() {
  if (!process.env.GOOGLE_SHEETS_ID) return null;
  const config = cargar("Google Sheets", esquemaSheets);
  // Las llaves PEM suelen guardarse en una sola línea con "\n" escapados.
  return { ...config, GOOGLE_SA_PRIVATE_KEY: config.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n") };
}
