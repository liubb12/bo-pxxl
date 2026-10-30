#!/usr/bin/env node

const http = require("http");
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const crypto = require('crypto');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { execSync, spawn, spawnSync } = require('child_process');
const net = require('net');
const UPLOAD_URL = process.env.UPLOAD_URL || '';      // 节点或订阅自动上传地址,需填写部署Merge-sub项目后的首页地址,例如：https://merge.xxx.com
const PROJECT_URL = process.env.PROJECT_URL || '';    // 需要上传订阅或保活时需填写项目分配的url,例如：https://google.com
const AUTO_ACCESS = process.env.AUTO_ACCESS || false; // false关闭自动保活，true开启,需同时填写PROJECT_URL变量
const FILE_PATH_ENV = process.env.FILE_PATH || '.tmp';    // 运行目录,sub节点文件保存目录(不可写时自动回退到临时目录)
// 选择可写目录：容器根文件系统可能是只读的(EROFS)，必须落到可写的临时目录
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.wprobe_${process.pid}_${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    console.log(`Cannot write "${dir}": ${err.code || err.message}`);
    return false;
  }
}

// 检测目录是否允许执行文件（很多容器把 /tmp 以 noexec 挂载，二进制放这里就永远跑不起来）
function isExecutableDir(dir) {
  if (process.platform === 'win32') return true;
  const probe = path.join(dir, `.xprobe_${process.pid}_${Date.now()}`);
  try {
    fs.writeFileSync(probe, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(probe, 0o755);
    const result = spawnSync(probe, [], { timeout: 3000 });
    return result.status === 0;
  } catch (err) {
    return false;
  } finally {
    try { fs.unlinkSync(probe); } catch (e) { }
  }
}

// 剩余可用空间（statfs 不可用时返回 null）
function freeBytes(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch (e) {
    return null;
  }
}

function formatMB(bytes) {
  return bytes === null ? 'unknown' : `${(bytes / 1048576).toFixed(1)}MB`;
}

// 三个二进制约 95MB（web 36MB + bot 40MB + v1 18MB），再加节点文件余量
const REQUIRED_SPACE = 120 * 1048576;

function resolveRuntimeDir(preferred) {
  const absPreferred = path.isAbsolute(preferred) ? preferred : path.resolve(preferred);
  const candidates = [
    absPreferred,
    path.join(os.tmpdir(), 'appdata'),
    '/dev/shm/appdata',
    '/var/tmp/appdata',
    path.join(process.cwd(), 'appdata'),
    '/data/appdata',
    '/workspace/appdata'
  ];
  const home = os.homedir();
  if (home && home !== '/') candidates.push(path.join(home, 'appdata'));

  const tried = new Set();
  let bestFit = null;      // 可写+可执行，空间最大的
  let writableOnly = null; // 可写但不可执行

  for (const dir of candidates) {
    if (!dir || tried.has(dir)) continue;
    tried.add(dir);

    if (!isWritableDir(dir)) continue;
    const executable = isExecutableDir(dir);
    const free = freeBytes(dir);
    console.log(`candidate ${dir}: writable=yes exec=${executable ? 'yes' : 'no'} free=${formatMB(free)}`);

    if (!executable) {
      if (!writableOnly) writableOnly = dir;
      continue;
    }
    if (free === null || free >= REQUIRED_SPACE) {
      return dir;
    }
    if (!bestFit || free > bestFit.free) bestFit = { dir, free };
  }

  if (bestFit) {
    console.log(`WARNING: "${bestFit.dir}" is the largest executable dir but only ${formatMB(bestFit.free)} free,需要的下载空间约 95MB（会报 ENOSPC）`);
    return bestFit.dir;
  }
  if (writableOnly) {
    console.log(`WARNING: no exec-capable directory found, using "${writableOnly}" (下载的二进制文件可能无法启动)`);
    return writableOnly;
  }
  alwaysLog('FATAL: no writable directory available for FILE_PATH. Mount a writable volume or set FILE_PATH to a writable path.');
  process.exit(1);
}
const FILE_PATH = resolveRuntimeDir(FILE_PATH_ENV);
console.log(`FILE_PATH=${FILE_PATH} free=${formatMB(freeBytes(FILE_PATH))}`);

// 优先使用镜像里预装的二进制：本平台的 /tmp、/dev/shm 都是 noexec，下载到这些目录的二进制无法执行
function findPreinstalled(envKey, names) {
  const candidates = [];
  if (process.env[envKey]) candidates.push(process.env[envKey]);
  names.forEach((n) => {
    candidates.push(path.join('/usr/local/bin', n), path.join('/usr/bin', n), path.join(process.cwd(), n));
  });
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) { }
  }
  return '';
}
const PRE_XRAY = findPreinstalled('XRAY_BIN', ['xray', 'web']);
const PRE_CF = findPreinstalled('CF_BIN', ['cloudflared', 'bot']);
const PRE_NEZHA = findPreinstalled('NEZHA_BIN', ['nezha', 'v1']);
const PRE_BINS = [PRE_XRAY, PRE_CF, PRE_NEZHA].filter(Boolean);
console.log(`preinstalled: xray=${PRE_XRAY || '-'} cf=${PRE_CF || '-'} nezha=${PRE_NEZHA || '-'}`);
function isPreinstalled(p) { return PRE_BINS.includes(p); }

if (!isExecutableDir(FILE_PATH) && !PRE_XRAY) {
  console.error('本平台禁止执行可写目录中的文件(noexec)，且未发现预装二进制。');
  console.error('请在 Dockerfile 里把 xray / cloudflared / nezha 装到 /usr/local/bin（或挂载可执行卷），否则节点无法启动。');
}

