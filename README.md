# Sistema de recordatorios de cuotas (WhatsApp vía GHL)

Envía por WhatsApp los recordatorios de pago de las cuotas de **Aprende Inglés con Speak Easy** a partir de la cartera (`public.cartera_*`, módulo Administrativo · Cartera de *inventario-speakeasy*). Registra cada envío en el esquema propio `recordatorios`, rastrea el clic en el link de pago y, 3 horas después, pregunta si pudo pagar. Además verifica la entrega real en GHL, refleja todo en Google Sheets y ofrece un dashboard para revisar y reenviar.

Stack: Next.js 16 (App Router, Cache Components, `proxy.ts`), `pg`, `zod`. Sin SDKs externos; Google Sheets (opcional) va por un workflow de n8n.

---

## Cómo funciona

```
                 ┌──────────── cron (cada 15 min, 8–19:45 h) ───────────┐
                 ▼                                                       │
  GET /api/cron/recordatorios  (Bearer CRON_SECRET)                      │
        │                                                                │
        ├─ 1. Higiene     colgados → fallido · pendientes vencidos → omitido
        ├─ 2. Planificar  v_cuotas_fuente × etapas → recordatorios.envios (idempotente)
        ├─ 3. Despachar   relee cartera (¿pagó? ¿respondió "Pago realizado"?)
        │                 → POST al webhook entrante del workflow de la etapa ──► GHL envía la plantilla
        ├─ 4. Verificar   (con GHL_TOKEN) conversación del contacto → entregado / leído / fallido
        └─ 5. Sheets      una fila por estudiante y cuota, en pestañas "Cuota 2", "Cuota 3"...

  Link de pago que recibe el estudiante:  APP_URL/p/<token>
        └─► registra el clic ─► programa el seguimiento (+3 h) ─► 302 a Hotmart/Stripe

  Botones de WhatsApp ("Pago realizado", "Soporte") y
  correo que no está en GHL ("contacto_no_encontrado"):  workflow ─► POST /api/webhooks/ghl
```

**En GHL no se crean campos, ni se crean o modifican contactos.** Cada etapa tiene su workflow con disparador *Inbound Webhook*: el sistema le envía los datos del recordatorio y el workflow los usa como `{{inboundWebhookRequest.campo}}`. El workflow busca al estudiante **por correo**, y el WhatsApp sale al teléfono que tiene ese contacto en GHL; por eso el teléfono de cartera es opcional. Si GHL no tiene el correo, el workflow avisa y el envío queda en la alerta **Sin contacto en GHL**.

### ¿Se necesita un cron?

Sí. Lo recomendable es **cada 15 minutos (o cada hora) dentro de la ventana de envío**:

- el día 17 salen todos los D-3 de la generación a la vez, y si no alcanzan en una ejecución la siguiente continúa;
- los seguimientos salen 3 h después de cada clic, así que hace falta revisar a lo largo del día;
- la verificación de entrega solo sirve si corre unas horas después del envío;
- todo es idempotente: ejecutarlo de más no duplica mensajes.

---

## Reglas de cobro

| Regla | Detalle |
|---|---|
| **A quién** | Compras con `medio_pago = CUOTAS` de productos activos en el dashboard (hoy *G2*) y en estado `ACTIVO`. No incluye ventas de contado, canceladas ni otros estados. |
| **Qué cuota** | La cuota 1 se paga al comprar, en el mes del primer pago. La cuota N vence el **día 20** del mes inicio + N − 1. En G2 la cuota 2 vence el 20 de noviembre y la 3 el 20 de diciembre. |
| **¿Ya la pagó?** | La cuota N está pagada si `cuotas_pagadas ≥ N`. Ejemplo: un plan de 3 cuotas con 2 pagadas no recibe nada en noviembre, pero sí en diciembre. |
| **Cuándo** | D-3 (día 17), D-1 (19), D0 (20), D+1 (21). Antes de cada envío se relee cartera: si ya pagó, se omite. |
| **Qué link** | Método de la compra **Stripe** → link de Stripe; **cualquier otro** (Hotmart, Zelle, Bancolombia, Nequi…) → link de Hotmart. Del plan de su número total de cuotas (2 a 6), y en su versión **referido** si la compra tiene el descuento *REFERIDO*. Son 20 links por producto, que se leen de los **Enlaces de ventas del lanzamiento** (ver 3). |
| **Seguimiento** | 3 h después del **primer clic** en *Pagar ahora* sale el mensaje "¿pudiste pagar?". Es un mensaje normal, no una plantilla. Sale una sola vez por cuota, dentro de la ventana horaria y con la ventana de 24 h de WhatsApp abierta. |
| **"Pago realizado"** | Si el estudiante lo responde, queda en el dashboard y en Sheets, y **se detienen los recordatorios restantes de esa cuota**. |

