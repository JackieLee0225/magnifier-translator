'use strict';

/**
 * adhoc-sign.js —— electron-builder 的 afterSign 钩子
 *
 * 没有付费的 Apple Developer ID 证书时，electron-builder 会直接跳过整个签名步骤，
 * 导致 bundle id 退回 "Electron"、entitlements 不写入、屏幕录制授权绑定错对象。
 * 本钩子用「ad-hoc 签框架 + 固定证书签主程序」解决，且保证主程序的 designated
 * requirement 绑在证书身份上（而非 cdhash），重新打包后屏幕录制授权不失效。
 *
 * 关键修复（2026-08-06）：
 *   之前用 security find-identity 挑身份，但它在构建子进程里回报 0 个有效身份
 *   （自签名证书没进系统信任枚举），于是回退成 ad-hoc —— 也就是权限丢失的根因。
 *   现在改为直接用证书 SHA-1 指纹签名（指纹写死、长期稳定），并提前给专用钥匙串
 *   设置分区访问列表（set-key-partition-list -S apple-tool:,apple:），让 codesign
 *   在无 GUI 会话里也能访问私钥，不再报 errSecInternalComponent。
 *
 * 证书存放在专用钥匙串（不碰登录钥匙串，避免反复锁定的问题）：
 *   ~/Library/Keychains/magnifier-signing.keychain-db
 * 由 scripts/apply-dev-cert.sh 生成；密码内置在脚本里（本地开发用）。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ADHOC = '-';

// 固定证书指纹（由 scripts/apply-dev-cert.sh 生成，长期不变 → 授权持久）。
const CERT_HASH = '9C441E1E71A7A1FCBDD9182AA4AAC5F31C3800B5';
// 专用签名钥匙串（优先）；缺失时回退 ad-hoc。
const DEDICATED_KEYCHAIN = path.join(
  process.env.HOME || '/Users/lee',
  'Library', 'Keychains', 'magnifier-signing.keychain-db'
);
const KEYCHAIN_PASS = process.env.MT_KEYCHAIN_PASS || 'mtlocal';

const USE_CERT = fs.existsSync(DEDICATED_KEYCHAIN);

/** 解锁专用钥匙串并设置分区列表，使 codesign 在无 GUI 会话可用 */
function prepareKeychain() {
  if (!USE_CERT) return;
  try {
    execFileSync('security', ['unlock-keychain', '-p', KEYCHAIN_PASS, DEDICATED_KEYCHAIN], { stdio: 'pipe' });
  } catch { /* 已解锁则忽略 */ }
  try {
    execFileSync('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', KEYCHAIN_PASS, DEDICATED_KEYCHAIN], { stdio: 'pipe' });
  } catch { /* 已设置则忽略 */ }
}

/** 执行一次 codesign */
function codesign(target, identity, entitlements) {
  const args = ['--force', '--sign', identity, '--timestamp=none'];
  if (entitlements) {
    args.push('--options', 'runtime', '--entitlements', entitlements);
  }
  args.push(target);
  execFileSync('codesign', args, { stdio: 'pipe' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 用固定证书签名主程序，带重试与回退：
 *   - 偶发密钥链不可用时解锁 + 分区列表修复后重试（最多 3 次）
 *   - 若始终失败，回退 ad-hoc，保证一定产出可用包
 */
async function signMainWithCert(target, entitlements) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      prepareKeychain();
      codesign(target, CERT_HASH, entitlements);
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message).split('\n')[0];
      console.warn(`[sign] 证书签名失败(第${attempt}次)，1s 后重试: ${msg}`);
      await sleep(1000);
    }
  }
  console.warn(`[sign] ⚠️ 证书签名最终失败，回退 ad-hoc: ${String(lastErr && lastErr.message).split('\n')[0]}`);
  console.warn('[sign]     后果：每次重新打包后「屏幕录制」授权都会失效，需重新授权。');
  codesign(target, ADHOC, entitlements);
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const entitlements = path.resolve(__dirname, 'entitlements.mac.plist');

  if (!fs.existsSync(appPath)) {
    throw new Error(`[adhoc-sign] 找不到 app: ${appPath}`);
  }

  if (USE_CERT) {
    console.log(`[sign] 框架/Helper/OCR 用 ad-hoc 签名；主程序用固定证书(指纹 ${CERT_HASH.slice(0, 8)}…)`);
  } else {
    console.log(`[sign] ⚠️ 未找到专用签名钥匙串，全部回退 ad-hoc 签名`);
    console.log('[sign]     后果：每次重新打包后「屏幕录制」授权都会失效，需重新授权。');
    console.log('[sign]     执行 bash scripts/apply-dev-cert.sh 可一劳永逸解决。');
  }
  console.log(`[sign] 开始签名: ${appName}.app`);

  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  // 1) 先签所有 .framework（ad-hoc，不需要密钥链）
  if (fs.existsSync(frameworksDir)) {
    for (const entry of fs.readdirSync(frameworksDir)) {
      if (entry.endsWith('.framework')) {
        codesign(path.join(frameworksDir, entry), ADHOC);
      }
    }
    // 2) 再签 Helper 子 App（ad-hoc + entitlements，否则渲染进程拿不到权限）
    for (const entry of fs.readdirSync(frameworksDir)) {
      if (entry.endsWith('.app')) {
        codesign(path.join(frameworksDir, entry), ADHOC, entitlements);
      }
    }
  }

  // 3) 签我们自己的原生 OCR 二进制（ad-hoc 即可）
  const ocrBin = path.join(appPath, 'Contents', 'Resources', 'bin', 'vision-ocr');
  if (fs.existsSync(ocrBin)) codesign(ocrBin, ADHOC);

  // 4) 最后签外层 .app —— 只有这一步用固定证书（仅一次密钥链访问）
  if (USE_CERT) {
    await signMainWithCert(appPath, entitlements);
  } else {
    codesign(appPath, ADHOC, entitlements);
  }

  // 5) 自检：签名无效就让构建失败，避免产出装上去打不开的包
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    console.log('[sign] ✓ 签名校验通过');
    const req = execFileSync('codesign', ['-d', '-r-', appPath], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const line = req.split('\n').find((l) => l.includes('designated'));
    if (line) console.log(`[sign] ${line.trim()}`);
  } catch (e) {
    throw new Error(`[sign] 签名校验失败: ${e.message}`);
  }
};