// 环境变量清洗：平台 Secrets 容易带入引号、空格、换行，直接使用会导致 token 校验不匹配、隧道连不上
function cleanEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const cleaned = String(value)
    .replace(/\r/g, '')
    .replace(/\n/g, '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

const SUB_PATH = cleanEnv(process.env.SUB_PATH, 'lp56poorty');       // 订阅路径
const PORT = cleanEnv(process.env.SERVER_PORT, cleanEnv(process.env.PORT, '8888'));        // http服务订阅端口
const UUID = cleanEnv(process.env.UUID, 'cc5ce3e5-83bf-4f3f-9432-a4a25e3e444f'); // 使用哪吒v1,在不同的平台运行需修改UUID,否则会覆盖
const NEZHA_SERVER = cleanEnv(process.env.NEZHA_SERVER, 'bo88.eu.cc:8008');        // 哪吒v1填写形式: nz.abc.com:8008  哪吒v0填写形式：nz.abc.com
const NEZHA_PORT = cleanEnv(process.env.NEZHA_PORT, '');            // 使用哪吒v1请留空，哪吒v0需填写
const NEZHA_KEY = cleanEnv(process.env.NEZHA_KEY, 'JFPqIyPYAKhI7GcECQ3XbPxONPE1MYHl');              // 哪吒v1的NZ_CLIENT_SECRET或哪吒v0的agent密钥
const ARGO_DOMAIN = cleanEnv(process.env.ARGO_DOMAIN, 'pxx.boxl.eu.org');          // 固定隧道域名,留空即启用临时隧道
const DEFAULT_ARGO_AUTH = 'eyJhIjoiZDg5ZTNlYTRkOTEzOTYzYWMyZjg2NjZjYzI2MWQ3YTQiLCJ0IjoiYTY3NTNhODYtYWFmMC00YmMzLWFiMTgtMGY4MmVjZjE0MmY0IiwicyI6IlB2dTZ5NzRGNFIxT1UxR3RUMEI2VHFBajZObEhlVHZ2aU9ERnFWUVd2WkE9In0=';
const ARGO_AUTH = cleanEnv(process.env.ARGO_AUTH, DEFAULT_ARGO_AUTH);              // 固定隧道密钥json或token,留空即启用临时隧道,json获取地址：https://json.zone.id
const ARGO_PORT = cleanEnv(process.env.ARGO_PORT, '8001');            // 固定隧道端口,使用token需在cloudflare后台设置和这里一致
const S5_PORT = cleanEnv(process.env.S5_PORT, '');                  // socks5端口，支持多端口的可以填写，否则留空
const HY2_PORT = cleanEnv(process.env.HY2_PORT, '');                // hy2端口，支持多端口的可以填写，否则留空
const REALITY_PORT = cleanEnv(process.env.REALITY_PORT, '');        // reality端口，支持多端口的可以填写，否则留空
const CFIP = cleanEnv(process.env.CFIP, 'cf.877774.xyz');            // 节点优选域名或优选ip
const CFPORT = cleanEnv(process.env.CFPORT, '443');                   // 节点优选域名或优选ip对应的端口
const NAME = cleanEnv(process.env.NAME, 'pxxl-FR');                        // 节点名称
const CHAT_ID = cleanEnv(process.env.CHAT_ID, '');                  // Telegram chat_id  两个变量不全不推送节点到TG 
const BOT_TOKEN = cleanEnv(process.env.BOT_TOKEN, '');              // Telegram bot_token 两个变量不全不推送节点到TG 
const SHOW_LOG = !['false', 'disable', 'no'].includes((process.env.SHOW_LOG || 'true').toLowerCase()); // 是否显示日志输出，true/yes显示，false/disable/no屏蔽，默认显示

// 控制日志输出
if (!SHOW_LOG) {
  console.log = () => {};
  console.error = () => {};
}
function alwaysLog(msg) {
  process.stdout.write(msg + '\n');
}

// 脱敏自检：只打印长度和尾部 4 位，用于判断平台 Secrets 的值是否被改写
function describeSecret(name, value) {
  if (!value) return `${name}=empty`;
  return `${name} len=${value.length} tail=...${String(value).slice(-4)}`;
}
alwaysLog(`[cfg] ${describeSecret('UUID', UUID)}`);
alwaysLog(`[cfg] ${describeSecret('NEZHA_KEY', NEZHA_KEY)} nezhaServer=${NEZHA_SERVER}`);
alwaysLog(`[cfg] ${describeSecret('ARGO_AUTH', ARGO_AUTH)} tokenPattern=${/^[A-Z0-9a-z=]{120,250}$/.test(ARGO_AUTH) ? 'match' : 'NOMATCH'} tunnelSecret=${/TunnelSecret/.test(ARGO_AUTH) ? 'yes' : 'no'}`);
alwaysLog(`[cfg] ARGO_DOMAIN=${ARGO_DOMAIN || '-'} ARGO_PORT=${ARGO_PORT}`);

// 创建运行文件夹
try {
  fs.mkdirSync(FILE_PATH, { recursive: true });
} catch (err) {
  alwaysLog(`FATAL: cannot create FILE_PATH "${FILE_PATH}": ${err.code || err.message}`);
  process.exit(1);
}

// 端口检查
function isValidPort(port) {
  try {
    if (port === null || port === undefined || port === '') return false;
    if (typeof port === 'string' && port.trim() === '') return false;
    const portNum = parseInt(port);
    if (isNaN(portNum)) return false;
    if (portNum < 1 || portNum > 65535) return false;
    return true;
  } catch (error) {
    return false;
  }
}

// 生成随机6位字符
function generateRandomName() {
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// 全局常量
let subContent = null;
let privateKey = '';
let publicKey = '';
const npmName = generateRandomName();
const webName = generateRandomName();
const botName = generateRandomName();
const phpName = generateRandomName();
let npmPath = PRE_NEZHA || path.join(FILE_PATH, npmName);
let phpPath = PRE_NEZHA || path.join(FILE_PATH, phpName);
let webPath = PRE_XRAY || path.join(FILE_PATH, webName);
let botPath = PRE_CF || path.join(FILE_PATH, botName);
let subPath = path.join(FILE_PATH, 'sub.txt');
let listPath = path.join(FILE_PATH, 'list.txt');
let bootLogPath = path.join(FILE_PATH, 'boot.log');
let configPath = path.join(FILE_PATH, 'config.json');
let certPath = path.resolve(FILE_PATH, 'cert.pem');
let keyPath = path.resolve(FILE_PATH, 'private.key');

// 如果订阅器上存在历史运行节点则先删除
function deleteNodes() {
  try {
    if (!UPLOAD_URL) return;
    if (!fs.existsSync(subPath)) return;

    let fileContent;
    try {
      fileContent = fs.readFileSync(subPath, 'utf-8');
    } catch {
      return null;
    }

    const decoded = Buffer.from(fileContent, 'base64').toString('utf-8');
    const nodes = decoded.split('\n').filter(line =>
      /(vless|vmess|trojan|hysteria2|socks):\/\//.test(line)
    );

    if (nodes.length === 0) return;

    axios.post(`${UPLOAD_URL}/api/delete-nodes`,
      JSON.stringify({ nodes }),
      { headers: { 'Content-Type': 'application/json' } }
    ).catch((error) => {
      return null;
    });
    return null;
  } catch (err) {
    return null;
  }
}

// 清理历史文件
function cleanupOldFiles() {
  try {
    const files = fs.readdirSync(FILE_PATH);
    files.forEach(file => {
      const filePath = path.join(FILE_PATH, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        // 忽略所有错误，不记录日志
      }
    });
  } catch (err) {
    // 忽略所有错误，不记录日志
  }
}

// crypto 生成 X25519 密钥对
function generateX25519Keypair() {
  const { publicKey: pubKey, privateKey: privKey } = crypto.generateKeyPairSync('x25519');
  const privateKeyRaw = privKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const publicKeyRaw = pubKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    privateKey: privateKeyRaw.toString('base64url'),
    publicKey: publicKeyRaw.toString('base64url')
  };
}

// X25519 密钥对生成或加载
function generateOrLoadKeyPair() {
  const keyFilePath = path.join(FILE_PATH, 'key.txt');
  if (fs.existsSync(keyFilePath)) {
    const content = fs.readFileSync(keyFilePath, 'utf8');
    const privateKeyMatch = content.match(/PrivateKey:\s*(.*)/);
    const publicKeyMatch = content.match(/PublicKey:\s*(.*)/);
    if (privateKeyMatch && publicKeyMatch) {
      privateKey = privateKeyMatch[1].trim();
      publicKey = publicKeyMatch[1].trim();
      console.log('Private Key:', privateKey);
      console.log('Public Key:', publicKey);
      return;
    }
  }
  const keypair = generateX25519Keypair();
  privateKey = keypair.privateKey;
  publicKey = keypair.publicKey;
  fs.writeFileSync(keyFilePath, `PrivateKey: ${privateKey}\nPublicKey: ${publicKey}\n`, 'utf8');
  console.log('Private Key:', privateKey);
  console.log('Public Key:', publicKey);
}

// TLS 证书生成
const FALLBACK_EC_KEY =
  '-----BEGIN EC PARAMETERS-----\n' +
  'BggqhkjOPQMBBw==\n' +
  '-----END EC PARAMETERS-----\n' +
  '-----BEGIN EC PRIVATE KEY-----\n' +
  'MHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/++siNnfBYsdUYoAoGCCqGSM49\n' +
  'AwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASANnngZreoQDF16ARa\n' +
  '/TsyLyFoPkhLxSbehH/NBEjHtSZGaDhMqQ==\n' +
  '-----END EC PRIVATE KEY-----\n';

const FALLBACK_CERT =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBejCCASGgAwIBAgIUfWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw\n' +
  'EzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwOTE4MTgyMDIyWhcNMzUwOTE2MTgy\n' +
  'MDIyWjATMREwDwYDVQQDDAhiaW5nLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEH\n' +
  'A0IABNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdegEWv07Mi8h\n' +
  'aD5IS8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBBTV1cFID7UISE7PLTBR\n' +
  'BfGbgkrMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgkrMNzAPBgNVHRMB\n' +
  'Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAIDAJvg0vd/ytrQVvEcSm6XTlB+\n' +
  'eQ6OFb9LbLYL9f+sAiAffoMbi4y/0YUSlTtz7as9S8/lciBF5VCUoVIKS+vX2g==\n' +
  '-----END CERTIFICATE-----\n';

function ensureTlsCertificates(certPath, keyPath) {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  try {
    execSync('openssl version', { stdio: 'ignore' });
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${keyPath}"`, { stdio: 'ignore' });
    execSync(`openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com"`, { stdio: 'ignore' });
    return;
  } catch (e) { /* openssl not available */ }
  fs.writeFileSync(keyPath, FALLBACK_EC_KEY);
  fs.writeFileSync(certPath, FALLBACK_CERT);
}

// 计算证书的 SHA-256 指纹，优先使用 openssl，不可用时用 Node.js crypto 兜底
function getCertificateFingerprint(certPath) {
  // 方案1: 优先用 openssl
  try {
    const result = execSync(
      `openssl x509 -noout -fingerprint -sha256 -in "${certPath}"`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    const match = result.match(/=(.+)$/);
    if (match && match[1]) {
      return match[1].toUpperCase();
    }
  } catch (e) {
    // openssl 不可用，继续用 Node.js crypto
  }

  // 方案2: Node.js crypto 兜底
  try {
    const certData = fs.readFileSync(certPath, 'utf8');
    const derMatch = certData.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
    if (!derMatch) return '';
    const derBase64 = derMatch[1].replace(/\s/g, '');
    const derBuffer = Buffer.from(derBase64, 'base64');
    const hash = crypto.createHash('sha256').update(derBuffer).digest('hex');
    return hash.match(/.{2}/g).join(':').toUpperCase();
  } catch (error) {
    console.error('Failed to calculate certificate fingerprint:', error);
    return '';
  }
}

// 生成xr-ay配置文件
async function generateConfig() {
  const config = {
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
    inbounds: [
      { tag: 'vless-fallback-in', port: ARGO_PORT, listen: '::', protocol: 'vless', settings: { clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: 'none', fallbacks: [{ dest: 3001 }, { path: "/vless-argo", dest: 3002 }, { path: "/vmess-argo", dest: 3003 }, { path: "/trojan-argo", dest: 3004 }] }, streamSettings: { network: 'tcp' } },
      { tag: 'vless-tcp-in', port: 3001, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID }], decryption: "none" }, streamSettings: { network: "tcp", security: "none" } },
      { tag: 'vless-ws-in', port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { tag: 'vmess-ws-in', port: 3003, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: UUID, alterId: 0 }] }, streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { tag: 'trojan-ws-in', port: 3004, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: UUID }] }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
    ],
    dns: { servers: ["https+local://8.8.8.8/dns-query"] },
    outbounds: [{ protocol: "freedom", tag: "direct" }, { protocol: "blackhole", tag: "block" }]
  };

  // VLESS Reality 配置
  if (isValidPort(REALITY_PORT)) {
    config.inbounds.push({
      tag: "vless-in",
      listen: "::",
      port: parseInt(REALITY_PORT),
      protocol: "vless",
      settings: {
        clients: [{ id: UUID, flow: "xtls-rprx-vision" }],
        decryption: "none"
      },
      streamSettings: {
        network: "raw",
        security: "reality",
        realitySettings: {
          show: false,
          dest: "www.iij.ad.jp:443",
          xver: 0,
          serverNames: ["www.iij.ad.jp"],
          privateKey: privateKey,
          shortIds: [""]
        }
      }
    });
  }

  // Hysteria2 配置
  if (isValidPort(HY2_PORT)) {
    config.inbounds.push({
      tag: "hysteria-in",
      listen: "::",
      port: parseInt(HY2_PORT),
      protocol: "hysteria",
      settings: {
        version: 2,
        clients: [{ auth: UUID }]
      },
      streamSettings: {
        network: "hysteria",
        hysteriaSettings: {
          version: 2,
          masquerade: {
            type: "proxy",
            url: "https://bing.com"
          }
        },
        security: "tls",
        tlsSettings: {
          alpn: ["h3"],
          certificates: [
            {
              certificateFile: certPath,
              keyFile: keyPath
            }
          ]
        }
      }
    });
  }

  // S5 配置
  if (isValidPort(S5_PORT)) {
    config.inbounds.push({
      tag: "s5-in",
      listen: "::",
      port: parseInt(S5_PORT),
      protocol: "socks",
      settings: {
        auth: "password",
        accounts: [
          {
            user: UUID.substring(0, 8),
            pass: UUID.slice(-12)
          }
        ],
        udp: true
      }
    });
  }

  fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config, null, 2));
}