La lógica está en la vista `recordatorios.v_cuotas_fuente`, cuya versión vigente está en [db/migraciones/003_referidos_y_lanzamiento.sql](db/migraciones/003_referidos_y_lanzamiento.sql). Para cambiar una regla (por ejemplo, incluir otro estado) se redefine en una migración nueva.

---

## Puesta en marcha

### 1. Variables de entorno

```bash
cp .env.example .env.local
```

Genera los secretos con `openssl rand -hex 32`. Deja `GHL_DRY_RUN=true` hasta terminar las pruebas.

### 2. Migraciones

```bash
npm run db:migrar
```

Crea el esquema `recordatorios` y la vista sobre `public.cartera_*`, activa *APRENDE INGLÉS CON SPEAK EASY G2* y lo asocia a *Lanzamiento Octubre 2026*. Es idempotente.

Usuario de BD recomendado, con privilegio mínimo:

```sql
CREATE ROLE recordatorios_app LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA public TO recordatorios_app;
GRANT SELECT ON public.cartera_productos, public.cartera_compras, public.cartera_compras_pagos,
                public.cartera_estados, public.cartera_metodos_pago, public.cartera_descuentos,
                public.lanzamientos, public.enlaces_lanzamiento TO recordatorios_app;
GRANT CREATE ON DATABASE tu_bd TO recordatorios_app;   -- para crear el esquema
```

### 3. Links de pago

Los links salen de **inventario-speakeasy → Lanzamientos → (el lanzamiento) → Enlaces de ventas**:

- **Pasarela**: por el dominio del link (`pay.hotmart.com` / `buy.stripe.com`). La sección en la que esté no importa.
- **Plan**: por el número en el nombre: `4 CUOTAS`.
- **Referido**: si el nombre dice *REFERIDO*: `DESCUENTO REFERIDO 4 CUOTAS`.
- Se ignoran `CONTADO` y los enlaces de la sección general.

Para que entren los planes de 5 y 6 cuotas, basta con agregarlos ahí con ese mismo formato de nombre (`5 CUOTAS`, `DESCUENTO REFERIDO 6 CUOTAS`…).

En el dashboard, **Productos y links de pago** muestra los 20 links (Hotmart, Hotmart referido, Stripe, Stripe referido × 2–6 cuotas) con el lanzamiento asociado. Cada celda acepta un link manual que reemplaza al del lanzamiento; vacía, usa el del lanzamiento. En rojo quedan las que no tienen ninguno, y el aviso *Planes sin link de pago* dice a cuántos estudiantes afectan. Cuando llegue una nueva generación, actívala ahí y elige su lanzamiento.

### 4. GHL

#### a) Mensajes de WhatsApp

Solo hay **4 plantillas** (*Utility*, aprobadas por Meta). Abren la conversación y llevan dos botones de respuesta rápida: **Realizar pago** · **Soporte**.

| Etapa | Plantilla |
|---|---|
| D-3 | `utl_cuota_vencimiento_3dias` |
| D-1 | `utl_cuota_vencimiento_1dia` |
| D0 | `utl_cuota_vencimiento_hoy` |
| D+1 | `utl_cuota_vencida_ayer` |

Variable `{{1}}` = `{{inboundWebhookRequest.primer_nombre}}` (ej. "María", ya con mayúscula inicial).

Al tocar un botón, el estudiante le escribe a la cuenta y se abre la **ventana de 24 h** de WhatsApp. Todo lo demás son **mensajes normales**: la acción *WhatsApp Interactive Message* de GHL, sin plantilla ni aprobación de Meta, y según GHL sin costo dentro de la ventana.

