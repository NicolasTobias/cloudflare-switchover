# cloudflare-switchover

Servicio Node.js que monitoriza el bloqueo de IPs de Cloudflare por parte de ISPs españoles durante los partidos de LaLiga y desactiva el proxy de Cloudflare en los dominios configurados mientras dura el bloqueo.

## El problema

Durante partidos de LaLiga, los ISPs españoles bloquean rangos de IPs de Cloudflare, dejando inaccesibles todos los sitios web que usan el proxy de Cloudflare. Este servicio detecta el bloqueo automáticamente y cambia los registros DNS para que resuelvan directamente a la IP de origen, sorteando el bloqueo.

## Funcionamiento

```
hayahora.futbol              Cloudflare API
      │                            │
      ▼ cada 5 min                 ▼
  fetchHayaHora()      ┌─ CNAME tunnel → A ip_directa  ← CF bloqueado (trace falla)
      │                │   (proxied=true → false)
  evaluateFootball()  ─┤
  (majority vote ISPs) │
                       └─ A ip_directa → CNAME tunnel  ← CF accesible (origin trace OK)
                              │    (proxied=false → true)
                         notify() → Telegram + Slack
```

### Máquina de estados

El servicio usa 4 estados para evitar switcheos prematuros:

```
  normal ──(futbol detectado)──→ watching ──(trace falla)──→ fallback
    ↑                              │                           │
    │                    (futbol termina)              (futbol termina)
    │                              │                           │
    │                              ▼                           ▼
    └────────────────────────── normal              restoring ─┘
                                                       │    ↑
                                              (origin OK)  (origin falla)
                                                       │    │
                                                       ▼    │
                                                    normal ──┘
```

- **normal**: DNS apunta a Cloudflare, sin fútbol
- **watching**: hayahora dice fútbol, verificando si CF está realmente bloqueado via `/cdn-cgi/trace`
- **fallback**: DNS apunta a VPS, CF bloqueado confirmado
- **restoring**: hayahora dice no-fútbol, verificando que CF esté accesible via `origin.*` antes de restaurar

### Flujo detallado

1. Cada 5 minutos se consulta `hayahora.futbol/estado/data.json`
2. Se evalúa el estado de cada ISP (DIGI, Movistar, Orange, Vodafone, Masmovil)
3. Si la proporción de ISPs con bloqueo activo supera el umbral → se entra en estado `watching`
4. En `watching`, se verifica `/cdn-cgi/trace` en cada dominio. Si el trace falla (CF bloqueado), se hace el switch DNS a fallback
5. Cuando hayahora dice no-fútbol, se entra en `restoring` y se verifica que `origin.{domain}` (que siempre pasa por CF) responda correctamente
6. Solo cuando el origin trace vuelve OK se restaura el DNS original
7. Se envían notificaciones por Telegram y/o Slack en cada cambio de estado, incluyendo resultado del trace y verificación de contenido HTML

## Requisitos

- Node.js 18+ (usa native fetch)
- Cuenta de Cloudflare con API token con permisos de edición DNS
- Dominios con registros DNS en Cloudflare

## Configuración

Copiar `.env.example` a `.env` y rellenar los valores:

```bash
cp .env.example .env
```

### Variables de entorno

| Variable | Requerida | Default | Descripción |
|----------|-----------|---------|-------------|
| `CLOUDFLARE_API_TOKEN` | Sí | — | Token de API de Cloudflare con permisos de edición DNS |
| `DOMAIN_RECORDS` | Sí | — | JSON array con los registros DNS a gestionar |
| `POLL_INTERVAL` | No | `300000` | Intervalo de polling en ms (5 min) |
| `HAYAHORA_URL` | No | `https://hayahora.futbol/estado/data.json` | URL del endpoint de estado |
| `HEALTH_CHECK_PORT` | No | `8080` | Puerto del servidor HTTP de health checks |
| `FOOTBALL_THRESHOLD` | No | `0.5` | Proporción mínima de ISPs con bloqueo para activar el switch |
| `TELEGRAM_BOT_TOKEN` | No | — | Token del bot de Telegram para notificaciones |
| `TELEGRAM_CHAT_ID` | No | — | Chat ID de Telegram donde enviar notificaciones |
| `TELEGRAM_THREAD_ID` | No | — | Thread ID para enviar al topic de un supergrupo |
| `SLACK_WEBHOOK_URL` | No | — | Webhook de Slack para notificaciones |
| `LOG_LEVEL` | No | `info` | Nivel de log de Pino (`debug`, `info`, `warn`, `error`) |
| `FORCE_FOOTBALL` | No | — | Override para testing: `true` fuerza estado futbol, `false` fuerza no-futbol. Omitir para comportamiento normal |

