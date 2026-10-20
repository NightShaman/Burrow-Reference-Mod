import fs from 'node:fs';
const version = String(process.argv[2] || '').trim(); const check = process.argv.includes('--check');
if (!/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(version)) throw new Error('version_invalid');
for (const file of ['burrow.mod.json', 'package.json']) { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (check) { if (value.version !== version) throw new Error(`${file}_version_mismatch`); } else { value.version = version; fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); } }
