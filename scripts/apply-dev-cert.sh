#!/bin/bash
# 用专用签名钥匙串，把固定自签名证书打到 app 上（全程无 GUI 弹窗）。
# 证书钥匙串由本脚本管理，密码硬编码在脚本里（本地开发用，无需用户知道）。
set -e

KC="$HOME/Library/Keychains/magnifier-signing.keychain-db"
PASS="mtlocal"
CERT_NAME="Magnifier Translator Local Signing"
WORKDIR="$HOME/Desktop/magnifier-translator/scripts/_cert_tmp"
# 要签名的 app（默认已安装的版本）
APP="${1:-/Applications/放大镜翻译器.app}"

mkdir -p "$WORKDIR"

# ---- 1) 证书钥匙串：已存在则复用，不存在才创建（保证 cert 稳定，权限不因重建而丢）----
NEED_CREATE=0
if [ ! -f "$KC" ]; then
  NEED_CREATE=1
elif ! security find-identity -v -p codesigning "$KC" 2>/dev/null | grep -q "$CERT_NAME"; then
  echo "==> 钥匙串存在但无证书，重建"
  rm -f "$KC"
  NEED_CREATE=1
fi

if [ "$NEED_CREATE" -eq 1 ]; then
  echo "==> 创建专用签名钥匙串（密码内置，无弹窗）"
  security create-keychain -p "$PASS" "$KC"
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
    -out "$WORKDIR/cert.p12" -passout pass:"$PASS" \
    -name "$CERT_NAME" >/dev/null 2>&1
  # -A：允许任意程序（含 codesign）使用私钥，不弹 ACL 授权框
  security import "$WORKDIR/cert.p12" \
    -k "$KC" -P "$PASS" -A -T /usr/bin/codesign
fi

# ---- 2) 加入搜索列表 + 解锁（同一次调用内保持解锁，codesign 不弹窗）----
EXISTING=$(security list-keychains -d user | tr -d ' "')
if ! echo "$EXISTING" | grep -qx "$KC"; then
  security list-keychains -d user -s $EXISTING "$KC"
fi
security default-keychain -s "$KC"
security unlock-keychain -p "$PASS" "$KC"
# 设置分区访问列表：让 codesign（apple-tool / apple 分区）在无 GUI 会话里也能
# 访问私钥，否则会报 errSecInternalComponent。幂等操作，可重复执行。
security set-key-partition-list -S apple-tool:,apple: -s -k "$PASS" "$KC" 2>/dev/null || true

# ---- 3) 取证书哈希（只在本钥匙串里查，避免和登录钥匙串里的旧证书撞名）----
HASH=$(security find-identity -v -p codesigning "$KC" 2>/dev/null | grep -oE '[0-9A-F]{40}' | head -1)
echo "==> CERT HASH = $HASH"

# ---- 4) 自检：先签个小文件确认无弹窗、可用 ----
cd /tmp && rm -f _sigtest && echo hi > _sigtest
codesign --force --sign "$HASH" --timestamp=none _sigtest 2>&1
echo "TEST_SIGN_EXIT=$?"
codesign -d -r- _sigtest 2>&1 | grep -i designated || true

# ---- 5) 签主程序（含嵌套 framework，统一用证书，designated 绑定证书根）----
echo "==> 签名 $APP"
codesign --force --deep --sign "$HASH" --timestamp=none "$APP" 2>&1
echo "APP_SIGN_EXIT=$?"
codesign -d -r- "$APP" 2>&1 | grep -i designated
codesign --verify -v "$APP" 2>&1
echo "VERIFY_EXIT=$?"

# ---- 6) 恢复默认钥匙串为 login，避免影响系统其他行为 ----
security default-keychain -s "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null || true
echo "==> 完成"
