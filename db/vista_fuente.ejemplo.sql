-- =============================================================================
-- ADAPTAR Y COPIAR A: db/migraciones/002_vista_fuente.sql
--
-- Contrato entre tu base de datos de negocio y el sistema de recordatorios.
-- El sistema SOLO lee esta vista. Debe devolver UNA fila por cuota con estas
-- columnas exactas (nombres y tipos):
--
--   cuota_id          text     identificador único y estable de la cuota
--   cliente_id        text     id del estudiante/cliente (informativo)
--   nombre            text     nombre a mostrar en el mensaje
--   telefono          text     celular; se normaliza a E.164 (+57...) al enviar
--   email             text     opcional
--   valor             numeric  valor de la cuota
--   concepto          text     ej. "Cuota 3/10 - Programa Intensivo"
--   fecha_vencimiento date     fecha límite de pago (en tu caso, el día 20)
--   pagada            boolean  true => no se envía / se omite
--   link_pago         text     URL de pago propia de ese usuario
--
-- Basta con que incluya cuotas no pagadas de los últimos ~2 meses y próximos;
-- filtrar aquí reduce el costo de la consulta del cron.
-- =============================================================================

-- Opción A: tu tabla de cuotas ya tiene fecha de vencimiento por cuota.
CREATE OR REPLACE VIEW recordatorios.v_cuotas_fuente AS
SELECT
  c.id::text                         AS cuota_id,
  e.id::text                         AS cliente_id,
  e.nombre_completo                  AS nombre,
  e.celular                          AS telefono,
  e.correo                           AS email,
  c.valor::numeric                   AS valor,
  c.descripcion                      AS concepto,
  c.fecha_vencimiento::date          AS fecha_vencimiento,
  (c.estado = 'PAGADA')              AS pagada,
  c.link_pago                        AS link_pago
FROM public.cuotas c
JOIN public.estudiantes e ON e.id = c.estudiante_id
WHERE c.fecha_vencimiento >= current_date - interval '60 days';

-- Opción B: no hay fecha por cuota; el pago es siempre el día 20 del mes.
-- (Descomentar y borrar la opción A.)
--
-- CREATE OR REPLACE VIEW recordatorios.v_cuotas_fuente AS
-- SELECT
--   c.id::text || '-' || to_char(c.periodo, 'YYYY-MM')         AS cuota_id,
--   e.id::text                                                  AS cliente_id,
--   e.nombre_completo                                           AS nombre,
--   e.celular                                                   AS telefono,
--   e.correo                                                    AS email,
--   c.valor::numeric                                            AS valor,
--   'Cuota ' || to_char(c.periodo, 'MM/YYYY')                   AS concepto,
--   make_date(extract(year FROM c.periodo)::int,
--             extract(month FROM c.periodo)::int, 20)           AS fecha_vencimiento,
--   c.pagada                                                    AS pagada,
--   c.link_pago                                                 AS link_pago
-- FROM public.cuotas c
-- JOIN public.estudiantes e ON e.id = c.estudiante_id;
