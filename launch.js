/* 西部牛仔 · 启动器（start.bat → node launch.js）
 *
 * 中文提示全部放在这里由 Node 输出（UTF-8，配合 start.bat 里的 chcp 65001 正常显示）——
 * .bat 文件本身保持纯 ASCII + CRLF，避免 cmd 的编码解析问题。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
  console.log('首次运行，正在安装依赖…');
  try {
    execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
  } catch (e) {
    console.error('[错误] 依赖安装失败，请检查网络后重试。');
    process.exit(1);
  }
}

console.log('正在启动服务器…');
require('./server.js');