### Formato de DOMAIN_RECORDS

Array JSON con los registros DNS a gestionar. Cada entrada indica el dominio y a dónde debe apuntar durante el bloqueo:

```json
[
  {
    "zone_id": "abc123def456",
    "record_name": "tardigram.com",
    "fallback_type": "A",
    "fallback_content": "5.161.x.x",
    "health_check_string": "Tardigram"
  }
]
```

- `zone_id`: ID de la zona en Cloudflare
- `record_name`: nombre del registro DNS
- `fallback_type`: tipo de registro durante el bloqueo (normalmente `A`)
- `fallback_content`: IP directa del servidor de origen
- `health_check_string` (opcional): string a buscar en el HTML del dominio para verificar que el contenido es correcto tras un switch. Si no se especifica, solo se verifica el status HTTP

El servicio lee el registro actual de Cloudflare al arrancar (ej. `CNAME xxx.cfargotunnel.com`) y lo guarda. Cuando detecta bloqueo de CF, lo reemplaza por el fallback. Cuando el bloqueo cesa y se verifica que CF es accesible, restaura el original.

Ejemplo con Argo Tunnel:

| Estado | Tipo | Contenido | Proxied | Tráfico |
|--------|------|-----------|---------|---------|
| Normal | `CNAME` | `xxx.cfargotunnel.com` | `true` | Cliente → Cloudflare → Tunnel → Servidor |
| Fútbol | `A` | `5.161.x.x` | `false` | Cliente → Servidor directamente |

## Docker build

```bash
# Mac M4 / ARM64
docker build --platform linux/arm64 -t cloudflare-switchover .

# Intel / AMD64 (servidores, CI)
docker build --platform linux/amd64 -t cloudflare-switchover .
```

## Ejecución local (Docker Compose)

```bash
cp .env.example .env
# Editar .env con credenciales reales

docker compose up --build
```

Verificar que está funcionando:

```bash
curl localhost:8080/healthz   # → {"status":"ok"}
curl localhost:8080/readyz    # → {"status":"ready"}
curl localhost:8080/status    # → estado completo en JSON
```

## Tests

```bash
npm test
```

55 tests cubriendo:
- Lógica de evaluación de futbol (majority vote, umbral, staleness, deduplicación por ISP)
- Cliente de Cloudflare API (parsing de respuestas, headers de auth, reintentos)
- Máquina de estados del switcher (todas las transiciones: normal, watching, fallback, restoring)
- Verificación de salud con contenido HTML (`health_check_string`)
- Checker de `/cdn-cgi/trace` (parseo, errores, checks en paralelo)

## Endpoints HTTP

| Endpoint | Descripción |
|----------|-------------|
| `GET /` | Dashboard web con estado, controles y historial |
| `GET /healthz` | Liveness probe — siempre 200 si el proceso está vivo (logs silenciados) |
| `GET /readyz` | Readiness probe — 200 tras inicialización, 503 antes (logs silenciados) |
| `GET /status` | Estado completo en JSON |
| `GET /api/events` | Historial de eventos en JSON (últimos 200) |

### Dashboard

Accesible en `http://cambiador.level5.local/` (requiere Ingress en K8s) o `http://localhost:8080/` en local.

Incluye:
- Estado actual de la máquina de estados y registros DNS
- Botones Force ON / Force OFF / Auto para testing
- Tabla de historial de eventos (state changes, notificaciones, errores) con auto-refresh cada 30s

### Test endpoints

Para probar el flujo de switchover sin esperar a un partido de fútbol real:

```bash
# Activar fútbol forzado — cambia DNS a fallback (VPS) directamente
curl -X POST localhost:8080/test/force-football \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'

# Desactivar fútbol forzado — restaura DNS a Cloudflare directamente
curl -X POST localhost:8080/test/force-football \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'

# Limpiar override — volver a modo automático (hayahora)
curl -X DELETE localhost:8080/test/force-football
```

