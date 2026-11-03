-- =============================================================================
-- Solo 4 plantillas utility (D-3, D-1, D0, D+1). Lo demás son mensajes
-- normales dentro de la ventana de 24 h que abre el botón "Realizar pago":
-- link de pago, soporte, seguimiento "¿pudiste pagar?" y felicitación.
--
--   * Se guarda cuándo tocó cada botón (para el dashboard y la ventana de 24 h).
--   * Ajustes generales editables desde el dashboard (link del chat de soporte).
-- =============================================================================

ALTER TABLE recordatorios.envios ADD COLUMN IF NOT EXISTS realizar_pago_en timestamptz;
ALTER TABLE recordatorios.envios ADD COLUMN IF NOT EXISTS soporte_en timestamptz;

CREATE TABLE IF NOT EXISTS recordatorios.ajustes (
  clave           text PRIMARY KEY,
  valor           text,
  actualizado_en  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO recordatorios.ajustes (clave) VALUES ('link_soporte') ON CONFLICT (clave) DO NOTHING;

-- El seguimiento ya no es plantilla: es un mensaje normal con botones de respuesta.
UPDATE recordatorios.etapas SET plantilla = NULL WHERE codigo = 'SEG';
