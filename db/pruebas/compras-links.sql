-- =============================================================================
-- Prueba de LINKS DE PAGO con el producto "Prueba Cuotas"
-- (76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265).
--
-- L01-L13: una compra por cada combinación que tienen hoy los estudiantes de G2
--          (pasarela x número de cuotas x referido). Correos reales de GHL, uno
--          distinto por caso: les llega el WhatsApp y se abre "Pagar ahora".
-- L14-L16: links que existen pero ningún estudiante de G2 usa. Correo falso:
--          quedan en "Sin contacto en GHL", pero el envío muestra el link elegido.
-- L17:     referido de 5 cuotas, que no tiene link: "WhatsApp que fallaron".
--
-- Todas empezaron en octubre y pagaron la cuota 1: deben la cuota 2 (20 de noviembre).
-- El producto queda registrado en recordatorios INACTIVO, con el lanzamiento de G2
-- y copia de sus links manuales; se activa desde el dashboard.
--
-- Uso:     npm run db:sql -- db/pruebas/compras-links.sql
-- Ver:     npm run db:sql -- db/pruebas/ver-prueba.sql
-- Deshacer: npm run db:sql -- db/pruebas/limpiar-prueba.sql
-- =============================================================================

BEGIN;

DO $$
DECLARE
  p            constant uuid := '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265';
  g2           constant uuid := '79e47346-0188-4aa8-b706-818b68442866';
  autor        uuid;
  id_activo    uuid;
  id_referido  uuid;
  metodos      jsonb := '{}';
  m            text;
  c            record;
  compra       uuid;
