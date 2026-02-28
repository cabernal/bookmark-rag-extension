import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

const sourceDir = resolve(projectRoot, 'node_modules/@xenova/transformers/dist');
const targetDir = resolve(projectRoot, 'vendor/transformers');

if (!existsSync(sourceDir)) {
  console.error('Missing @xenova/transformers. Run: npm install');
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Copied transformers dist assets to ${targetDir}`);
