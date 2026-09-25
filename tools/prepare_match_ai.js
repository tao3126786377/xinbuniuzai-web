'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
async function prepare(target = path.join(__dirname,'../.runtime/match-ai')) {
  const source = path.join(__dirname,'../assets/match-ai'), policy = require('../lib/match-ai/policy.json');
  const raw = fs.readFileSync(path.join(source,'bundle.json')), bundle = JSON.parse(raw);
  const stamp = crypto.createHash('sha256').update(raw).digest('hex'), marker = path.join(target,'ready.json');
  if (bundle.policy !== policy.id) throw new Error('Wrong AI asset bundle');
  if (fs.existsSync(marker) && fs.readFileSync(marker,'utf8') === stamp &&
      bundle.files.every(f => fs.existsSync(path.join(target,f.name)) && fs.statSync(path.join(target,f.name)).size === f.bytes)) return target;
  fs.mkdirSync(target,{ recursive: true });
  for (const file of bundle.files) {
    if (!/^(manifest\.json|(?:picks|values)_[1-5]\.npy)$/.test(file.name)) throw new Error('Invalid AI bundle path');
    const hash = crypto.createHash('sha256'); let bytes = 0;
    const check = new Transform({ transform(chunk,encoding,next) { bytes += chunk.length; hash.update(chunk); next(null,chunk); } });
    const temporary = path.join(target,file.name+'.tmp');
    await pipeline(fs.createReadStream(path.join(source,file.name+'.gz')),zlib.createGunzip(),check,fs.createWriteStream(temporary));
    if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error('AI asset integrity check failed: '+file.name);
    fs.renameSync(temporary,path.join(target,file.name));
  }
  if (crypto.createHash('sha256').update(fs.readFileSync(path.join(target,'manifest.json'))).digest('hex') !== policy.equilibriumManifestSha256)
    throw new Error('Wrong equilibrium manifest');
  fs.writeFileSync(marker,stamp); console.log('[完整人机] 模型资源已准备就绪'); return target;
}
module.exports = { prepare };
if (require.main === module) prepare().catch(error => { console.error(error); process.exitCode = 1; });
