-- =============================================================================
-- Fuente de cuotas: compras en cuotas del módulo Administrativo · Cartera
-- (tablas public.cartera_*). El sistema SOLO lee esta vista.
--
-- Reglas:
--   * Solo compras con medio_pago = CUOTAS, de productos activos en
--     recordatorios.productos y en estado ACTIVO (o sin estado).
--   * La cuota 1 se paga al comprar: el mes de inicio es el del primer pago.
--   * La cuota N vence el día 20 del mes (inicio + N - 1). G2 empezó en
--     octubre: la cuota 2 vence el 20 de noviembre y la 3 el 20 de diciembre.
--   * La cuota N está pagada si cuotas_pagadas >= N. Así, quien tiene 2 de 3
--     pagadas no recibe nada en noviembre, pero sí en diciembre (debe la 3).
--   * Link: Stripe -> link de Stripe; cualquier otro método (Hotmart, Zelle,
--     Bancolombia, Nequi...) -> link de Hotmart. Del plan de cantidad_cuotas.
-- =============================================================================

INSERT INTO recordatorios.productos (producto_id, nombre)
SELECT id, nombre FROM public.cartera_productos
WHERE nombre = 'APRENDE INGLÉS CON SPEAK EASY G2'
ON CONFLICT (producto_id) DO NOTHING;

CREATE OR REPLACE VIEW recordatorios.v_cuotas_fuente AS
SELECT
  c.id::text || ':' || n.numero                        AS cuota_id,
  c.id                                                 AS compra_id,
  c.producto_id,
  p.nombre::text                                       AS producto,
  n.numero                                             AS cuota_numero,
  c.cantidad_cuotas                                    AS total_cuotas,
  'Cuota ' || n.numero || ' de ' || c.cantidad_cuotas  AS concepto,
  c.nombre_completo::text                              AS nombre,
  c.telefono::text                                     AS telefono,
  c.correo::text                                       AS email,
  c.pais::text                                         AS pais,
  m.nombre::text                                       AS metodo_pago,
  pa.pasarela,
  (date_trunc('month', COALESCE(pg.primer_pago, c.created_at::date)::timestamp)
     + make_interval(months => n.numero - 1))::date + 19 AS fecha_vencimiento,  -- día 20
  COALESCE(c.cuotas_pagadas, pg.pagos) >= n.numero     AS pagada,
  l.url                                                AS link_pago
FROM public.cartera_compras c
JOIN recordatorios.productos rp ON rp.producto_id = c.producto_id AND rp.activo
JOIN public.cartera_productos p ON p.id = c.producto_id
LEFT JOIN public.cartera_estados est ON est.id = c.estado_id
LEFT JOIN public.cartera_metodos_pago m ON m.id = c.metodo_pago_id
CROSS JOIN LATERAL (
  SELECT count(*)::int AS pagos, min(x.fecha_pago) AS primer_pago
  FROM public.cartera_compras_pagos x
  WHERE x.compra_id = c.id
) pg
CROSS JOIN LATERAL (
  SELECT CASE WHEN upper(m.nombre) = 'STRIPE' THEN 'stripe' ELSE 'hotmart' END AS pasarela
) pa
CROSS JOIN LATERAL generate_series(2, c.cantidad_cuotas) AS n (numero)
LEFT JOIN recordatorios.links_pago l
  ON l.producto_id = c.producto_id AND l.pasarela = pa.pasarela AND l.cuotas = c.cantidad_cuotas
WHERE c.medio_pago = 'CUOTAS'
  AND c.cantidad_cuotas >= 2
  AND (est.id IS NULL OR upper(est.nombre) = 'ACTIVO');