| Mensaje | Dónde | Contenido | Botón |
|---|---|---|---|
| **Pago** | Rama *Realizar pago* | Excelente!! Para realizar el pago de tu cuota, sólo haz clic en el siguiente botón 👇🏻 | CTA URL **Pagar ahora** → `{{inboundWebhookRequest.link_pago}}` |
| **Soporte** | Rama *Soporte* (en los 5 workflows) | ¡Claro que sí! Nuestro equipo está listo para ayudarte con tu pago y acompañarte en lo que necesites 📲<br><br>Haz clic en el botón de abajo para hablar directamente con nuestro equipo de soporte 👇🏻 | CTA URL **Hablar con soporte** → `{{inboundWebhookRequest.link_soporte}}` |
| **Seguimiento** | Workflow SEG (3 h después del clic) | Hola {{inboundWebhookRequest.primer_nombre}}, te saludamos de Speak Easy. Queremos verificar el estado de tu trámite para asegurarnos de que pudiste realizar el pago de tu cuota sin ningún problema. Por favor selecciona una de las opciones a continuación para actualizar tu reporte en el sistema. | Respuesta rápida **Pago realizado** · **Soporte** |
| **Felicitación** | Rama *Pago realizado* | Felicidades por tu pago🥳!! Gracias por seguir siendo parte del programa Aprende Inglés con Speak Easy 🩷 | — |

- Los botones admiten hasta 20 caracteres, y cada mensaje lleva un solo botón de URL.
- El link de soporte se configura en el dashboard (**Etapas y workflows de GHL → Link del chat de soporte**) y llega a todos los workflows. Así se cambia en un solo lugar.
- **La hora del clic en *Pagar ahora* programa el seguimiento.** Como el seguimiento es un mensaje normal, debe salir con la ventana abierta. Si la ventana cerraría antes de las 3 h, el sistema lo adelanta para que salga una hora antes del cierre. Si ya está cerrada, no lo envía y lo deja como *omitido* con el motivo.

#### b) Datos que recibe cada workflow

| Campo | Ejemplo | Uso |
|---|---|---|
| `primer_nombre` | `María` | `{{1}}` de la plantilla |
| `link_pago` | `https://APP_URL/p/3a7d…` | URL del botón *Pagar ahora* (link rastreado) |
| `link_soporte` | `https://wa.me/57…` | URL del botón *Hablar con soporte* |
| `token` | `3a7d…` | Dato que devuelven los webhooks de respuesta (ver (e)) |
| `email` | `maria@correo.com` | Buscar el contacto (*Find Contact* por correo) |
| `telefono` | `+13055551001` o vacío | Solo referencia: el WhatsApp sale al teléfono del contacto en GHL |
| `nombre`, `concepto`, `cuota`, `total_cuotas`, `fecha_limite`, `metodo_pago`, `pasarela`, `producto`, `etapa`, `plantilla`, `envio_id` | `Cuota 2 de 4`, `20 de noviembre`… | Opcionales |

`link_pago` y `token` llevan a la misma página, que registra el clic, programa el seguimiento y redirige al link de Hotmart/Stripe que corresponda.

#### c) ¿Un workflow o cinco?

El sistema funciona igual con los dos esquemas: en el panel **Etapas** cada etapa tiene su URL, y si usas un solo workflow pegas la misma URL en las cinco. Lo que cambia es cómo se comporta GHL.

| | **1 workflow** | **5 workflows** (recomendado) |
|---|---|---|
| Elegir la plantilla | Condición *If/Else* sobre `{{inboundWebhookRequest.etapa}}` con 5 ramas (D-3, D-1, D0, D+1, SEG); cada rama tiene su acción de WhatsApp y sus botones | Cada workflow tiene su plantilla fija |
| Botones | Se repiten dentro de cada rama (las ramas no se vuelven a unir) | Se arma uno completo y se **duplica** cambiando la plantilla; el de SEG cambia los botones |
| Contacto que todavía está dentro | GHL **ignora** el disparo nuevo si el contacto sigue activo en el workflow, aunque esté permitida la re-entrada (por ejemplo, esperando respuesta o atendido en *Soporte*). Ese mensaje no sale y el sistema lo marca *fallido* a las 2 h. | Solo choca dentro de la misma etapa: el seguimiento o el D-1 entran aunque el D-3 siga esperando |
| Cambios | Tocar una rama puede romper las demás | Aislados por etapa |
| Estadísticas en GHL | Mezcladas | Por etapa |
| Costo | Igual: una ejecución por mensaje | Igual |

