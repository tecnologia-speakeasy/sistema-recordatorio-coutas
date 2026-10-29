import { NextResponse, type NextRequest } from "next/server";
import { consultarUno } from "@/lib/db";
import { registrarEvento } from "@/lib/recordatorios/bitacora";

// Las vistas previas de enlaces (WhatsApp, Facebook, etc.) no cuentan como clic.
const AGENTE_PREVISUALIZACION = /whatsapp|facebookexternalhit|facebot|telegrambot|slackbot|twitterbot|bot\b|crawler|spider|preview/i;

/**
 * Destino del botón de URL dinámica de la plantilla: https://<app>/p/{{1}}
 * Registra el clic y redirige al link de pago propio del usuario.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/p/[token]">) {
  const { token } = await ctx.params;
  if (!/^[a-f0-9]{32}$/.test(token)) return noDisponible();

  const agente = request.headers.get("user-agent") ?? "";
  const esPrevisualizacion = AGENTE_PREVISUALIZACION.test(agente);

  const envio = esPrevisualizacion
    ? await consultarUno<{ id: string; link_pago: string | null }>(
        "SELECT id, link_pago FROM recordatorios.envios WHERE token = $1",
        [token],
      )
    : await consultarUno<{ id: string; link_pago: string | null }>(
        `UPDATE recordatorios.envios
         SET clicks = clicks + 1, primer_click_en = COALESCE(primer_click_en, now())
         WHERE token = $1
         RETURNING id, link_pago`,
        [token],
      );

  if (!envio?.link_pago || !/^https?:\/\//i.test(envio.link_pago)) return noDisponible();
  if (!esPrevisualizacion) await registrarEvento(envio.id, "click", { agente: agente.slice(0, 200) });

  return NextResponse.redirect(envio.link_pago, 302);
}

function noDisponible() {
  return new Response(
    `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enlace no disponible</title>
<body style="font-family:Montserrat,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#41276B;color:#fff;text-align:center;padding:24px">
<main><h1 style="font-size:1.5rem">Este enlace no está disponible</h1>
<p>Si necesitas pagar tu cuota, responde al mensaje de WhatsApp y te ayudamos.</p></main></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
