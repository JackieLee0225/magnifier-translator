#!/bin/bash
#
# create-signing-cert.sh —— 创建本地固定的代码签名证书
#
# 【解决什么问题】
# 没有 Apple Developer ID 时，打包只能用 ad-hoc 签名（codesign --sign -）。
# ad-hoc 产生的 designated requirement 是这样的：
#
#     identifier "com.lee.magnifiertranslator" and cdhash H"389779ef…"
#
# 授权被绑在一个精确的代码哈希上。只要改一行代码重新打包，cdhash 就变，
# macOS 就把它当成"另一个应用" —— 之前授予的「屏幕录制」权限全部作废。
# 表现就是：系统设置里明明勾着，应用却一直提示没权限，每发一版都要重授权。
#
# 换成一张固定的自签名证书之后，requirement 变成：
#
#     identifier "com.lee.magnifiertranslator" and certificate leaf = H"证书哈希"
#
# 只要证书不换，重新打包多少次授权都还在。
#
# 【用法】
#   bash scripts/create-signing-cert.sh
#
# 执行过程中系统可能弹窗要求确认修改钥匙串，输入登录密码允许即可。
# 只需要跑一次；之后 npm run dist 会自动使用这张证书。
#
# 注意：这仍然是自签名证书，无法通过 Gatekeeper 公证，分发给别人时对方
# 依旧需要手动放行。它解决的是"本机反复重新授权"的问题。

set -euo pipefail

CERT_NAME="${MT_SIGN_IDENTITY:-Magnifier Translator Local Signing}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> 证书名称: $CERT_NAME"

# 已存在就不重复创建，否则会产生同名证书导致 codesign 选择困难
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CERT_NAME"; then
  echo "==> 证书已存在，无需重建："
  security find-identity -v -p codesigning | grep "$CERT_NAME"
  echo ""
  echo "如需重建，请先在「钥匙串访问」中删除该证书后再运行本脚本。"
  exit 0
fi

# 1) 生成自签名证书。关键是 extendedKeyUsage=codeSigning，
#    否则 codesign 不认这张证书。
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

# 2) 打包成 p12 才能连私钥一起导入钥匙串
openssl pkcs12 -export \
  -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
  -out "$WORKDIR/cert.p12" -passout pass:mtlocal \
  -name "$CERT_NAME" >/dev/null 2>&1

# 3) 导入登录钥匙串，并授权 codesign 使用（-T 免去每次签名都弹窗）
echo "==> 导入钥匙串…"
security import "$WORKDIR/cert.p12" \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  -P mtlocal -T /usr/bin/codesign -T /usr/bin/security

# 4) 设为受信任的根证书，否则 find-identity 会显示 "0 valid identities"
echo "==> 设置信任（可能弹窗要求输入登录密码）…"
security add-trusted-cert -r trustRoot \
  -k "$HOME/Library/Keychains/login.keychain-db" "$WORKDIR/cert.pem"

# 5) 验证
echo ""
if security find-identity -v -p codesigning | grep -q "$CERT_NAME"; then
  echo "✓ 证书创建成功："
  security find-identity -v -p codesigning | grep "$CERT_NAME"
  echo ""
  echo "下一步：npm run dist 重新打包，之后授权一次即可长期有效。"
else
  echo "✗ 证书创建失败，请检查上面的错误输出。"
  exit 1
fi