Con cualquiera de los dos, el paso **Esperar respuesta** debe vencer antes del siguiente envío; **20 h** es un buen valor. Así un toque en "Realizar pago" no lo atienden dos ejecuciones a la vez, y el contacto ya salió cuando llega el mensaje del día siguiente. Las plantillas comparten botones, y WhatsApp no distingue a cuál de ellas respondió.

#### d) Workflows de recordatorio (D-3, D-1, D0, D+1)

1. **Disparador *Inbound Webhook***. Copia su URL en el panel **Etapas y workflows de GHL**. Para que GHL conozca los campos, mándale el ejemplo de [integraciones/ghl-ejemplo-webhook.json](integraciones/ghl-ejemplo-webhook.json) y elige esa solicitud en *Mapping reference*. Con el workflow sin publicar, GHL solo lee el ejemplo y no envía nada:
   ```powershell
   Invoke-RestMethod -Method Post -Uri "URL_DEL_WEBHOOK" -ContentType "application/json; charset=utf-8" -InFile "integraciones\ghl-ejemplo-webhook.json"
   ```
2. **Buscar el contacto** (*Find Contact*) por **correo** = `{{inboundWebhookRequest.email}}`. No se crean contactos:
   - *Encontrado* → sigue al paso 3.
   - *No encontrado* → **Webhook** con `respuesta` = `contacto_no_encontrado` (ver (e)) → fin. El envío queda *fallido* en la alerta **Sin contacto en GHL**: crea el contacto en GHL (o corrige el correo en cartera) y reenvía desde el dashboard.
3. **WhatsApp** con la plantilla de la etapa y `{{1}}` = `primer_nombre`.
4. **Esperar respuesta** (máx. 20 h) y ramificar por el botón. Si la acción de la plantilla ya muestra una rama por botón y una de *Timeout*, úsalas. Si no, agrega **Wait → Contact Reply** (20 h) y un **If/Else** sobre el texto de la respuesta ("Realizar pago" / "Soporte").
   - *Realizar pago* → **Webhook** `realizar_pago` (ver (e)) → mensaje **Pago** (ver (a)).
   - *Soporte* → **Webhook** `soporte` → mensaje **Soporte**.
   - Sin respuesta → fin.
5. Los mensajes **Pago** y **Soporte** son *WhatsApp Interactive Message* de tipo **Visit Website Button**. Esa acción espera el clic y luego sale por *Link Opened*, *Not Delivered* o *Timeout*. Pon el *Timeout* en el mínimo (5 minutos) y deja las tres ramas en fin: el clic lo registra el sistema, no GHL.
6. **Settings → Allow re-entry: activado** (el mismo estudiante entra cada mes). Publicar.

Arma D-3 completo y **duplícalo** para D-1, D0 y D+1. En cada copia cambia la plantilla, y abre el disparador: la copia tiene **otra URL**, que es la que va en esa etapa del panel. Vuelve a mandarle el ejemplo.

#### e) Workflow de seguimiento (SEG) y webhooks de respuesta

Workflow SEG:

1. Disparador *Inbound Webhook*; su URL va en la etapa SEG del panel.
2. Buscar el contacto por correo, igual que en (d): si no aparece, **Webhook** `contacto_no_encontrado` → fin.
3. *WhatsApp: Customer Service Window Check*. Si la ventana está cerrada → fin.
4. Mensaje **Seguimiento** (ver (a)): *WhatsApp Interactive Message* de tipo **Quick Reply Buttons**, con los botones **Pago realizado** y **Soporte** y *Timeout* de 20 h. Cada botón sale por su rama:
   - *Pago realizado* → **Webhook** `pago_realizado` → mensaje **Felicitación** (acción *WhatsApp* con texto normal, sin plantilla: la ventana está abierta).
   - *Soporte* → **Webhook** `soporte` → mensaje **Soporte**.
   - *Timeout* → fin.