El force bypasea la máquina de estados: no verifica traces ni origin, cambia el DNS inmediatamente y envía notificación a Telegram/Slack. El override persiste entre polls hasta que se limpie con DELETE o se reinicie el servicio.

También se puede usar la variable de entorno `FORCE_FOOTBALL` al arrancar:

```bash
FORCE_FOOTBALL=true docker compose up --build
```

Ejemplo de respuesta de `/status`:

```json
{
  "state": "normal",
  "footballActive": false,
  "recordsCount": 1,
  "records": [
    {
      "name": "tardigram.com",
      "currentType": "CNAME",
      "currentContent": "xxx.cfargotunnel.com",
      "proxied": true,
      "originalType": "CNAME",
      "originalContent": "xxx.cfargotunnel.com"
    }
  ],
  "lastPoll": "2026-02-19T10:30:00.000Z",
  "lastPollError": null,
  "consecutiveErrors": 0,
  "uptime": 3600.5
}
```

## Detalles de diseño

**Máquina de estados**: El servicio ya no hace switcheos binarios. Cuando hayahora detecta fútbol, primero verifica que Cloudflare esté realmente bloqueado (`/cdn-cgi/trace`). Para restaurar, verifica que CF sea accesible via `origin.{domain}` antes de cambiar el DNS. Esto previene switcheos innecesarios y apagones durante la restauración.

**Verificación de contenido**: El health check después de un switch no solo verifica status HTTP 200, sino que busca un string esperado en el HTML (`health_check_string`). Esto detecta páginas de error o contenido incorrecto.

**Majority vote**: Se evalúa el último `stateChange` de cada ISP. Si la proporción de ISPs con `state: true` (bloqueado) es >= `FOOTBALL_THRESHOLD`, se activa el switch. Por defecto el umbral es 0.5 (mayoría simple).

**Staleness check**: Si `lastUpdate` del endpoint de hayahora tiene más de 30 minutos de antigüedad, se considera dato obsoleto y no se actúa (se retiene el estado anterior).

**Sin auto-restauración al apagar**: Si el servicio se reinicia mientras el futbol está activo, el DNS permanece apuntando a la IP directa. Esto evita que un pod restart durante el partido restaure el tunnel temporalmente (que estaría bloqueado). Al arrancar, el servicio detecta que el registro actual coincide con el fallback y asume estado de fútbol activo.

**1 réplica + Recreate**: Solo una instancia gestiona los DNS para evitar condiciones de carrera.

**Reintentos en Cloudflare API**: 3 intentos con backoff exponencial (2s, 4s, 8s) en caso de error.

**Notificaciones**: Se envían a Telegram y/o Slack en cada cambio de estado, incluyendo resultado del trace de CF, extracto HTML del origin, y health check de los dominios con verificación de contenido. Tras 3 errores de polling consecutivos se envía una alerta.

**Logs silenciados en health checks**: Las rutas `/healthz` y `/readyz` usan `logLevel: 'silent'` en Fastify para evitar ruido de los probes de K8s (cada 10s liveness, cada 30s readiness).

## Nginx reverse proxy (VPS)

El directorio `nginx/` contiene un reverse proxy listo para desplegar en un VPS. Es el servidor al que apuntan los registros DNS cuando el servicio activa el fallback.

nginx conecta al backend via HTTPS al subdominio `origin.*` de Cloudflare, que siempre apunta al Argo Tunnel. El tramo es HTTPS end-to-end sin necesidad de Cloudflare Origin Certificates en el VPS (nginx habla con el edge de CF que tiene cert público estándar).

```
Normal (sin fútbol):
  Cliente (ES) → Cloudflare → Argo Tunnel → Backend

Fútbol (bloqueo activo):
  Cliente (ES) → VPS nginx (DE) → origin.dominio.com (CF edge) → Argo Tunnel → Backend
                 ↑ Let's Encrypt    ↑ CF public SSL                ↑ tunnel cifrado
```

### Prerequisito en Cloudflare

Para cada dominio, crear un subdominio `origin` que apunte al tunnel y **nunca sea modificado** por el switchover service:

| Registro | Tipo | Contenido | Proxied | Modificado por switchover? |
|----------|------|-----------|---------|---------------------------|
| `tardigram.com` | CNAME | `xxx.cfargotunnel.com` | Si | Si (cambia a A record durante futbol) |
| `origin.tardigram.com` | CNAME | `xxx.cfargotunnel.com` | Si | **No (nunca se toca)** |

