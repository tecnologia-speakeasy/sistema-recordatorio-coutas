-- =============================================================================
-- Compras de prueba en cartera para el producto "Prueba Cuotas"
-- (76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265). Un caso por compra; el código P01…P18
-- va en el nombre y la explicación en "observaciones".
--
--   * Crea los estados, métodos de pago y el descuento REFERIDO del producto.
--   * Registra el producto en recordatorios (INACTIVO), con el mismo lanzamiento
--     de G2 y copia de sus links manuales (5 y 6 cuotas). Se activa desde el
--     dashboard cuando los correos estén listos.
--   * Correos @prueba.invalid: GHL no los encuentra. Los casos que deben recibir
--     WhatsApp (P01–P11) necesitan un correo real de GHL, uno distinto por caso.
--
-- Uso: npm run db:sql -- db/pruebas/compras-prueba.sql
-- Deshacer: npm run db:sql -- db/pruebas/limpiar-prueba.sql
-- =============================================================================

BEGIN;

DO $$
DECLARE
  p           constant uuid := '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265';
  g2          constant uuid := '79e47346-0188-4aa8-b706-818b68442866';
  autor       uuid;
  id_activo   uuid;
  id_cancelado uuid;
  id_referido uuid;
  metodos     jsonb := '{}';
  m           text;
  c           record;
  compra      uuid;
