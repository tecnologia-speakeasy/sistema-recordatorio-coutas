-- =============================================================================
-- Esquema `recordatorios`: estado propio del sistema de recordatorios de cuotas.
-- No modifica tablas de negocio; solo lee de ellas a través de la vista
-- recordatorios.v_cuotas_fuente (ver db/vista_fuente.ejemplo.sql).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS recordatorios;

-- ---------------------------------------------------------------------------
-- Etapas del recordatorio, relativas a la fecha de vencimiento de la cuota.
-- Cada etapa dispara un workflow de GHL (puede ser el mismo para todas si el
-- workflow ramifica por el campo personalizado de etapa).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.etapas (
  codigo          text PRIMARY KEY,
  nombre          text    NOT NULL,
  offset_dias     integer NOT NULL UNIQUE,
  ghl_workflow_id text,
  activa          boolean NOT NULL DEFAULT true,
  orden           integer NOT NULL
);

INSERT INTO recordatorios.etapas (codigo, nombre, offset_dias, orden) VALUES
  ('D-3', 'Faltan 3 días',   -3, 1),
  ('D-1', 'Falta 1 día',     -1, 2),
  ('D0',  'Día de pago',      0, 3),
  ('D+1', '1 día vencida',    1, 4)
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Estados de un envío.
--   pendiente   -> planificado, aún no se envía
--   procesando  -> tomado por una ejecución (bloqueo lógico)
--   enviado     -> contacto actualizado y workflow de GHL disparado
--   entregado / leido -> confirmado por GHL (estado del mensaje de WhatsApp)
--   fallido     -> error propio, de GHL o de WhatsApp (reenviable)
--   omitido     -> no se envió por regla de negocio (pagada, fuera de fecha...)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'estado_envio' AND n.nspname = 'recordatorios'
  ) THEN
    CREATE TYPE recordatorios.estado_envio AS ENUM (
      'pendiente', 'procesando', 'enviado', 'entregado', 'leido', 'fallido', 'omitido'
    );
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Un envío = una cuota x una etapa. La restricción única hace idempotente la
-- planificación: el cron puede ejecutarse varias veces al día sin duplicar.
-- Los datos del destinatario son una instantánea; se refrescan desde la
-- fuente en cada intento de envío.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.envios (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cuota_id               text NOT NULL,
  etapa                  text NOT NULL REFERENCES recordatorios.etapas (codigo),
  fecha_vencimiento      date NOT NULL,
  fecha_programada       date NOT NULL,

  cliente_id             text,
  nombre                 text,
  telefono               text,           -- tal como viene de la fuente
  telefono_e164          text,           -- normalizado y enviado a GHL
  email                  text,
  valor                  numeric(14, 2),
  concepto               text,
  link_pago              text,

  -- Sufijo de la URL dinámica del botón de la plantilla: https://<app>/p/<token>
  token                  text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),

  estado                 recordatorios.estado_envio NOT NULL DEFAULT 'pendiente',
  intentos               integer NOT NULL DEFAULT 0,
  ultimo_error           text,

  ghl_contact_id         text,
  ghl_conversation_id    text,
  ghl_message_id         text,

  procesando_desde       timestamptz,
  enviado_en             timestamptz,
  entregado_en           timestamptz,
  leido_en               timestamptz,
  confirmado_workflow_en timestamptz,

  clicks                 integer NOT NULL DEFAULT 0,
  primer_click_en        timestamptz,

  sheets_fila            integer,
  sheets_sincronizado_en timestamptz,

  creado_en              timestamptz NOT NULL DEFAULT now(),
  actualizado_en         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT envios_cuota_etapa_uk UNIQUE (cuota_id, fecha_vencimiento, etapa)
);

CREATE INDEX IF NOT EXISTS envios_estado_fecha_idx  ON recordatorios.envios (estado, fecha_programada);
CREATE INDEX IF NOT EXISTS envios_fecha_prog_idx    ON recordatorios.envios (fecha_programada DESC, id DESC);
CREATE INDEX IF NOT EXISTS envios_telefono_idx      ON recordatorios.envios (telefono);
CREATE INDEX IF NOT EXISTS envios_sheets_pend_idx   ON recordatorios.envios (actualizado_en)
  WHERE sheets_sincronizado_en IS NULL OR actualizado_en > sheets_sincronizado_en;

-- actualizado_en funciona como versión del registro para la sincronización con
-- Google Sheets; las escrituras de la propia sincronización no la cambian.
CREATE OR REPLACE FUNCTION recordatorios.tocar_actualizado_en() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sheets_sincronizado_en IS DISTINCT FROM OLD.sheets_sincronizado_en THEN
    RETURN NEW;
  END IF;
  NEW.actualizado_en := now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS envios_actualizado_en ON recordatorios.envios;
CREATE TRIGGER envios_actualizado_en
  BEFORE UPDATE ON recordatorios.envios
  FOR EACH ROW EXECUTE FUNCTION recordatorios.tocar_actualizado_en();

-- ---------------------------------------------------------------------------
-- Bitácora por envío: cada intento, respuesta de GHL, click, webhook, etc.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.eventos (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  envio_id   bigint REFERENCES recordatorios.envios (id) ON DELETE CASCADE,
  tipo       text NOT NULL,
  detalle    jsonb,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eventos_envio_idx ON recordatorios.eventos (envio_id, creado_en DESC);

-- ---------------------------------------------------------------------------
-- Registro de cada ejecución del ciclo (cron o manual).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.ejecuciones (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origen               text NOT NULL,
  fecha_referencia     date NOT NULL,
  iniciada_en          timestamptz NOT NULL DEFAULT now(),
  finalizada_en        timestamptz,
  planificados         integer NOT NULL DEFAULT 0,
  enviados             integer NOT NULL DEFAULT 0,
  fallidos             integer NOT NULL DEFAULT 0,
  omitidos             integer NOT NULL DEFAULT 0,
  verificados          integer NOT NULL DEFAULT 0,
  sincronizados_sheets integer NOT NULL DEFAULT 0,
  error                text
);

CREATE INDEX IF NOT EXISTS ejecuciones_iniciada_idx ON recordatorios.ejecuciones (iniciada_en DESC);

-- ---------------------------------------------------------------------------
-- Bloqueos con expiración (evita ejecuciones solapadas del ciclo y de la
-- sincronización con Sheets). Basado en filas para funcionar también detrás
-- de poolers en modo transacción (PgBouncer, Supabase, Neon).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.bloqueos (
  nombre        text PRIMARY KEY,
  tomado_hasta  timestamptz NOT NULL
);
