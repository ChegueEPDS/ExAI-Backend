#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/.certs"

mkdir -p "${OUT_DIR}"

KEY="${OUT_DIR}/rot_signing.key"
CRT="${OUT_DIR}/rot_signing.crt"
P12="${OUT_DIR}/rot_signing.p12"

if [[ -f "${P12}" ]]; then
  echo "Already exists: ${P12}"
  echo "Delete it if you want to regenerate."
  exit 0
fi

echo "Generating RSA key..."
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${KEY}"

echo "Generating self-signed certificate (3 years)..."
openssl req -new -x509 -sha256 -days 1095 \
  -key "${KEY}" \
  -out "${CRT}" \
  -subj "/C=AE/O=Ind-Ex/CN=Ind-Ex ROT PDF Signing"

echo "Creating P12 (you will be prompted for an export password)..."
openssl pkcs12 -export \
  -inkey "${KEY}" \
  -in "${CRT}" \
  -out "${P12}" \
  -name "Ind-Ex ROT Signing"

echo
echo "Done:"
echo "  ${P12}"
echo
echo "Backend env to enable signing:"
echo "  ROT_PDF_SIGN_ENABLED=true"
echo "  ROT_PDF_SIGN_P12_PATH=${P12}"
echo "  ROT_PDF_SIGN_P12_PASSWORD=<the export password you entered>"

