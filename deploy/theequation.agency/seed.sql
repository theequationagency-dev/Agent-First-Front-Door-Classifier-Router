-- theequation.agency — the services an agent sees.
--
-- Every name and description is copied from that service page's own <title>
-- and meta description on theequation.agency (the "Agende una llamada…"
-- sentence dropped). No prices: the site publishes none, so price_cents is
-- NULL. When a page's wording changes, change the row here to match.
--
-- Apply with:
--   wrangler d1 execute theequation-agency-front-door --remote \
--     -c deploy/theequation.agency/wrangler.toml --file=deploy/theequation.agency/seed.sql
-- Safe to re-run: it replaces the rows rather than adding copies.

DELETE FROM services;

INSERT INTO services (name, description, url, price_cents, currency, active) VALUES
  ('Automatización de marketing por correo, SMS y WhatsApp', 'Automatización de marketing con secuencias de correo, SMS y WhatsApp conectadas a su CRM.', 'https://theequation.agency/servicios/automatizacion-de-marketing', NULL, NULL, 1),
  ('Chatbot para WhatsApp con IA y traspaso a su equipo', 'Creamos un chatbot para WhatsApp con IA que atiende, califica y agenda, con traspaso a una persona cuando hace falta.', 'https://theequation.agency/servicios/chatbots-whatsapp', NULL, NULL, 1),
  ('Implementación de CRM y automatización de ventas', 'Implementación de CRM a la medida de su proceso comercial: datos, integraciones y automatización de ventas.', 'https://theequation.agency/servicios/crm-automatizacion', NULL, NULL, 1),
  ('Desarrollo web a la medida: sitios, portales y apps', 'Desarrollo web a la medida para empresas: sitios, portales y aplicaciones integrados con su CRM, pagos locales y WhatsApp.', 'https://theequation.agency/servicios/desarrollo-web', NULL, NULL, 1),
  ('Diseño web profesional para empresas y agencias', 'Diseño web profesional para empresas, agencias y equipos de marketing: marca, UX/UI y estructura pensada para convertir.', 'https://theequation.agency/servicios/diseno-web', NULL, NULL, 1),
  ('Embudos de venta conectados a su CRM y a WhatsApp', 'Diseñamos embudos de venta y landing pages que convierten, conectados a su CRM y a WhatsApp.', 'https://theequation.agency/servicios/embudos-de-venta', NULL, NULL, 1),
  ('Inteligencia artificial para empresas: usos y límites', 'Inteligencia artificial para empresas con límites claros: asistentes, calificación de prospectos y flujos en su CRM.', 'https://theequation.agency/servicios/inteligencia-artificial', NULL, NULL, 1),
  ('Onboarding de clientes y SOPs para equipos y agencias', 'Diseñamos el onboarding de clientes y documentamos SOPs: qué hacer, quién responde y cuándo escalar.', 'https://theequation.agency/servicios/onboarding-y-sops', NULL, NULL, 1),
  ('Optimización de velocidad web y Core Web Vitals', 'Optimización de velocidad web para empresas: auditoría, corrección de Core Web Vitals y monitoreo en celulares reales.', 'https://theequation.agency/servicios/optimizacion-velocidad-web', NULL, NULL, 1),
  ('SEO local para negocios con una o varias sucursales', 'SEO local para negocios con una o varias sucursales: Perfil de Empresa en Google, reseñas y páginas por ciudad.', 'https://theequation.agency/servicios/seo-local', NULL, NULL, 1),
  ('SEO técnico: auditoría, rastreo e indexación para empresas', 'SEO técnico para empresas: auditoría de rastreo e indexación, arquitectura, datos estructurados y migraciones.', 'https://theequation.agency/servicios/seo-tecnico', NULL, NULL, 1),
  ('Servicios de SEO para empresas en Latinoamérica', 'Servicios de SEO para empresas en Latinoamérica: base técnica, contenido, SEO local y estrategia multipaís con medición.', 'https://theequation.agency/servicios/seo', NULL, NULL, 1),
  ('Desarrollo de sitios web para empresas, portales y tiendas', 'Desarrollo de sitios web para empresas: sitio corporativo, portales, aplicaciones a la medida y tiendas en línea.', 'https://theequation.agency/servicios/sitios-web', NULL, NULL, 1),
  ('Desarrollo de tiendas en línea con pagos locales', 'Desarrollo de tiendas en línea rápidas, con pagos locales, envíos, facturación y WhatsApp, pensadas para vender y escalar.', 'https://theequation.agency/servicios/tiendas-en-linea', NULL, NULL, 1);
