import { NextResponse, type NextRequest } from "next/server";
import { registrarClic } from "@/lib/recordatorios/interacciones";
import { esUrlHttp } from "@/lib/utilidades";

// Las vistas previas de enlaces no cuentan como clic. El robot de WhatsApp se
// identifica como "WhatsApp/2.x"; un navegador real (incluido el que abre WhatsApp)
// empieza por "Mozilla/", aunque mencione WhatsApp más adelante.
const ROBOT_PREVISUALIZACION = /facebookexternalhit|facebot|telegrambot|slackbot|twitterbot|discordbot|bot\b|crawler|spider|preview/i;
const esPrevisualizacion = (agente: string) =>
  ROBOT_PREVISUALIZACION.test(agente) || (/whatsapp/i.test(agente) && !/^Mozilla\//i.test(agente));

/**
 * Link rastreado que recibe el estudiante: https://<app>/p/<token>
 * (como texto en el mensaje o como sufijo del botón de URL dinámica).
 * Registra el clic, programa el seguimiento y redirige a su link de pago
 * (Hotmart o Stripe según su método y su plan de cuotas).
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/p/[token]">) {
  const { token } = await ctx.params;
  if (!/^[a-f0-9]{32}$/.test(token)) return noDisponible();

  const agente = request.headers.get("user-agent") ?? "";
  const destino = await registrarClic(token, agente, esPrevisualizacion(agente));
  if (!esUrlHttp(destino)) return noDisponible();

  return NextResponse.redirect(destino, 302);
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