BEGIN
  SELECT creado_por_id INTO autor FROM public.cartera_productos WHERE id = p;
  IF autor IS NULL THEN
    RAISE EXCEPTION 'No existe el producto de prueba %', p;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cartera_compras WHERE producto_id = p) THEN
    RAISE EXCEPTION 'El producto de prueba ya tiene compras: corre primero db/pruebas/limpiar-prueba.sql';
  END IF;

  INSERT INTO public.cartera_estados (producto_id, nombre, orden) VALUES (p, 'ACTIVO', 0) RETURNING id INTO id_activo;
  INSERT INTO public.cartera_estados (producto_id, nombre, orden) VALUES (p, 'CANCELADO', 1) RETURNING id INTO id_cancelado;
  INSERT INTO public.cartera_descuentos (producto_id, nombre) VALUES (p, 'REFERIDO') RETURNING id INTO id_referido;
  FOREACH m IN ARRAY ARRAY['HOTMART', 'STRIPE', 'ZELLE', 'BANCOLOMBIA'] LOOP
    INSERT INTO public.cartera_metodos_pago (producto_id, nombre) VALUES (p, m) RETURNING jsonb_build_object(m, id) || metodos INTO metodos;
  END LOOP;

  -- primer_pago define el mes de la cuota 1: la cuota N vence el 20 del mes inicio + N - 1.
  FOR c IN SELECT * FROM (VALUES
    -- Reciben WhatsApp el 17, 19, 20 y 21 de noviembre (necesitan correo real de GHL)
    ('P01', 'Prueba P01 Hotmart 2 cuotas',  'cuotas.p01@prueba.invalid', '3000000001', 'HOTMART',     'CUOTAS',  2, 1, DATE '2026-10-05', false, true,  'Debe la cuota 2 de 2. Link: Hotmart 2 cuotas.'),
    ('P02', 'Prueba P02 Stripe 3 cuotas',   'cuotas.p02@prueba.invalid', '3000000002', 'STRIPE',      'CUOTAS',  3, 1, DATE '2026-10-05', false, true,  'Debe la cuota 2 de 3. Link: Stripe 3 cuotas.'),
    ('P03', 'Prueba P03 Zelle 4 cuotas',    'cuotas.p03@prueba.invalid', '3000000003', 'ZELLE',       'CUOTAS',  4, 1, DATE '2026-10-05', false, true,  'Pagó por Zelle: debe recibir el link de Hotmart 4 cuotas.'),
    ('P04', 'Prueba P04 Bancolombia 5 cuotas', 'cuotas.p04@prueba.invalid', '3000000004', 'BANCOLOMBIA', 'CUOTAS', 5, 1, DATE '2026-10-05', false, true,  'Pagó por Bancolombia: link Hotmart 5 cuotas (link manual del dashboard).'),
    ('P05', 'Prueba P05 Stripe 6 cuotas',   'cuotas.p05@prueba.invalid', '3000000005', 'STRIPE',      'CUOTAS',  6, 1, DATE '2026-10-05', false, true,  'Debe la cuota 2 de 6. Link: Stripe 6 cuotas (link manual).'),
    ('P06', 'Prueba P06 Hotmart referido 4', 'cuotas.p06@prueba.invalid', '3000000006', 'HOTMART',    'CUOTAS',  4, 1, DATE '2026-10-05', true,  true,  'Descuento REFERIDO: link Hotmart referido 4 cuotas.'),
    ('P07', 'Prueba P07 Stripe referido 4', 'cuotas.p07@prueba.invalid', '3000000007', 'STRIPE',      'CUOTAS',  4, 1, DATE '2026-10-05', true,  true,  'Descuento REFERIDO: link Stripe referido 4 cuotas.'),
    ('P08', 'Prueba P08 debe cuota 3 de 3', 'cuotas.p08@prueba.invalid', '3000000008', 'HOTMART',     'CUOTAS',  3, 2, DATE '2026-09-05', false, true,  'Empezó en septiembre y pagó 2: en noviembre debe la cuota 3 de 3.'),
    ('P09', 'Prueba P09 debe cuota 4 de 4', 'cuotas.p09@prueba.invalid', '3000000009', 'HOTMART',     'CUOTAS',  4, 3, DATE '2026-08-05', false, true,  'Empezó en agosto y pagó 3: en noviembre debe la cuota 4 de 4.'),
    ('P10', 'Prueba P10 atrasado',          'cuotas.p10@prueba.invalid', '3000000010', 'HOTMART',     'CUOTAS',  4, 1, DATE '2026-09-05', false, true,  'Empezó en septiembre y pagó 1: la cuota 2 venció el 20 de octubre; en noviembre recibe la cuota 3 de 4.'),
    ('P11', 'Prueba P11 sin teléfono',      'cuotas.p11@prueba.invalid', NULL,         'HOTMART',     'CUOTAS',  4, 1, DATE '2026-10-05', false, true,  'Sin teléfono en cartera: igual debe recibir (GHL usa el teléfono del contacto).'),
    -- No deben recibir nada en noviembre (el correo puede quedar falso)
    ('P12', 'Prueba P12 pagó completo',     'cuotas.p12@prueba.invalid', '3000000012', 'HOTMART',     'CUOTAS',  3, 3, DATE '2026-10-05', false, true,  'Pagó las 3 cuotas: no recibe nada.'),
    ('P13', 'Prueba P13 ya pagó noviembre', 'cuotas.p13@prueba.invalid', '3000000013', 'HOTMART',     'CUOTAS',  4, 2, DATE '2026-10-05', false, true,  'Ya pagó la cuota 2: nada en noviembre; en diciembre, cuota 3.'),
    ('P14', 'Prueba P14 contado',           'cuotas.p14@prueba.invalid', '3000000014', 'HOTMART',     'CONTADO', NULL, NULL, DATE '2026-10-05', false, true, 'Compra de contado: no recibe nada.'),
    ('P15', 'Prueba P15 cancelada',         'cuotas.p15@prueba.invalid', '3000000015', 'HOTMART',     'CUOTAS',  4, 1, DATE '2026-10-05', false, false, 'Estado CANCELADO: no recibe nada.'),
    -- Deben quedar como fallidos en el dashboard
    ('P16', 'Prueba P16 correo no está en GHL', 'cuotas.p16@prueba.invalid', '3000000016', 'HOTMART', 'CUOTAS', 4, 1, DATE '2026-10-05', false, true, 'Correo que no existe en GHL: alerta "Sin contacto en GHL". Dejar el correo falso.'),
    ('P17', 'Prueba P17 sin correo',        NULL,                        '3000000017', 'HOTMART',     'CUOTAS',  4, 1, DATE '2026-10-05', false, true,  'Sin correo en cartera: alerta "Sin contacto en GHL" sin llamar a GHL.'),
    ('P18', 'Prueba P18 referido 5 sin link', 'cuotas.p18@prueba.invalid', '3000000018', 'HOTMART',  'CUOTAS',  5, 1, DATE '2026-10-05', true,  true,  'Referido de 5 cuotas: no hay link, queda en "WhatsApp que fallaron".')
  ) AS v (codigo, nombre, correo, telefono, metodo, medio, cuotas, pagadas, primer_pago, es_referido, es_activo, nota)
  LOOP
    INSERT INTO public.cartera_compras
      (producto_id, estado_id, nombre_completo, correo, telefono, pais, metodo_pago_id, medio_pago,
       cantidad_cuotas, cuotas_pagadas, descuento_id, creado_por_id, created_at, observaciones)
    VALUES
      (p, CASE WHEN c.es_activo THEN id_activo ELSE id_cancelado END, c.nombre, c.correo, c.telefono, 'COLOMBIA',
       (metodos ->> c.metodo)::uuid, c.medio::medio_pago_cartera, c.cuotas, c.pagadas,
       CASE WHEN c.es_referido THEN id_referido END, autor, c.primer_pago, 'PRUEBA recordatorios ' || c.codigo || ': ' || c.nota)
    RETURNING id INTO compra;

    INSERT INTO public.cartera_compras_pagos (compra_id, metodo_pago_id, fecha_pago)
    SELECT compra, (metodos ->> c.metodo)::uuid, (c.primer_pago + make_interval(months => k))::date
    FROM generate_series(0, COALESCE(c.pagadas, 1) - 1) AS k;
  END LOOP;

  INSERT INTO recordatorios.productos (producto_id, nombre, activo, lanzamiento_id)
  SELECT p, 'Prueba Cuotas', false, lanzamiento_id FROM recordatorios.productos WHERE producto_id = g2
  ON CONFLICT (producto_id) DO NOTHING;

  INSERT INTO recordatorios.links_pago (producto_id, pasarela, cuotas, referido, url)
  SELECT p, pasarela, cuotas, referido, url FROM recordatorios.links_pago
  WHERE producto_id = g2 AND NULLIF(url, '') IS NOT NULL
  ON CONFLICT DO NOTHING;
END $$;

COMMIT;

SELECT left(nombre_completo, 34) AS compra, correo, medio_pago, cantidad_cuotas AS cuotas, cuotas_pagadas AS pagadas
FROM public.cartera_compras
WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265'
ORDER BY nombre_completo;
