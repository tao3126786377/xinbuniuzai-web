'use strict';
// Offline release packaging; the runtime needs no Python or training dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
async function main() {
  const root = path.join(__dirname,'..'), source = path.join(root,'research/artifacts/full');
  const target = path.join(root,'assets/match-ai'); fs.mkdirSync(target,{ recursive: true });
  const policy = require('../lib/match-ai/policy.json');
  const names = ['manifest.json', ...Array.from({ length: 5 },(_,i) => `picks_${i+1}.npy`),
    ...Array.from({ length: 5 },(_,i) => `values_${i+1}.npy`)];
  const manifest = { policy: policy.id, files: [] };
  for (const name of names) {
    const hash = crypto.createHash('sha256'), input = fs.createReadStream(path.join(source,name));
    input.on('data',data => hash.update(data));
    await pipeline(input,zlib.createGzip({ level: 9 }),fs.createWriteStream(path.join(target,name+'.gz')));
    const sha256 = hash.digest('hex');
    if (name === 'manifest.json' && sha256 !== policy.equilibriumManifestSha256) throw new Error('Wrong baseline release');
    const bytes = fs.statSync(path.join(source,name)).size, compressed = fs.statSync(path.join(target,name+'.gz')).size;
    manifest.files.push({ name, bytes, compressed, sha256 });
    console.log(name,bytes,'->',compressed);
  }
  fs.writeFileSync(path.join(target,'bundle.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log('Bundle bytes:',manifest.files.reduce((n,f) => n+f.compressed,0));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
