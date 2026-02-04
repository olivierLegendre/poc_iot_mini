#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT/stack"

if [ ! -f .env ]; then
  echo "ERROR: .env missing. Copy .env.example to .env and set values."
  exit 1
fi

set -a
source ./.env
set +a

CERTDIR="$ROOT/stack/gateway-bridge/certs"
mkdir -p "$CERTDIR"
chmod 700 "$CERTDIR"

SAN="DNS:${LNS_HOST}"
if [[ "$LNS_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SAN="IP:${LNS_HOST}"
fi

cat > "$CERTDIR/openssl.cnf" <<EOF
[req]
distinguished_name=req_distinguished_name
x509_extensions=v3_req
prompt=no

[req_distinguished_name]
CN=${LNS_HOST}

[v3_req]
subjectAltName=${SAN}
EOF

openssl req -x509 -newkey rsa:2048 -days 3650 -nodes   -subj "/CN=poc-local-ca"   -keyout "$CERTDIR/ca.key" -out "$CERTDIR/ca.crt"

openssl req -new -newkey rsa:2048 -nodes   -keyout "$CERTDIR/server.key" -out "$CERTDIR/server.csr"   -config "$CERTDIR/openssl.cnf"

openssl x509 -req -in "$CERTDIR/server.csr" -CA "$CERTDIR/ca.crt" -CAkey "$CERTDIR/ca.key"   -CAcreateserial -out "$CERTDIR/server.crt" -days 825 -extensions v3_req -extfile "$CERTDIR/openssl.cnf"

chmod 600 "$CERTDIR/ca.key" "$CERTDIR/server.key"
echo "Generated TLS assets in $CERTDIR"
echo "Import CA cert to gateway trust store: $CERTDIR/ca.crt"