// 判断系统架构
function getSystemArchitecture() {
  const arch = os.arch();
  if (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') {
    return 'arm';
  } else {
    return 'amd';
  }
}

// 下载对应系统架构的依赖文件
function downloadFile(fileName, fileUrl, callback) {
  const filePath = fileName;

  if (!fs.existsSync(FILE_PATH)) {
    fs.mkdirSync(FILE_PATH, { recursive: true });
  }

  const writer = fs.createWriteStream(filePath);

  axios({
    method: 'get',
    url: fileUrl,
    responseType: 'stream',
  })
    .then(response => {
      response.data.pipe(writer);

      writer.on('finish', () => {
        writer.close();
        console.log(`Download ${path.basename(filePath)} successfully`);
        callback(null, filePath);
      });

      writer.on('error', err => {
        fs.unlink(filePath, () => { });
        const errorMessage = `Download ${path.basename(filePath)} failed: ${err.message}`;
        console.error(errorMessage);
        callback(errorMessage);
      });
    })
    .catch(err => {
      const errorMessage = `Download ${path.basename(filePath)} failed: ${err.message}`;
      console.error(errorMessage);
      callback(errorMessage);
    });
}

// ------- 进程启动与自检（替代 nohup + exec 的静默模式） -------
const runningProcesses = [];

