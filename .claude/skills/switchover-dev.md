# Cloudflare Switchover Development Guidelines

Este skill contiene las pautas de desarrollo para el proyecto cloudflare-switchover.

## Arquitectura del Proyecto

- **Runtime**: Node.js 18+ (native fetch, single process)
- **HTTP**: Fastify 4 (health/status endpoints only)
- **Logging**: Pino (consistent with elpapeo stack)
- **Deploy**: K8s (ArgoCD via arenero repo) + Docker + GitHub Actions (GHCR)

### Modulos del Proyecto (`src/`)

- **`config.js`**: Carga y validacion de variables de entorno
- **`poller.js`**: Fetch de hayahora.futbol + evaluacion de estado futbol (majority vote)
- **`cloudflare.js`**: Cliente API de Cloudflare (listRecords, setProxied)
- **`notifier.js`**: Notificaciones via Telegram Bot API y Slack webhooks
- **`switcher.js`**: Orquestador principal: maquina de estados + switch DNS + verify + notify
- **`health.js`**: Plugin Fastify con rutas /healthz, /readyz, /status
- **`server.js`**: Entry point: wiring, poller loop, graceful shutdown

## Principios de Desarrollo

### 1. SIEMPRE Reutilizar Codigo Existente

**CRITICO**: Antes de crear nuevos archivos o funciones, SIEMPRE:

1. Busca codigo existente que ya implemente funcionalidad similar
2. Revisa los modulos en `src/` para reutilizar logica
3. Solo crea modulos nuevos si es absolutamente necesario

### 2. Mantener Simplicidad

- Este es un servicio pequeno y enfocado: monitorear futbol y switchear DNS
- No agregar funcionalidad que no este directamente relacionada
- Usar native fetch (Node 18+), no axios/node-fetch
- Sin ORM, sin base de datos - estado en memoria

### 3. Checklist Antes de Programar

- [ ] Ya existe codigo que haga algo similar?
- [ ] Puedo extender un modulo existente?
- [ ] Estoy siguiendo los patrones establecidos?
- [ ] El cambio es necesario para la funcionalidad core?

## LOGGING STANDARDS (OBLIGATORIO)

**CRITICO**: Seguir los mismos estandares de logging que elpapeo.

### Patron de Logging Estandarizado

```javascript
// CORRECTO: Formato estandar de Pino
log.level(contextObject, 'message_in_snake_case');

// Ejemplo:
log.info({
  domain: 'example.com',
  proxied: false
}, 'dns_proxy_disabled');
```

### Reglas de Logging

#### 1. Estructura del Log
- **Primer parametro**: Objeto con contexto (campos relevantes)
- **Segundo parametro**: Mensaje descriptivo en `snake_case`

#### 2. Campos de Contexto (camelCase)
```javascript
// CORRECTO
{
  domain: 'example.com',
  zoneId: 'abc123',
  recordId: 'def456',
  proxied: true,
  errorMessage: error.message
}
```

#### 3. Mensajes (snake_case)
```javascript
// CORRECTO
'poll_started'
'football_detected'
'dns_proxy_disabled'
'cloudflare_api_failed'
'health_check_passed'

// INCORRECTO
'Football Detected'
'footballDetected'
'Se detecto futbol'
```

#### 4. Niveles de Log

```javascript
// INFO - Eventos normales
log.info({ domain }, 'dns_proxy_restored');

// WARN - Situaciones inusuales pero manejables
log.warn({ lastUpdate }, 'hayahora_data_stale');

// ERROR - Errores que requieren atencion
log.error({ err: error, domain }, 'cloudflare_api_failed');
```

#### 5. Logging de Errores

Siempre incluir el objeto de error con la clave `err`:

```javascript
try {
  // codigo...
} catch (error) {
  log.error({
    err: error,
    domain: 'example.com'
  }, 'dns_switch_failed');
}
```

### Patrones de Naming

| Tipo | Patron | Ejemplo |
|------|--------|---------|
| Inicio | `{operation}_started` | `poll_started` |
| Exito | `{operation}_completed` | `dns_switch_completed` |
| Fallo | `{operation}_failed` | `cloudflare_api_failed` |
| Deteccion | `{thing}_detected` | `football_detected` |
| Restauracion | `{thing}_restored` | `dns_proxy_restored` |

## DRY (Don't Repeat Yourself)

- **DRY** es CRITICO en este proyecto
- No duplicar logica entre modulos
- Reutilizar el CloudflareClient para todas las operaciones CF
- Reutilizar el Notifier para todas las notificaciones