**Webhooks de respuesta.** Son la acción *Webhook* de GHL, en todas las ramas de botón de los 5 workflows y en la rama *No encontrado* de *Find Contact*:

- URL: `POST https://APP_URL/api/webhooks/ghl?secret=GHL_WEBHOOK_SECRET`
- Datos personalizados: `token` = `{{inboundWebhookRequest.token}}` y `respuesta` =

  | Rama | `respuesta` |
  |---|---|
  | Botón *Realizar pago* | `realizar_pago` |
  | Botón *Soporte* | `soporte` |
  | Botón *Pago realizado* | `pago_realizado` |
  | *Find Contact* → no encontrado | `contacto_no_encontrado` |

Con ellos el sistema sabe quién tocó cada botón y cuándo se abrió la ventana de 24 h, y arma el panel **Requieren atención**. "Pago realizado" además detiene los recordatorios restantes de esa cuota.

Si el estudiante pagó por Hotmart o Stripe con el mismo correo, el webhook de cartera del inventario ya registró el pago y el seguimiento **no sale**: antes de enviarlo se relee cartera. La pregunta "¿pudiste pagar?" llega solo a quien hizo clic y aún no aparece como pagado.

> **Antes de producción**, prueba cada workflow con tu número:
> 1. Toca *Realizar pago* y confirma que el botón *Pagar ahora* abre tu link. Así verificas que GHL conserva `{{inboundWebhookRequest.link_pago}}` después de *Esperar respuesta*.
> 2. En el dashboard revisa el clic y el seguimiento programado.
> 3. Responde *Pago realizado* y confirma que aparece en la bitácora del envío.
>
> *Inbound Webhook* es un disparador *premium* de GHL. Según el plan de la agencia, puede cobrarse por ejecución.

#### f) Token de solo lectura (recomendado)

El envío no usa token. El token sirve solo para que el sistema **lea** en GHL si el WhatsApp se entregó, se leyó o falló, y por qué. Sin él, los envíos se quedan en *enviado*.

1. En la **subcuenta** de Speak Easy (no en la agencia): **Settings → Private Integrations → Create new Integration**.
2. Nombre: `Recordatorios de cuotas (solo lectura)`.
3. Permisos: solo estos tres (el buscador acepta el nombre o el código):

   | Permiso | Código | Para qué |
   |---|---|---|
   | View Contacts | `contacts.readonly` | Encontrar al estudiante por correo |
   | View Conversations | `conversations.readonly` | Encontrar su conversación de WhatsApp |
   | View Conversation Messages | `conversations/message.readonly` | Leer el estado del mensaje (entregado, leído, fallido) y el error |

   Ningún permiso de edición: el sistema no escribe nada en GHL.
4. Crear y **copiar el token en ese momento**: GHL lo muestra una sola vez. Va en `GHL_TOKEN`.
5. `GHL_LOCATION_ID`: es el ID que aparece en la URL de la subcuenta (`…/v2/location/<ID>/…`).

Aunque sea de solo lectura, el token da acceso a contactos y conversaciones: trátalo como una contraseña. Si se expone, revócalo y crea otro desde la misma pantalla.

### 5. Google Sheets con n8n (opcional)

El sistema no se conecta a Google: envía las filas a un **webhook de n8n**, y n8n las escribe en la hoja con tu cuenta de Google.

