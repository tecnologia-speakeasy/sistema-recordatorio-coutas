import "server-only";
import { configGhl } from "./config";
import { esperar } from "./utilidades";

/**
 * Cliente mínimo de HighLevel API v2 (services.leadconnectorhq.com).
 *
 * WhatsApp: la API pública de mensajes no expone envío de plantillas con
 * variables, así que el envío lo hace un workflow de GHL. Este sistema:
 *   1. hace upsert del contacto con los campos personalizados del recordatorio,
 *   2. inscribe el contacto en el workflow de la etapa,
 *   3. luego consulta la conversación para leer el estado real del mensaje.
 */

/** Claves (sin el prefijo "contact.") de los campos personalizados que deben existir en GHL. */
export const CAMPOS_GHL = {
  token: "recordatorio_token",
  valor: "recordatorio_valor",
  fechaLimite: "recordatorio_fecha_limite",
  concepto: "recordatorio_concepto",
  etapa: "recordatorio_etapa",
  envioId: "recordatorio_envio_id",
} as const;

export type CampoGhl = keyof typeof CAMPOS_GHL;

export class ErrorGhl extends Error {
  constructor(
    message: string,
    readonly estadoHttp: number,
    readonly cuerpo: unknown,
  ) {
    super(message);
    this.name = "ErrorGhl";
  }
}

async function solicitud<T>(metodo: "GET" | "POST", ruta: string, cuerpo?: unknown): Promise<T> {
  const config = configGhl();
  const url = `${config.GHL_API_URL}${ruta}`;

  for (let intento = 1; ; intento++) {
    const respuesta = await fetch(url, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${config.GHL_TOKEN}`,
        Version: config.GHL_API_VERSION,
        Accept: "application/json",
        ...(cuerpo !== undefined && { "Content-Type": "application/json" }),
      },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });

    const texto = await respuesta.text();
    const datos = texto ? safeJson(texto) : null;

    if (respuesta.ok) return datos as T;

    const reintentable = respuesta.status === 429 || respuesta.status >= 500;
    if (reintentable && intento < 4) {
      const retryAfter = Number(respuesta.headers.get("retry-after"));
      await esperar(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * intento);
      continue;
    }

    throw new ErrorGhl(
      `GHL ${metodo} ${ruta} -> ${respuesta.status}: ${extraerMensaje(datos) ?? respuesta.statusText}`,
      respuesta.status,
      datos,
    );
  }
}

function safeJson(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

function extraerMensaje(datos: unknown): string | null {
  if (!datos || typeof datos !== "object") return typeof datos === "string" ? datos.slice(0, 300) : null;
  const { message } = datos as { message?: unknown };
  if (Array.isArray(message)) return message.join("; ");
  return typeof message === "string" ? message : JSON.stringify(datos).slice(0, 300);
}

// ---------------------------------------------------------------------------
// Campos personalizados: se resuelven por clave a id y se cachean 10 minutos.
// ---------------------------------------------------------------------------

let cacheCampos: { ids: Record<CampoGhl, string>; expira: number } | null = null;

export async function idsCamposPersonalizados(): Promise<Record<CampoGhl, string>> {
  if (cacheCampos && cacheCampos.expira > Date.now()) return cacheCampos.ids;

  const { GHL_LOCATION_ID } = configGhl();
  const { customFields } = await solicitud<{ customFields: { id: string; fieldKey: string }[] }>(
    "GET",
    `/locations/${encodeURIComponent(GHL_LOCATION_ID)}/customFields?model=contact`,
  );

  const porClave = new Map(customFields.map((c) => [c.fieldKey.replace(/^contact\./, ""), c.id]));
  const faltantes = Object.values(CAMPOS_GHL).filter((clave) => !porClave.has(clave));
  if (faltantes.length) {
    throw new ErrorGhl(
      `Faltan campos personalizados de contacto en GHL: ${faltantes.map((c) => `contact.${c}`).join(", ")}`,
      0,
      null,
    );
  }

  const ids = Object.fromEntries(
    Object.entries(CAMPOS_GHL).map(([campo, clave]) => [campo, porClave.get(clave)!]),
  ) as Record<CampoGhl, string>;
  cacheCampos = { ids, expira: Date.now() + 10 * 60_000 };
  return ids;
}

// ---------------------------------------------------------------------------
// Contactos y workflows
// ---------------------------------------------------------------------------

export interface DatosContacto {
  telefono: string;
  nombre: string | null;
  campos: Record<CampoGhl, string>;
}

export async function upsertContacto({ telefono, nombre, campos }: DatosContacto): Promise<string> {
  const { GHL_LOCATION_ID } = configGhl();
  const ids = await idsCamposPersonalizados();
  const [firstName, ...resto] = (nombre ?? "").trim().split(/\s+/);

  // Solo se envían teléfono, nombre y campos del recordatorio. No se envían
  // `tags` (sobrescribiría todas las etiquetas) ni email (evita fusiones
  // inesperadas si la deduplicación de la cuenta prioriza el email).
  const respuesta = await solicitud<{ contact?: { id?: string } }>("POST", "/contacts/upsert", {
    locationId: GHL_LOCATION_ID,
    phone: telefono,
    ...(firstName && { firstName, lastName: resto.join(" ") || undefined }),
    source: "recordatorio-cuotas",
    customFields: (Object.keys(campos) as CampoGhl[]).map((campo) => ({
      id: ids[campo],
      fieldValue: campos[campo],
    })),
  });

  const id = respuesta?.contact?.id;
  if (!id) throw new ErrorGhl("GHL no devolvió el id del contacto en el upsert", 200, respuesta);
  return id;
}

export async function inscribirEnWorkflow(contactId: string, workflowId: string): Promise<void> {
  const respuesta = await solicitud<{ succeeded?: boolean; succeded?: boolean }>(
    "POST",
    `/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(workflowId)}`,
    {},
  );
  if ((respuesta?.succeeded ?? respuesta?.succeded) === false) {
    throw new ErrorGhl("GHL rechazó la inscripción en el workflow", 200, respuesta);
  }
}

// ---------------------------------------------------------------------------
// Conversaciones: lectura del estado real del mensaje de WhatsApp
// ---------------------------------------------------------------------------

export interface MensajeGhl {
  id: string;
  direction: "inbound" | "outbound";
  status?: string;
  dateAdded: string;
  source?: string;
  error?: string;
  messageType?: string;
}

export async function buscarConversacion(contactId: string): Promise<string | null> {
  const { GHL_LOCATION_ID } = configGhl();
  const params = new URLSearchParams({ locationId: GHL_LOCATION_ID, contactId, limit: "5" });
  const { conversations } = await solicitud<{ conversations: { id: string }[] }>(
    "GET",
    `/conversations/search?${params}`,
  );
  return conversations[0]?.id ?? null;
}

export async function mensajesWhatsapp(conversationId: string): Promise<MensajeGhl[]> {
  const params = new URLSearchParams({ type: "TYPE_WHATSAPP", limit: "20" });
  const respuesta = await solicitud<{ messages: { messages: MensajeGhl[] } }>(
    "GET",
    `/conversations/${encodeURIComponent(conversationId)}/messages?${params}`,
  );
  return respuesta.messages?.messages ?? [];
}