function launchProcess(name, binPath, args, logFile, record) {
  return new Promise((resolve) => {
    if (!fs.existsSync(binPath)) {
      console.error(`[${name}] binary not found: ${binPath}`);
      return resolve(null);
    }

    let out = 'ignore';
    try {
      if (logFile) out = fs.openSync(logFile, 'a');
    } catch (e) {
      out = 'ignore';
    }

    let child;
    let spawnError = null;
    try {
      child = spawn(binPath, args, { detached: true, stdio: ['ignore', out, out] });
    } catch (err) {
      spawnError = err;
    }
    if (spawnError) {
      console.error(`[${name}] launch failed: ${spawnError.code || spawnError.message}`);
      return resolve(null);
    }

    child.on('error', (err) => {
      spawnError = err;
      let hint = '';
      if (['EACCES', 'EPERM'].includes(err.code)) hint = ' (目录可能以 noexec 挂载)';
      if (err.code === 'ENOEXEC') hint = ' (不是可执行文件/下载不完整)';
      console.error(`[${name}] spawn error: ${err.code || err.message}${hint}`);
    });
    child.unref();
    const rec = record || { name, binPath, args, logFile, restarts: 0 };
    rec.child = child;
    rec.binPath = binPath;
    rec.args = args;
    rec.logFile = logFile;
    if (!record) runningProcesses.push(rec);

    setTimeout(() => {
      if (spawnError) return resolve(null);
      if (child.exitCode !== null) {
        console.error(`[${name}] exited immediately (code=${child.exitCode})`);
        return resolve(null);
      }
      console.log(`[${name}] is running, pid=${child.pid}`);
      resolve(child);
    }, 1500);
  });
}

