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
# Gateway Bridge container runs as nobody:nogroup; it must traverse and read mounted cert files.
chmod 755 "$CERTDIR"

SAN="DNS:${LNS_HOST}"
if [[ "$LNS_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  # Some clients incorrectly treat IP URLs as DNS hostnames during verification.
  # Include both SAN forms for compatibility.
  SAN="IP:${LNS_HOST},DNS:${LNS_HOST}"
fi

cat > "$CERTDIR/openssl.cnf" <<EOF
[req]
distinguished_name=req_distinguished_name
prompt=no

[req_distinguished_name]
CN=${LNS_HOST}

[v3_ca]
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always,issuer
basicConstraints=critical,CA:true,pathlen:0
keyUsage=critical,keyCertSign,cRLSign

[v3_server]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${SAN}
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF

if [ -f "$CERTDIR/ca.crt" ] && [ -f "$CERTDIR/ca.key" ]; then
  echo "Reusing existing CA: $CERTDIR/ca.crt"
else
  openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
    -subj "/CN=poc-local-ca" \
    -keyout "$CERTDIR/ca.key" -out "$CERTDIR/ca.crt" \
    -extensions v3_ca -config "$CERTDIR/openssl.cnf"
fi

openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$CERTDIR/server.key" -out "$CERTDIR/server.csr" \
  -config "$CERTDIR/openssl.cnf"

SERIAL_FILE="$CERTDIR/ca.srl"
if [ -f "$SERIAL_FILE" ]; then
  openssl x509 -req -in "$CERTDIR/server.csr" -CA "$CERTDIR/ca.crt" -CAkey "$CERTDIR/ca.key" \
    -CAserial "$SERIAL_FILE" -out "$CERTDIR/server.crt" -days 825 -extensions v3_server -extfile "$CERTDIR/openssl.cnf"
else
  openssl x509 -req -in "$CERTDIR/server.csr" -CA "$CERTDIR/ca.crt" -CAkey "$CERTDIR/ca.key" \
    -CAcreateserial -CAserial "$SERIAL_FILE" -out "$CERTDIR/server.crt" -days 825 -extensions v3_server -extfile "$CERTDIR/openssl.cnf"
fi

chmod 600 "$CERTDIR/ca.key"
chmod 644 "$CERTDIR/ca.crt" "$CERTDIR/server.crt" "$CERTDIR/server.key" "$CERTDIR/server.csr" "$CERTDIR/openssl.cnf"
echo "Generated TLS assets in $CERTDIR"
echo "Import CA cert to gateway trust store: $CERTDIR/ca.crt"