1. **La hoja**: crea una hoja de cálculo con 5 pestañas llamadas exactamente **Cuota 2**, **Cuota 3**, **Cuota 4**, **Cuota 5** y **Cuota 6**. En la celda A1 de cada una, pega los encabezados: abre [integraciones/encabezados-sheets.tsv](integraciones/encabezados-sheets.tsv) en VS Code, Ctrl+A, Ctrl+C y pega en A1; quedan repartidos en columnas.
2. **El workflow**: en n8n, *Workflows → Import from File* → [integraciones/n8n-google-sheets.json](integraciones/n8n-google-sheets.json). Trae 3 nodos: *Webhook → Separar filas → Google Sheets*.
3. **Nodo Google Sheets**, en este orden (al cambiar el documento, n8n vacía los campos de abajo):
   - *Credential*: **Sign in with Google** con la cuenta dueña de la hoja.
   - *Document*: elige la hoja en la lista o pega su URL.
   - *Sheet*: cambia *From list* por **By Name**, pasa a **Expression** y pega `{{ $('Webhook').first().json.body.pestana }}`. Así cada lote va a su pestaña (Cuota 2, Cuota 3…).
   - *Mapping Column Mode*: **Map Automatically**. *Column to match on*: **ID**. Si esa lista sale vacía es porque n8n aún no sabe qué pestaña es: envía primero la fila de prueba del paso 4.
   - *Options → Add option → Cell Format*: **Let n8n format** (guarda los teléfonos con su `+` y las fechas tal cual).
4. **Fila de prueba**: en el nodo Webhook, **Listen for test event**, y desde PowerShell envía una fila a la *Test URL*:
   ```powershell
   $prueba = '{"pestana":"Cuota 2","filas":[{"ID":"prueba","Nombre":"Fila de prueba"}]}'
   Invoke-RestMethod -Method Post -Uri "PEGA_AQUI_LA_TEST_URL" -ContentType "application/json" -Body $prueba
   ```
   Con eso la expresión de *Sheet* ya resuelve "Cuota 2" y *Column to match on* muestra los encabezados. Elige **ID**, dale **Execute step** y revisa que la fila llegue a la pestaña Cuota 2. Luego bórrala de la hoja.
5. **Activa** el workflow (*Publish* / *Active*) y copia la **Production URL** del nodo Webhook (no la de *Test*) en `SHEETS_WEBHOOK_URL`.
6. En el dashboard, **Sincronizar Sheets**.

Cada fila es un estudiante y una cuota: producto, fecha límite, correo, teléfono, método, descuento, el estado de cada mensaje, si tocó "Realizar pago", los clics, si pidió soporte, la última respuesta y si **reportó el pago**. Cuando algo cambia, n8n actualiza la fila por su **ID**, sin duplicarla. Si n8n o Google fallan, esas filas se reintentan en la siguiente ejecución.

- La URL del webhook lleva un código aleatorio: trátala como una contraseña, porque con ella cualquiera podría escribir en la hoja.
- No cambies los encabezados ni borres la columna **ID**. Sí puedes ordenar, filtrar y agregar columnas a la derecha.
- En n8n Cloud, *Sign in with Google* funciona directo. En un n8n instalado por ustedes, esa conexión con Google requiere configurar un cliente OAuth en Google Cloud.

### 6. Cron

El endpoint acepta `GET` o `POST` con `Authorization: Bearer $CRON_SECRET`.

- **Vercel**: [vercel.json](vercel.json) lo programa cada 15 minutos de 8:00 a 19:45 (hora de Bogotá). Define `CRON_SECRET` en el proyecto y Vercel enviará el header automáticamente. Si tu plan solo permite ejecuciones diarias, usa un programador externo.

  Para cambiar la frecuencia, reemplaza la línea `"schedule"` de [vercel.json](vercel.json) por una de estas (las horas `0,13-23` están en UTC y equivalen a 8:00–19:00 en Bogotá; no las cambies). `vercel.json` no admite comentarios: si le agregas uno, el deploy falla.

  | Frecuencia | Línea para pegar | Seguimiento sale tras el clic |
  |---|---|---|
  | Cada 15 minutos (actual) | `"schedule": "*/15 0,13-23 * * *"` | entre 3 h y 3 h 15 min |
  | Cada 30 minutos | `"schedule": "*/30 0,13-23 * * *"` | entre 3 h y 3 h 30 min |
  | Cada hora | `"schedule": "0 0,13-23 * * *"` | entre 3 h y 4 h |

  El cambio se aplica con el siguiente deploy (commit y push). Se confirma en Vercel → *Settings → Cron Jobs*.
- **VPS / externo** (crontab, cron-job.org, GitHub Actions):

  ```cron
  CRON_TZ=America/Bogota
  */15 8-19 * * * curl -fsS -m 310 -H "Authorization: Bearer $CRON_SECRET" https://APP_URL/api/cron/recordatorios > /dev/null
  ```