BEGIN
  SELECT creado_por_id INTO autor FROM public.cartera_productos WHERE id = p;
  IF autor IS NULL THEN
    RAISE EXCEPTION 'No existe el producto de prueba %', p;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cartera_compras WHERE producto_id = p) THEN
    RAISE EXCEPTION 'El producto de prueba ya tiene compras: corre primero db/pruebas/limpiar-prueba.sql';
  END IF;

  INSERT INTO public.cartera_estados (producto_id, nombre, orden) VALUES (p, 'ACTIVO', 0) RETURNING id INTO id_activo;
  INSERT INTO public.cartera_descuentos (producto_id, nombre) VALUES (p, 'REFERIDO') RETURNING id INTO id_referido;
  FOREACH m IN ARRAY ARRAY['HOTMART', 'STRIPE', 'ZELLE', 'BANCOLOMBIA', 'NEQUI'] LOOP
    INSERT INTO public.cartera_metodos_pago (producto_id, nombre) VALUES (p, m) RETURNING jsonb_build_object(m, id) || metodos INTO metodos;
  END LOOP;

  FOR c IN SELECT * FROM (VALUES
    -- Reciben WhatsApp (combinaciones reales de G2; entre paréntesis, cuántas compras de G2 la tienen)
    ('L01', 'Prueba L01 Hotmart 2 cuotas',          'prueba01@gmail.com',      'HOTMART',     2, false, 'Hotmart · 2 cuotas (30 en G2)'),
    ('L02', 'Prueba L02 Zelle 3 cuotas',            'prueba02@gmail.com',      'ZELLE',       3, false, 'Hotmart · 3 cuotas: pagó por Zelle (17 en G2)'),
    ('L03', 'Prueba L03 Hotmart 4 cuotas',          'prueba03@gmail.com',      'HOTMART',     4, false, 'Hotmart · 4 cuotas (474 en G2, el grupo principal)'),
    ('L04', 'Prueba L04 Bancolombia 5 cuotas',      'prueba04@gmail.com',      'BANCOLOMBIA', 5, false, 'Hotmart · 5 cuotas, link manual: pagó por Bancolombia (3 en G2)'),
    ('L05', 'Prueba L05 Nequi 6 cuotas',            'prueba05@gmail.com',      'NEQUI',       6, false, 'Hotmart · 6 cuotas, link manual: pagó por Nequi (7 en G2)'),
    ('L06', 'Prueba L06 Hotmart referido 2',        'prueba06@gmail.com',      'HOTMART',     2, true,  'Hotmart referido · 2 cuotas (1 en G2)'),
    ('L07', 'Prueba L07 Hotmart referido 3',        'prueba07@gmail.com',      'HOTMART',     3, true,  'Hotmart referido · 3 cuotas (2 en G2)'),
    ('L08', 'Prueba L08 Hotmart referido 4',        'prueba08@gmail.com',      'HOTMART',     4, true,  'Hotmart referido · 4 cuotas (14 en G2)'),
    ('L09', 'Prueba L09 Stripe 2 cuotas',           'prueba09@gmail.com',      'STRIPE',      2, false, 'Stripe · 2 cuotas (3 en G2)'),
    ('L10', 'Prueba L10 Stripe 3 cuotas',           'yeisonfa.2003@gmail.com', 'STRIPE',      3, false, 'Stripe · 3 cuotas (1 en G2)'),
    ('L11', 'Prueba L11 Stripe 4 cuotas',           'prueba11@gmail.com',      'STRIPE',      4, false, 'Stripe · 4 cuotas (90 en G2)'),
    ('L12', 'Prueba L12 Stripe 6 cuotas',           'prueba12@gmail.com',      'STRIPE',      6, false, 'Stripe · 6 cuotas, link manual (3 en G2)'),
    ('L13', 'Prueba L13 Stripe referido 4',         'prueba14@gmail.com',      'STRIPE',      4, true,  'Stripe referido · 4 cuotas (3 en G2)'),
    -- Solo dashboard: links que ningún estudiante de G2 usa (correo falso -> "Sin contacto en GHL")
    ('L14', 'Prueba L14 Stripe 5 cuotas',           'links.l14@prueba.invalid', 'STRIPE',     5, false, 'Stripe · 5 cuotas, link manual. Solo dashboard: correo falso'),
    ('L15', 'Prueba L15 Stripe referido 2',         'links.l15@prueba.invalid', 'STRIPE',     2, true,  'Stripe referido · 2 cuotas. Solo dashboard: correo falso'),
    ('L16', 'Prueba L16 Stripe referido 3',         'links.l16@prueba.invalid', 'STRIPE',     3, true,  'Stripe referido · 3 cuotas. Solo dashboard: correo falso'),
    -- Sin link: debe fallar antes de llamar a GHL
    ('L17', 'Prueba L17 Hotmart referido 5',        'links.l17@prueba.invalid', 'HOTMART',    5, true,  'No existe link de referido para 5 cuotas: "WhatsApp que fallaron"')
  ) AS v (codigo, nombre, correo, metodo, cuotas, es_referido, esperado)
  LOOP
    INSERT INTO public.cartera_compras
      (producto_id, estado_id, nombre_completo, correo, telefono, pais, metodo_pago_id, medio_pago,
       cantidad_cuotas, cuotas_pagadas, descuento_id, creado_por_id, created_at, observaciones)
    VALUES
      (p, id_activo, c.nombre, c.correo, '30000001' || right(c.codigo, 2), 'COLOMBIA',
       (metodos ->> c.metodo)::uuid, 'CUOTAS'::medio_pago_cartera, c.cuotas, 1,
       CASE WHEN c.es_referido THEN id_referido END, autor, DATE '2026-10-05',
       'PRUEBA links ' || c.codigo || '. Link esperado: ' || c.esperado)
    RETURNING id INTO compra;

    INSERT INTO public.cartera_compras_pagos (compra_id, metodo_pago_id, fecha_pago)
    VALUES (compra, (metodos ->> c.metodo)::uuid, DATE '2026-10-05');
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

SELECT left(c.nombre_completo, 32) AS compra, c.correo, m.nombre AS metodo, c.cantidad_cuotas AS cuotas,
       d.nombre AS descuento, substring(c.observaciones FROM 'Link esperado: (.*)$') AS link_esperado
FROM public.cartera_compras c
LEFT JOIN public.cartera_metodos_pago m ON m.id = c.metodo_pago_id
LEFT JOIN public.cartera_descuentos d ON d.id = c.descuento_id
WHERE c.producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265'
ORDER BY c.nombre_completo;
