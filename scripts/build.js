#!/usr/bin/env node
/**
 * CF-Server-Monitor-Pro 构建脚本（零第三方依赖）
 *
 * 职责：
 *   1) 读取 src/index.js，写入 dist/_worker.js（Pages 单文件 Worker 入口）
 *   2) 将 src/index.js 覆盖同步到根目录 workers.js（保持源码与部署入口一致）
 *   3) 输出每个产出文件的字节数与 SHA256，并断言三份文件哈希一致，不一致则退出码 1
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.js');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_WORKER = path.join(DIST_DIR, '_worker.js');
const ROOT_WORKER = path.join(ROOT, 'workers.js');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('[build] 失败：找不到源文件 ' + SRC);
    process.exit(1);
  }

  const source = fs.readFileSync(SRC);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(DIST_WORKER, source);
  fs.writeFileSync(ROOT_WORKER, source);

  const targets = [
    { label: 'src/index.js    (源文件)', file: SRC },
    { label: 'workers.js      (根目录部署入口，与源码保持同步)', file: ROOT_WORKER },
    { label: 'dist/_worker.js (Pages 构建产物)', file: DIST_WORKER }
  ];

  const hashes = [];
  console.log('[build] 产出文件：');
  for (const t of targets) {
    const buf = fs.readFileSync(t.file);
    const h = sha256(buf);
    hashes.push(h);
    console.log('  - ' + t.label);
    console.log('      路径   : ' + t.file);
    console.log('      字节数 : ' + buf.length + ' B');
    console.log('      SHA256 : ' + h);
  }

  const consistent = hashes.every((h) => h === hashes[0]);
  if (!consistent) {
    console.error('[build] 失败：三份文件 SHA256 不一致，请检查是否有文件被独立修改');
    process.exit(1);
  }

  console.log('[build] 成功：三份文件 SHA256 一致 -> ' + hashes[0]);
}

main();