Respuestas: `200` correcto, `500` con detalle en `errores`, `409` si ya hay otra ejecución en curso.

### 7. Prueba antes de producción

1. Solo con `GHL_DRY_RUN=true` (con `false` enviaría de verdad a todos los estudiantes de esa fecha), simula el día 17: `curl -H "Authorization: Bearer $CRON_SECRET" "https://APP_URL/api/cron/recordatorios?fecha=2026-11-17"`. En el dashboard revisa a quién se planificó y qué falló: correos faltantes o links faltantes. La bitácora de cada envío muestra los datos que se habrían mandado a GHL.
2. Con `GHL_DRY_RUN=false`, prueba los workflows con tu número usando el `curl` del punto 4d.

---

## Dashboard

Protegido con HTTP Basic (`DASHBOARD_USUARIO` / `DASHBOARD_CLAVE`). Las server actions vuelven a validar la credencial, porque son alcanzables por POST directo.

- **KPIs del rango**: enviados, entregados, leídos, fallidos, omitidos, clics en el link (y cuántos tocaron "Realizar pago"), "Pago realizado" y cuotas que ya figuran pagadas en cartera.
- **Requieren atención**: tarjetas con la lista de estudiantes (nombre, teléfono, correo, cuota) que piden una acción del equipo:
  - **WhatsApp que fallaron**: falta el link, error de GHL o de WhatsApp (por ejemplo, el contacto no tiene un número con WhatsApp).
  - **Sin contacto en GHL**: GHL no encontró el correo del estudiante (o cartera no tiene correo), así que el WhatsApp no salió. Se crea el contacto en GHL o se corrige el correo, y se reenvía.
  - **Dijo «Pago realizado» y no figura en cartera**: verificar y registrar el pago.
  - **Pidió soporte**.
  - **Tocó «Realizar pago» y no abrió el link**.
  - **Abrió el link y no ha pagado**: más de 3 h después del clic.
  - **Venció sin pagar**: recibió recordatorios y la cuota sigue sin pago.
- **Tabla** con filtros por fecha, estado, etapa y búsqueda (nombre, teléfono, correo). **Reenviar** por fila y **Reenviar fallidos del filtro** (máx. 200 por acción).
- **Detalle** `/envios/:id`: datos, link rastreado, respuesta y bitácora completa (intentos, respuestas de GHL, estados de WhatsApp, clics).
- **Etapas**: URL del webhook de cada workflow, activar/pausar etapas (incluido el seguimiento) y link del chat de soporte.
- **Productos y links de pago**: activar generaciones y editar sus 10 links.
- **Ejecutar ciclo ahora** (ignora la ventana horaria) y **Sincronizar Sheets**.

### Estados

| Estado | Significado | ¿Reenviable? |
|---|---|---|
| pendiente | Planificado, en cola (el seguimiento espera su hora) | Sí (envía ya) |
| procesando | Tomado por una ejecución | No |
| enviado | Webhook del workflow disparado | Sí (con confirmación) |
| entregado / leído | Confirmado por WhatsApp vía GHL (o respondió un botón) | No |
| fallido | Error de datos, de GHL o de WhatsApp (`ultimo_error`) | Sí |
| omitido | Pagada, reportó el pago, ya no está en cartera o no salió a tiempo | Sí |

---

## Detalles implementados

