import "server-only";
import { configGhl } from "./config";
import { esperar } from "./utilidades";

/**
 * Integración con HighLevel.
 *
 * Envío: cada etapa tiene un workflow cuyo disparador es "Inbound Webhook". El
 * sistema hace POST a la URL de ese webhook con los datos del recordatorio y el
 * workflow los usa como {{inboundWebhookRequest.<campo>}} en la plantilla. No se
 * crean campos personalizados ni se modifican contactos desde aquí.
 *
 * Lectura (opcional, con GHL_TOKEN): se busca el contacto por teléfono y se lee
 * su conversación para conocer el estado real del mensaje de WhatsApp.
 */

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

/** fetch con reintentos ante 429/5xx. `descripcion` va en el error (no incluir secretos). */
async function pedir<T>(url: string, init: RequestInit, descripcion: string): Promise<T> {
  for (let intento = 1; ; intento++) {
    const respuesta = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(20_000) });
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
      `${descripcion} -> ${respuesta.status}: ${extraerMensaje(datos) ?? respuesta.statusText}`,
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
// Envío: webhook entrante del workflow
// ---------------------------------------------------------------------------

/** Datos que recibe el workflow: todos texto plano (GHL no admite objetos ni arrays). */
export type DatosWorkflow = Record<string, string>;

export function dispararWorkflow(urlWebhook: string, datos: DatosWorkflow): Promise<unknown> {
  return pedir(
    urlWebhook,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(datos),
    },
    "Webhook del workflow de GHL",
  );
}

// ---------------------------------------------------------------------------
// Lectura: contacto, conversación y estado del mensaje de WhatsApp
// ---------------------------------------------------------------------------

function api<T>(ruta: string): Promise<T> {
  const config = configGhl();
  if (!config.GHL_TOKEN || !config.GHL_LOCATION_ID) {
    throw new Error("Falta GHL_TOKEN o GHL_LOCATION_ID para consultar GHL");
  }
  return pedir<T>(
    `${config.GHL_API_URL}${ruta}`,
    {
      headers: {
        Authorization: `Bearer ${config.GHL_TOKEN}`,
        Version: config.GHL_API_VERSION,
        Accept: "application/json",
      },
    },
    `GHL GET ${ruta.split("?")[0]}`,
  );
}

/** Contacto que el workflow usó para enviar: se busca por teléfono y, si no aparece, por email. */
export async function buscarContacto(telefono: string, email: string | null): Promise<string | null> {
  const { GHL_LOCATION_ID } = configGhl();
  const criterios: Record<string, string>[] = [{ number: telefono }, ...(email ? [{ email }] : [])];
  for (const criterio of criterios) {
    const params = new URLSearchParams({ locationId: GHL_LOCATION_ID ?? "", ...criterio });
    try {
      const respuesta = await api<{ contact?: { id?: string } | null }>(`/contacts/search/duplicate?${params}`);
      if (respuesta?.contact?.id) return respuesta.contact.id;
    } catch (error) {
      if (!(error instanceof ErrorGhl && error.estadoHttp === 404)) throw error;
    }
  }
  return null;
}

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
  const params = new URLSearchParams({ locationId: GHL_LOCATION_ID ?? "", contactId, limit: "5" });
  const { conversations } = await api<{ conversations: { id: string }[] }>(`/conversations/search?${params}`);
  return conversations[0]?.id ?? null;
}

export async function mensajesWhatsapp(conversationId: string): Promise<MensajeGhl[]> {
  const params = new URLSearchParams({ type: "TYPE_WHATSAPP", limit: "20" });
  const respuesta = await api<{ messages: { messages: MensajeGhl[] } }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages?${params}`,
  );
  return respuesta.messages?.messages ?? [];
}
