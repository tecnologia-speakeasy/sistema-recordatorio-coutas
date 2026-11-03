-- =============================================================================
-- Links de pago con descuento de referido, y links tomados del módulo de
-- Lanzamientos (sección "Enlaces de ventas").
--
--   * Cada producto se asocia a su lanzamiento (G2 -> "Lanzamiento Octubre 2026").
--   * De sus enlaces de ventas se toman los de pago en cuotas:
--       pasarela = dominio del link (stripe.com / hotmart.com)
--       plan     = número en el nombre ("4 CUOTAS")
--       referido = el nombre dice "REFERIDO" ("DESCUENTO REFERIDO 4 CUOTAS")
--   * recordatorios.links_pago queda como ajuste manual: si tiene URL, manda.
--   * Compra con descuento cuyo nombre contiene "REFERIDO" -> link de referido.
-- =============================================================================

ALTER TABLE recordatorios.productos ADD COLUMN IF NOT EXISTS lanzamiento_id uuid;  -- public.lanzamientos.id

UPDATE recordatorios.productos
SET lanzamiento_id = (SELECT id FROM public.lanzamientos WHERE nombre = 'Lanzamiento Octubre 2026' LIMIT 1)
WHERE nombre = 'APRENDE INGLÉS CON SPEAK EASY G2' AND lanzamiento_id IS NULL;

ALTER TABLE recordatorios.links_pago ADD COLUMN IF NOT EXISTS referido boolean NOT NULL DEFAULT false;
ALTER TABLE recordatorios.links_pago DROP CONSTRAINT IF EXISTS links_pago_pkey;
ALTER TABLE recordatorios.links_pago ADD PRIMARY KEY (producto_id, pasarela, cuotas, referido);

ALTER TABLE recordatorios.envios ADD COLUMN IF NOT EXISTS referido boolean NOT NULL DEFAULT false;
ALTER TABLE recordatorios.envios ADD COLUMN IF NOT EXISTS descuento text;

CREATE OR REPLACE VIEW recordatorios.v_links_lanzamiento AS
SELECT DISTINCT ON (x.lanzamiento_id, x.pasarela, x.cuotas, x.referido)
  x.lanzamiento_id, x.pasarela, x.cuotas, x.referido, x.url, x.nombre
FROM (
  SELECT e.lanzamiento_id,
         CASE WHEN e.url ~* '^https?://([^/]+\.)?stripe\.com/' THEN 'stripe'
              WHEN e.url ~* '^https?://([^/]+\.)?hotmart\.com/' THEN 'hotmart' END AS pasarela,
         substring(upper(e.nombre) FROM '(\d+)\s*CUOTAS')::int                 AS cuotas,
         upper(e.nombre) LIKE '%REFERIDO%'                                      AS referido,
         e.url, e.nombre::text AS nombre, e.orden, e.created_at
  FROM public.enlaces_lanzamiento e
  WHERE e.tipo = 'VENTAS'
) x
WHERE x.pasarela IS NOT NULL AND x.cuotas BETWEEN 2 AND 12
ORDER BY x.lanzamiento_id, x.pasarela, x.cuotas, x.referido, x.orden, x.created_at;

-- Mismas columnas que en 002 (y en el mismo orden) + referido y descuento al final.
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
  COALESCE(NULLIF(l.url, ''), ll.url)                  AS link_pago,
  pa.referido,
  d.nombre::text                                       AS descuento
FROM public.cartera_compras c
JOIN recordatorios.productos rp ON rp.producto_id = c.producto_id AND rp.activo
JOIN public.cartera_productos p ON p.id = c.producto_id
LEFT JOIN public.cartera_estados est ON est.id = c.estado_id
LEFT JOIN public.cartera_metodos_pago m ON m.id = c.metodo_pago_id
LEFT JOIN public.cartera_descuentos d ON d.id = c.descuento_id
CROSS JOIN LATERAL (
  SELECT count(*)::int AS pagos, min(x.fecha_pago) AS primer_pago
  FROM public.cartera_compras_pagos x
  WHERE x.compra_id = c.id
) pg
CROSS JOIN LATERAL (
  SELECT CASE WHEN upper(m.nombre) = 'STRIPE' THEN 'stripe' ELSE 'hotmart' END AS pasarela,
         COALESCE(upper(d.nombre) LIKE '%REFERIDO%', false)                   AS referido
) pa
CROSS JOIN LATERAL generate_series(2, c.cantidad_cuotas) AS n (numero)
LEFT JOIN recordatorios.links_pago l
  ON l.producto_id = c.producto_id AND l.pasarela = pa.pasarela
 AND l.cuotas = c.cantidad_cuotas AND l.referido = pa.referido
LEFT JOIN recordatorios.v_links_lanzamiento ll
  ON ll.lanzamiento_id = rp.lanzamiento_id AND ll.pasarela = pa.pasarela
 AND ll.cuotas = c.cantidad_cuotas AND ll.referido = pa.referido
WHERE c.medio_pago = 'CUOTAS'
  AND c.cantidad_cuotas >= 2
  AND (est.id IS NULL OR upper(est.nombre) = 'ACTIVO');
