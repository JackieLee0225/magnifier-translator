#!/bin/bash
#
# setup-signing-keychain.sh —— 创建「永不上锁」的专用签名钥匙串
#
# 【为什么需要它】
# 之前把证书放在登录钥匙串里，而登录钥匙串一旦因锁屏/睡眠被锁，
# 自动化打包时的 codesign 就找不到证书（"item not found in keychain"），
# 导致主程序回退成 ad-hoc 签名，屏幕录制授权又会在每次重建后失效。
#
# 解决办法：单独建一个专用的签名钥匙串，设成「永不超时、不随睡眠上锁」，
# 证书放进去。codesign 通过钥匙串搜索列表找到它，彻底摆脱登录钥匙串的锁态。
#
# 【用法】
#   bash scripts/setup-signing-keychain.sh
# 之后打包 / 重签都会自动用它（脚本通过 MT_SIGN_KEYCHAIN 告知 adhoc-sign.js）。

set -euo pipefail

CERT_NAME="${MT_SIGN_IDENTITY:-Magnifier Translator Local Signing}"
KEYCHAIN_DIR="$HOME/Library/Keychains"
KEYCHAIN="$KEYCHAIN_DIR/magnifier-signing.keychain-db"
P12_PASS="${MT_SIGN_KEYCHAIN_PASS:-mtlocal}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> 专用签名钥匙串: $KEYCHAIN"

# 1) 创建（若已存在则跳过）
if [ ! -f "$KEYCHAIN" ]; then
  echo "==> 创建专用钥匙串…"
  security create-keychain -p "$P12_PASS" "$KEYCHAIN"
fi

# 先解锁，后续 import / trust / settings 都在解锁状态下进行，避免弹窗
security unlock-keychain -p "$P12_PASS" "$KEYCHAIN" >/dev/null 2>&1 || true

# -t 0：空闲不锁；不加 -u：睡眠也不锁（带密码，避免弹窗）
security set-keychain-settings -t 0 -p "$P12_PASS" "$KEYCHAIN" || true

# 2) 证书已在该钥匙串则跳过生成
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CERT_NAME"; then
  echo "==> 证书已存在，跳过生成"
else
  echo "==> 生成自签名证书…"
  cat > "$WORKDIR/cert.cnf" <<'CNF'
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = Magnifier Translator Local Signing
O = Local Development
[ ext ]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CNF
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" \
    -days 3650 -nodes -config "$WORKDIR/cert.cnf" >/dev/null 2>&1
  openssl pkcs12 -export \
    -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
    -out "$WORKDIR/cert.p12" -passout pass:"$P12_PASS" \
    -name "$CERT_NAME" >/dev/null 2>&1
  security import "$WORKDIR/cert.p12" \
    -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign -T /usr/bin/security
  security add-trusted-cert -r trustRoot -k "$KEYCHAIN" "$WORKDIR/cert.pem" || true
fi

# 3) 加入搜索列表（保留原有钥匙串）
EXISTING=$(security list-keychains -d user | sed 's/[" ]//g' | grep -v '^$')
if ! echo "$EXISTING" | grep -qx "$KEYCHAIN"; then
  # shellcheck disable=SC2086
  security list-keychains -d user -s $EXISTING "$KEYCHAIN"
fi

# 4) 解锁（确保立即可用）
security unlock-keychain -p "$P12_PASS" "$KEYCHAIN"

# 5) 校验
echo ""
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CERT_NAME"; then
  echo "✓ 专用签名钥匙串就绪："
  security find-identity -v -p codesigning 2>/dev/null | grep "$CERT_NAME"
  echo ""
  echo "下一步：npm run dist 重新打包，或让我直接对 /Applications 里的 app 重签。"
else
  echo "✗ 仍找不到证书，请检查上面的错误输出。"
  exit 1
fi
