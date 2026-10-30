// One-step local setup for live AIS: writes .dev.vars (git-ignored) with your aisstream.io key and fresh secrets.
// Usage: npm run live:setup -- <AISSTREAM_API_KEY> [india|indian-ocean|world]
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const [key, region = 'world'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');

if (!key || key.length < 16) {
  console.error('Usage: npm run live:setup -- <AISSTREAM_API_KEY> [india|indian-ocean|world]\nGet a free key at https://aisstream.io (sign in with GitHub -> API Keys).');
  process.exit(1);
}
if (!['india', 'indian-ocean', 'world'].includes(region)) {
  console.error('Region must be one of: india | indian-ocean | world');
  process.exit(1);
}
if (existsSync('.dev.vars') && !force) {
  console.error('.dev.vars already exists. Re-run with --force to overwrite it.');
  process.exit(1);
}

const password = randomBytes(9).toString('base64url');
writeFileSync(
  '.dev.vars',
  [`JWT_SECRET=${randomBytes(32).toString('hex')}`, `SEED_PASSWORD=${password}`, 'DATA_SOURCE=aisstream', `AISSTREAM_API_KEY=${key}`, `AIS_REGION=${region}`, ''].join('\n'),
);
console.log(`Wrote .dev.vars (region: ${region}).\nSign-in users: admin / analyst / operator   password: ${password}\nNow run: npm run live   then open http://localhost:8787`);