- **Idempotencia**: la planificación usa `ON CONFLICT DO NOTHING` y el despacho reclama filas con `UPDATE … WHERE estado = 'pendiente'`, así que dos ejecuciones simultáneas no duplican mensajes. Un bloqueo por filas en `recordatorios.bloqueos` evita ciclos solapados y funciona detrás de PgBouncer, Supabase o Neon.
- **Contacto por correo**: el correo de cartera es obligatorio (sin él, el envío queda en *Sin contacto en GHL* sin llamar a GHL). El teléfono es opcional: si viene, se normaliza a E.164 según el país de la compra (`lib/telefonos.ts`) y se manda como referencia. Acepta "+1 305…", "1 (305) 555-1001", "573001234567", "3001234567" o "0987654321" (Ecuador)…
- **Mismo contacto**: dos mensajes al mismo correo se separan al menos `ESPERA_MISMO_CONTACTO_SEG`, para que la verificación asocie cada WhatsApp a su envío.
- **Sin envíos tardíos**: un recordatorio que no salió en su día pasa a *omitido* (un "faltan 3 días" no se envía después). Un seguimiento se omite si lleva más de un día vencido. Ambos se pueden reenviar a mano.
- **Interrumpidos**: un envío en *procesando* por más de 15 min pasa a *fallido* y no se reintenta solo, porque pudo llegar a GHL. Revísalo en GHL antes de reenviar.
- **Verificación**: se revisan los envíos de las últimas 72 h; el contacto se busca por correo, como en el workflow. Si a las 2 h no hay contacto (va a *Sin contacto en GHL*, aunque el workflow no haya avisado) o mensaje de WhatsApp en GHL, se marca *fallido* con indicaciones.
- **Clics**: las vistas previas de enlaces (WhatsApp, Facebook, bots) redirigen pero no cuentan como clic ni programan seguimiento. Si cambias un link en el dashboard, los mensajes ya enviados redirigen al nuevo.

## Seguridad

- Secretos solo en variables de entorno; comparación en tiempo constante (`timingSafeEqual`).
- Endpoints públicos mínimos: `/p/:token` (token aleatorio de 128 bits), cron (Bearer) y webhook de respuestas (secreto). Todo lo demás pasa por `proxy.ts`.
- Las URLs de los webhooks de GHL permiten disparar mensajes: se guardan en la BD y solo se ven en el dashboard.
- `robots: noindex`. Usuario de BD con `SELECT` sobre cartera; solo escribe en `recordatorios`.

## Operación y backups

- Incluye el esquema en los respaldos: `pg_dump -n recordatorios …`. La bitácora (`recordatorios.eventos`) crece con cada intento; si hace falta, depúrala por antigüedad (p. ej. > 12 meses).
- `recordatorios.ejecuciones` sirve de log de cada corrida, y su columna `error` es lo primero que hay que revisar.
- Cambios de esquema: agrega archivos `db/migraciones/00N_*.sql` y ejecuta `npm run db:migrar`.

## Estructura

```
app/
  page.tsx                      dashboard (KPIs, tabla, ejecuciones, etapas, productos y links)
  envios/[id]/page.tsx          detalle + bitácora
  acciones.ts                   server actions (reenviar, ciclo, Sheets, etapas, productos)
  api/cron/recordatorios/       ciclo completo (cron)
  api/webhooks/ghl/             respuestas a los botones (Pago realizado, Soporte…)
  p/[token]/                    link rastreado: clic + seguimiento + redirect al pago
lib/
  config.ts                     variables tipadas (zod), validadas por dominio
  db.ts                         pool pg + bloqueo con expiración
  ghl.ts                        webhook de workflows + lectura de contactos/conversaciones
  telefonos.ts                  normalización E.164 por país
  sheets.ts                     envío de filas al webhook de n8n (Google Sheets)
  recordatorios/
    planificador.ts             higiene + planificación
    despachador.ts              reclamo concurrente, revalidación y envío
    interacciones.ts            clics, seguimiento y respuestas
    verificador.ts              estado real de WhatsApp en GHL
    sincronizar-sheets.ts       pestañas por cuota en Google Sheets
    ciclo.ts                    orquestación de una ejecución
    consultas.ts                lecturas del dashboard
db/migraciones/
  001_esquema_recordatorios.sql esquema `recordatorios`
  002_vista_fuente.sql          vista sobre public.cartera_* (reglas de cobro)
  003_referidos_y_lanzamiento.sql  links del lanzamiento y de referido
  004_respuestas_y_ajustes.sql  botones respondidos y ajustes (link de soporte)
  005_sheets_via_n8n.sql        Sheets vía n8n
integraciones/
  n8n-google-sheets.json        workflow de n8n para importar
  encabezados-sheets.tsv        fila de encabezados de cada pestaña
  ghl-ejemplo-webhook.json      datos de ejemplo para el disparador Inbound Webhook de GHL
proxy.ts                        Basic Auth del dashboard
```