nginx usa `origin.tardigram.com` como upstream, que siempre resuelve a Cloudflare y pasa por el tunnel. El servicio también usa `origin.*` para verificar que CF es accesible antes de restaurar el DNS.

### Setup en el VPS

```bash
cd nginx

# 1. Configurar dominios
cp conf.d/domains.conf.example conf.d/domains.conf
# Editar domains.conf: ajustar server_name y subdominios origin

# 2. Obtener certificados SSL (requiere DNS apuntando al VPS)
CERTBOT_EMAIL=tu@email.com ./init-certs.sh tardigram.com www.tardigram.com

# 3. Levantar
docker compose up -d
```

### Agregar un dominio

Para cada dominio nuevo:

1. Crear `origin.dominio.com` en Cloudflare (CNAME al tunnel, proxied ON)
2. Agregar en `conf.d/domains.conf`:
   - Un `server` en puerto 80 para el ACME challenge + redirect a HTTPS
   - Un `server` en puerto 443 con `proxy_pass https://origin.dominio.com`

Ver el ejemplo comentado en `domains.conf.example`.

### Renovación de certificados

Automática. El contenedor `certbot` intenta renovar cada 12h y el contenedor `nginx` recarga la config cada 6h.

### Certs de prueba

Para probar sin gastar el rate limit de Let's Encrypt:

```bash
CERTBOT_EMAIL=tu@email.com CERTBOT_STAGING=1 ./init-certs.sh tardigram.com
```

## Despliegue en Kubernetes

### Via ArgoCD (recomendado)

```bash
kubectl apply -f argocd/application.yaml
```

Antes del primer sync, crear el namespace y el secret de GHCR:

```bash
kubectl create namespace cloudflare-switchover-prod

kubectl create secret docker-registry ghcr-login-secret \
  --docker-server=ghcr.io \
  --docker-username=<github-user> \
  --docker-password=<github-pat> \
  -n cloudflare-switchover-prod
```

El secreto con las credenciales (`cloudflare-switchover-secret`) se gestiona via `k8s/overlays/prod/secret.yaml` — actualizar los valores antes de hacer commit.

### CI/CD

El workflow `.github/workflows/build-deploy.yaml` se dispara en push a `main` con cambios en `src/**`, `package*.json`, `Dockerfile` o `k8s/**`:

1. Build y push de imagen a GHCR con tag `sha` + `latest`
2. Sync de `k8s/base/` y overlays (excepto `kustomization.yaml`) al repo `arenero`
3. Actualización del image tag en `arenero/cloudflare-switchover/k8s/overlays/prod/kustomization.yaml`
4. ArgoCD detecta el cambio y sincroniza automáticamente

## Estructura

```
cloudflare-switchover/
├── src/
│   ├── server.js       # Entry point: wiring, poller loop, graceful shutdown
│   ├── config.js       # Carga y validación de env vars
│   ├── poller.js       # Fetch hayahora + evaluateFootball (majority vote)
│   ├── cloudflare.js   # Cliente API Cloudflare (listRecords, updateRecord, reintentos)
│   ├── notifier.js     # Telegram Bot API + Slack webhook
│   ├── switcher.js     # Orquestador: máquina de estados + DNS switch + verify + notify
│   ├── trace.js        # Checker de Cloudflare /cdn-cgi/trace
│   ├── health.js       # Plugin Fastify: /healthz, /readyz, /status, /api/events, dashboard
│   └── dashboard.js    # HTML/CSS/JS inline para el dashboard web
├── test/
│   ├── poller.test.js
│   ├── cloudflare.test.js
│   ├── switcher.test.js
│   └── trace.test.js
├── k8s/
│   ├── base/           # Deployment + ConfigMap + Service + Ingress
│   └── overlays/prod/  # Namespace, secrets, imagePullSecrets, image tag
├── nginx/
│   ├── docker-compose.yaml   # nginx + certbot para el VPS
│   ├── nginx.conf            # Config principal de nginx
│   ├── conf.d/
│   │   └── domains.conf.example  # Ejemplo de server blocks por dominio
│   └── init-certs.sh         # Script para obtener certs de Let's Encrypt
├── argocd/
│   └── application.yaml
├── Dockerfile
└── docker-compose.yaml
```
