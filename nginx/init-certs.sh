#!/bin/bash
# ============================================================
# Genera los certificados Let's Encrypt para todos los dominios.
# Ejecutar UNA VEZ antes de levantar docker compose.
#
# Uso:
#   ./init-certs.sh tardigram.com www.tardigram.com ejemplo2.com
#
# Requiere que el puerto 80 esté libre y el DNS ya apunte al VPS.
# ============================================================

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Uso: $0 dominio1 dominio2 ..."
  echo "Ejemplo: $0 tardigram.com www.tardigram.com"
  exit 1
fi

EMAIL="${CERTBOT_EMAIL:-}"
if [ -z "$EMAIL" ]; then
  read -rp "Email para Let's Encrypt: " EMAIL
fi

STAGING="${CERTBOT_STAGING:-}"
STAGING_FLAG=""
if [ "$STAGING" = "1" ]; then
  STAGING_FLAG="--staging"
  echo "MODO STAGING (certs de prueba)"
fi

# 1. Levantar nginx solo con HTTP para el challenge
echo "Levantando nginx temporal para ACME challenge..."
docker compose up -d nginx

# 2. Pedir certs para cada dominio
for DOMAIN in "$@"; do
  echo ""
  echo "=== Solicitando certificado para $DOMAIN ==="
  docker compose run --rm certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    $STAGING_FLAG \
    -d "$DOMAIN"
done

# 3. Recargar nginx con los certs
echo ""
echo "Recargando nginx con certificados..."
docker compose exec nginx nginx -s reload

echo ""
echo "Listo. Certificados generados en ./certbot/conf/live/"
echo "Ahora configura conf.d/domains.conf y ejecuta: docker compose up -d"