function tailFile(file, lines = 15) {
  try {
    if (!file || !fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch (e) {
    return '';
  }
}

function checkTcp(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// 启动后自检：端口是否监听、隧道是否连上、各进程日志尾部
async function reportRuntimeStatus() {
  await new Promise((r) => setTimeout(r, 15000));

  const ports = [parseInt(ARGO_PORT)];
  if (isValidPort(REALITY_PORT)) ports.push(parseInt(REALITY_PORT));
  if (isValidPort(HY2_PORT)) ports.push(parseInt(HY2_PORT));
  if (isValidPort(S5_PORT)) ports.push(parseInt(S5_PORT));
  for (const p of ports) {
    const ok = await checkTcp('127.0.0.1', p);
    console.log(`port ${p}: ${ok ? 'listening' : 'NOT listening'}`);
  }

  const bootLog = tailFile(bootLogPath, 25);
  if (bootLog) {
    console.log(`---- ${bootLogPath} ----\n${bootLog}`);
    if (/Registered tunnel connection/i.test(bootLog)) {
      console.log('cloudflared: tunnel connected');
    } else if (/error|failed|ERR/i.test(bootLog)) {
      console.error('cloudflared: tunnel FAILED, see the log above');
    } else {
      console.log('cloudflared: 仍在建立连接（日志暂未出现 Registered tunnel connection）');
    }
  }

  for (const { name, logFile } of runningProcesses) {
    const text = tailFile(logFile, 8);
    if (text) console.log(`---- ${name} runtime log ----\n${text}`);
  }
}

// 持续看护：进程退出自动重启（最多 5 次），并周期性输出 cloudflared 日志尾部
function attachWatchdog() {
  let lastBootTail = '';
  setInterval(async () => {
    for (const p of runningProcesses) {
      if (!p || !p.child || p.child.exitCode === null) continue;
      if ((p.restarts || 0) >= 5) continue;
      p.restarts = (p.restarts || 0) + 1;
      console.error(`[${p.name}] died (code=${p.child.exitCode}), restart #${p.restarts}`);
      const t = tailFile(p.logFile, 6);
      if (t) console.error(t);
      const child = await launchProcess(p.name, p.binPath, p.args, p.logFile, p);
      if (child) console.log(`[${p.name}] restarted, pid=${child.pid}`);
    }
    const b = tailFile(bootLogPath, 4);
    if (b && b !== lastBootTail) {
      lastBootTail = b;
      console.log(`---- boot.log tail ----\n${b}`);
    }
  }, 30000).unref();
}

// 下载并运行依赖文件
async function downloadFilesAndRun() {
  const architecture = getSystemArchitecture();
  const filesToDownload = getFilesForArchitecture(architecture).filter((f) => !isPreinstalled(f.fileName));

  if (filesToDownload.length === 0) {
    console.log('使用镜像内预装的二进制，跳过下载');
  } else {
    const downloadPromises = filesToDownload.map(fileInfo => {
      return new Promise((resolve, reject) => {
        downloadFile(fileInfo.fileName, fileInfo.fileUrl, (err, filePath) => {
          if (err) {
            reject(err);
          } else {
            resolve(filePath);
          }
        });
      });
    });

    try {
      await Promise.all(downloadPromises);
    } catch (err) {
      console.error('Error downloading files:', err);
    }
  }

  function authorizeFiles(filePaths) {
    const newPermissions = 0o775;
    filePaths.forEach(absoluteFilePath => {
      if (!fs.existsSync(absoluteFilePath)) return;
      try {
        fs.chmodSync(absoluteFilePath, newPermissions);
        console.log(`Empowerment success for ${absoluteFilePath}: ${newPermissions.toString(8)}`);
      } catch (err) {
        console.error(`Empowerment failed for ${absoluteFilePath}: ${err}`);
      }
    });
  }
  const filesToAuthorize = NEZHA_PORT ? [npmPath, webPath, botPath] : [phpPath, webPath, botPath];
  authorizeFiles(filesToAuthorize);

  // 运行ne-zha
  if (NEZHA_SERVER && NEZHA_KEY) {
    if (!NEZHA_PORT) {
      const port = NEZHA_SERVER.includes(':') ? NEZHA_SERVER.split(':').pop() : '';
      const tlsPorts = new Set(['443', '8443', '2096', '2087', '2083', '2053']);
      const nezhatls = tlsPorts.has(port) ? 'true' : 'false';
      const configYaml = `
client_secret: ${NEZHA_KEY}
debug: false
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: true
ip_report_period: 1800
report_delay: 4
server: ${NEZHA_SERVER}
skip_connection_count: true
skip_procs_count: true
temperature: false
tls: ${nezhatls}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${UUID}`;

      fs.writeFileSync(path.join(FILE_PATH, 'config.yaml'), configYaml);

      await launchProcess(phpName, phpPath, ['-c', path.join(FILE_PATH, 'config.yaml')], path.join(FILE_PATH, 'nezha.log'));
    } else {
      let NEZHA_TLS = '';
      const tlsPorts = ['443', '8443', '2096', '2087', '2083', '2053'];
      if (tlsPorts.includes(NEZHA_PORT)) {
        NEZHA_TLS = '--tls';
      }
      const nezhaArgs = ['-s', `${NEZHA_SERVER}:${NEZHA_PORT}`, '-p', NEZHA_KEY];
      if (NEZHA_TLS) nezhaArgs.push(NEZHA_TLS);
      nezhaArgs.push('--disable-auto-update', '--report-delay', '4', '--skip-conn', '--skip-procs');
      await launchProcess(npmName, npmPath, nezhaArgs, path.join(FILE_PATH, 'nezha.log'));
    }
  } else {
    console.log('NEZHA variable is empty,skip running');
  }

  // 运行xr-ay
  await launchProcess(webName, webPath, ['-c', path.join(FILE_PATH, 'config.json')], path.join(FILE_PATH, 'xray.log'));

  // 运行cloud-fared
  if (fs.existsSync(botPath)) {
    let args;

    if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
      args = ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2',
        '--logfile', bootLogPath, '--loglevel', 'info', 'run', '--token', ARGO_AUTH];
    } else if (ARGO_AUTH.match(/TunnelSecret/)) {
      args = ['tunnel', '--edge-ip-version', 'auto', '--config', path.join(FILE_PATH, 'tunnel.yml'),
        '--logfile', bootLogPath, '--loglevel', 'info', 'run'];
    } else {
      args = ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2',
        '--logfile', bootLogPath, '--loglevel', 'info', '--url', `http://localhost:${ARGO_PORT}`];
    }

    await launchProcess(botName, botPath, args, bootLogPath);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// 根据系统架构返回对应的url
function getFilesForArchitecture(architecture) {
  let baseFiles;
  if (architecture === 'arm') {
    baseFiles = [
      { fileName: webPath, fileUrl: "https://arm64.ssss.nyc.mn/web" },
      { fileName: botPath, fileUrl: "https://arm64.ssss.nyc.mn/bot" }
    ];
  } else {
    baseFiles = [
      { fileName: webPath, fileUrl: "https://amd64.ssss.nyc.mn/web" },
      { fileName: botPath, fileUrl: "https://amd64.ssss.nyc.mn/bot" }
    ];
  }

  if (NEZHA_SERVER && NEZHA_KEY) {
    if (NEZHA_PORT) {
      const npmUrl = architecture === 'arm'
        ? "https://arm64.ssss.nyc.mn/agent"
        : "https://amd64.ssss.nyc.mn/agent";
      baseFiles.unshift({
        fileName: npmPath,
        fileUrl: npmUrl
      });
    } else {
      const phpUrl = architecture === 'arm'
        ? "https://arm64.ssss.nyc.mn/v1"
        : "https://amd64.ssss.nyc.mn/v1";
      baseFiles.unshift({
        fileName: phpPath,
        fileUrl: phpUrl
      });
    }
  }

  return baseFiles;
}

// 获取固定隧道json
function argoType() {
  if (!ARGO_AUTH || !ARGO_DOMAIN) {
    console.log("ARGO_DOMAIN or ARGO_AUTH is empty, use quick tunnels");
    return;
  }

  if (ARGO_AUTH.includes('TunnelSecret')) {
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), ARGO_AUTH);
    const tunnelYaml = `
  tunnel: ${ARGO_AUTH.split('"')[11]}
  credentials-file: ${path.join(FILE_PATH, 'tunnel.json')}
  protocol: http2
  
  ingress:
    - hostname: ${ARGO_DOMAIN}
      service: http://localhost:${ARGO_PORT}
      originRequest:
        noTLSVerify: true
    - service: http_status:404
  `;
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), tunnelYaml);
  } else {
    console.log(`Using token connect to tunnel, please set ${ARGO_PORT} in clouudflare`);
  }
}

