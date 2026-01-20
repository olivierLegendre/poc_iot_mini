#!/usr/bin/env bash
set -euo pipefail

sudo apt update
sudo apt install -y gettext-base openssl mosquitto-clients postgresql-client
echo "Installed: envsubst (gettext-base), openssl, mosquitto-clients, postgresql-client"