// 获取临时隧道domain
async function extractDomains() {
  let argoDomain;

  if (ARGO_AUTH && ARGO_DOMAIN) {
    argoDomain = ARGO_DOMAIN;
    console.log('ARGO_DOMAIN:', argoDomain);
    await generateLinks(argoDomain);
  } else {
    try {
      const fileContent = fs.readFileSync(path.join(FILE_PATH, 'boot.log'), 'utf-8');
      const lines = fileContent.split('\n');
      const argoDomains = [];
      lines.forEach((line) => {
        const domainMatch = line.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
        if (domainMatch) {
          const domain = domainMatch[1];
          argoDomains.push(domain);
        }
      });

      if (argoDomains.length > 0) {
        argoDomain = argoDomains[0];
        console.log('ArgoDomain:', argoDomain);
        await generateLinks(argoDomain);
      } else {
        console.log('ArgoDomain not found, re-running bot to obtain ArgoDomain');
        fs.unlinkSync(path.join(FILE_PATH, 'boot.log'));
        async function killBotProcess() {
          try {
            if (process.platform === 'win32') {
              await exec(`taskkill /f /im ${botName}.exe > nul 2>&1`);
            } else {
              await exec(`pkill -f "[${botName.charAt(0)}]${botName.substring(1)}" > /dev/null 2>&1`);
            }
          } catch (error) {
            // 忽略输出
          }
        }
        killBotProcess();
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const args = ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2',
          '--logfile', bootLogPath, '--loglevel', 'info', '--url', `http://localhost:${ARGO_PORT}`];
        try {
          await launchProcess(botName, botPath, args, bootLogPath);
          await new Promise((resolve) => setTimeout(resolve, 6000));
          await extractDomains();
        } catch (error) {
          console.error(`Error executing command: ${error}`);
        }
      }
    } catch (error) {
      console.error('Error reading boot.log:', error);
    }
  }
}

// 获取isp信息
async function getMetaInfo() {
  try {
    const response1 = await axios.get('https://api.ip.sb/geoip', { headers: { 'User-Agent': 'Mozilla/5.0', timeout: 3000 } });
    if (response1.data && response1.data.country_code && response1.data.isp) {
      return `${response1.data.country_code}-${response1.data.isp}`.replace(/\s+/g, '_');
    }
  } catch (error) {
    try {
      const response2 = await axios.get('http://ip-api.com/json', { headers: { 'User-Agent': 'Mozilla/5.0', timeout: 3000 } });
      if (response2.data && response2.data.status === 'success' && response2.data.countryCode && response2.data.org) {
        return `${response2.data.countryCode}-${response2.data.org}`.replace(/\s+/g, '_');
      }
    } catch (error) {
      // console.error('Backup API also failed');
    }
  }
  return 'Unknown';
}

// 获取服务器公网IP
async function getServerIP() {
  let serverIP = '';
  try {
    const ipv4Response = await axios.get('http://ipv4.ip.sb', { timeout: 3000 });
    serverIP = ipv4Response.data.trim();
  } catch (err) {
    try {
      serverIP = execSync('curl -sm 3 ipv4.ip.sb').toString().trim();
    } catch (curlErr) {
      try {
        const ipv6Response = await axios.get('http://ipv6.ip.sb', { timeout: 3000 });
        serverIP = `[${ipv6Response.data.trim()}]`;
      } catch (ipv6AxiosErr) {
        try {
          serverIP = `[${execSync('curl -sm 3 ipv6.ip.sb').toString().trim()}]`;
        } catch (ipv6CurlErr) {
          console.error('Failed to get IP address:', ipv6CurlErr.message);
        }
      }
    }
  }
  return serverIP;
}

// 生成 list 和 sub 信息
async function generateLinks(argoDomain) {
  const ISP = await getMetaInfo();
  const nodeName = NAME ? `${NAME}-${ISP}` : ISP;
  const SERVER_IP = await getServerIP();

  return new Promise((resolve) => {
    setTimeout(() => {
      const VMESS = { v: '2', ps: `${nodeName}`, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: argoDomain, path: '/vmess-argo?ed=2560', tls: 'tls', sni: argoDomain, alpn: '', fp: 'firefox' };
      let subTxt = `
vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}

vmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')}

trojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}
    `;

      // HY2_PORT是有效端口号时生成hysteria2节点
      if (isValidPort(HY2_PORT)) {
        const fingerprint = getCertificateFingerprint(certPath);
        const fingerprintParam = fingerprint ? `&pinSHA256=${encodeURIComponent(fingerprint)}` : '';
        const hysteriaNode = `\nhysteria2://${UUID}@${SERVER_IP}:${HY2_PORT}/?sni=www.bing.com&insecure=0&alpn=h3&obfs=none${fingerprintParam}#${nodeName}`;
        subTxt += hysteriaNode;
      }

      // REALITY_PORT是有效端口号时生成reality节点
      if (isValidPort(REALITY_PORT)) {
        const vlessNode = `\nvless://${UUID}@${SERVER_IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.iij.ad.jp&fp=firefox&pbk=${publicKey}&type=tcp&headerType=none#${nodeName}`;
        subTxt += vlessNode;
      }

      // S5_PORT是有效端口号时生成socks5节点
      if (isValidPort(S5_PORT)) {
        const S5_AUTH = Buffer.from(`${UUID.substring(0, 8)}:${UUID.slice(-12)}`).toString('base64');
        const s5Node = `\nsocks://${S5_AUTH}@${SERVER_IP}:${S5_PORT}#${nodeName}`;
        subTxt += s5Node;
      }

      console.log(Buffer.from(subTxt).toString('base64'));
      fs.writeFileSync(subPath, Buffer.from(subTxt).toString('base64'));
      fs.writeFileSync(listPath, subTxt, 'utf8');
      console.log(`${FILE_PATH}/sub.txt saved successfully`);
      // 将订阅内容保存到全局变量，供 http 服务器使用
      subContent = Buffer.from(subTxt).toString('base64');
      uploadNodes();
      resolve(subTxt);
    }, 2000);
  });
}

// 自动上传节点或订阅
async function uploadNodes() {
  if (UPLOAD_URL && PROJECT_URL) {
    const subscriptionUrl = `${PROJECT_URL}/${SUB_PATH}`;
    const jsonData = {
      subscription: [subscriptionUrl]
    };
    try {
      const response = await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, jsonData, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response && response.status === 200) {
        console.log('Subscription uploaded successfully');
        return response;
      } else {
        return null;
      }
    } catch (error) {
      if (error.response) {
        if (error.response.status === 400) {
          // console.error('Subscription already exists');
        }
      }
    }
  } else if (UPLOAD_URL) {
    if (!fs.existsSync(listPath)) return;
    const content = fs.readFileSync(listPath, 'utf-8');
    const nodes = content.split('\n').filter(line => /(vless|vmess|trojan|hysteria2|socks):\/\//.test(line));

    if (nodes.length === 0) return;

    const jsonData = JSON.stringify({ nodes });

    try {
      const response = await axios.post(`${UPLOAD_URL}/api/add-nodes`, jsonData, {
        headers: { 'Content-Type': 'application/json' }
      });
      if (response && response.status === 200) {
        console.log('Nodes uploaded successfully');
        return response;
      } else {
        return null;
      }
    } catch (error) {
      return null;
    }
  } else {
    // console.log('Skipping upload nodes');
    return;
  }
}

// 90s后删除相关文件
function cleanFiles() {
  setTimeout(() => {
    // boot.log 保留，供诊断接口读取隧道状态
    const filesToDelete = [configPath, webPath, botPath, listPath, certPath, keyPath];

    if (NEZHA_PORT) {
      filesToDelete.push(npmPath);
    } else if (NEZHA_SERVER && NEZHA_KEY) {
      filesToDelete.push(phpPath);
    }

    // 只删运行目录里下载的文件，镜像预装的二进制不能删
    const onlyDownloaded = filesToDelete.filter((p) => path.resolve(p).startsWith(path.resolve(FILE_PATH) + path.sep));

    if (process.platform === 'win32') {
      exec(`del /f /q ${onlyDownloaded.join(' ')} > nul 2>&1`, (error) => {
        console.clear();
        alwaysLog('App is running');
        console.log('Thank you for using this script, enjoy!');
      });
    } else {
      exec(`rm -rf ${onlyDownloaded.join(' ')} >/dev/null 2>&1`, (error) => {
        console.clear();
        alwaysLog('App is running');
        console.log('Thank you for using this script, enjoy!');
      });
    }
  }, 90000);
}
cleanFiles();

// Telegram 推送节点
async function sendTelegram() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('TG variables is empty, Skipping push nodes to TG');
    return;
  }
  try {
    const message = fs.readFileSync(subPath, 'utf8');
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const escapedName = NAME.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&');
    const params = {
      chat_id: CHAT_ID,
      text: `**${escapedName}节点推送**\n\`\`\`${message}\`\`\``,
      parse_mode: 'MarkdownV2'
    };
    await axios.post(url, null, { params });
    console.log('Telegram message sent successfully');
  } catch (error) {
    console.error('Failed to send Telegram message:', error.message);
  }
}

// 自动访问项目URL
async function AddVisitTask() {
  if (!AUTO_ACCESS || !PROJECT_URL) {
    console.log("Skipping adding automatic access task");
    return;
  }

  try {
    const response = await axios.post('https://oooo.serv00.net/add-url', {
      url: PROJECT_URL
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    console.log(`automatic access task added successfully`);
    return response;
  } catch (error) {
    console.error(`Add automatic access task faild: ${error.message}`);
    return null;
  }
}

// 主运行逻辑
async function startserver() {
  try {
    argoType();
    deleteNodes();
    cleanupOldFiles();

    // 生成 Reality 密钥对 (仅当 REALITY_PORT 开启才生成)
    if (isValidPort(REALITY_PORT)) {
      generateOrLoadKeyPair();
    }

    // 生成 TLS 证书 (用于 Hysteria2)
    if (isValidPort(HY2_PORT)) {
      ensureTlsCertificates(certPath, keyPath);
    }

    await generateConfig();
    await downloadFilesAndRun();
    await extractDomains();
    await reportRuntimeStatus();
    attachWatchdog();
    await sendTelegram();
    await AddVisitTask();
  } catch (error) {
    console.error('Error in startserver:', error);
  }
}
startserver().catch(error => {
  console.error('Unhandled error in startserver:', error);
});

// 创建 http 服务器
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // 订阅路由
  if (urlPath === `/${SUB_PATH}`) {
    if (subContent) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(subContent);
    } else {
      try {
        const fileContent = fs.readFileSync(subPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(fileContent);
      } catch (err) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Subscription content not yet available, please try again later.');
      }
    }
    return;
  }

  // 根路由: /
  if (urlPath === '/') {
    try {
      const filePath = path.join(__dirname, 'index.html');
      const data = await fs.promises.readFile(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end("Hello world!<br><br>You can access /{SUB_PATH}(Default: /sub) to get your nodes!");
    }
    return;
  }

  // 诊断路由：仅用订阅路径作口令，输出脱敏运行状态与隧道日志，便于在无平台日志时排查
  if (urlPath === `/diag-${SUB_PATH}`) {
    const checkPort = (p) => new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: Number(p) }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
    });
    const argoPortOpen = await checkPort(ARGO_PORT);
    let bootTail = '';
    try {
      bootTail = fs.readFileSync(bootLogPath, 'utf-8').slice(-2500);
    } catch (e) { bootTail = `(boot.log not readable: ${e.code || e.message})`; }
    const diag = {
      time: new Date().toISOString(),
      filePath: FILE_PATH,
      free: formatMB(freeBytes(FILE_PATH)),
      port: PORT,
      preinstalled: { xray: PRE_XRAY || '-', cf: PRE_CF || '-', nezha: PRE_NEZHA || '-' },
      argo: {
        authLen: ARGO_AUTH.length,
        authTail: ARGO_AUTH.slice(-4),
        tokenPattern: /^[A-Z0-9a-z=]{120,250}$/.test(ARGO_AUTH),
        equalsDefault: ARGO_AUTH === DEFAULT_ARGO_AUTH,
        branch: /^[A-Z0-9a-z=]{120,250}$/.test(ARGO_AUTH) ? 'token' : (/TunnelSecret/.test(ARGO_AUTH) ? 'config' : 'quick'),
        domain: ARGO_DOMAIN,
        argoPort: ARGO_PORT,
        argoPortOpen
      },
      uuidLen: UUID.length,
      uuidTail: UUID.slice(-4),
      nezhaKeyLen: NEZHA_KEY.length,
      processes: runningProcesses.map((p) => ({ name: p.name, bin: p.binPath, exit: p.child ? p.child.exitCode : null, restarts: p.restarts })),
      bootLogTail: bootTail
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(diag, null, 2));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => alwaysLog(`http server is running on ${PORT}!`));
