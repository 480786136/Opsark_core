import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Run only after reviewing the full instructions and stage fragments together.
const id = process.argv[2];
if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('Expected a built-in Skill id');
const root = new URL(`../src/features/skills/definitions/${id}/`, import.meta.url);
const manifestPath = fileURLToPath(new URL('skill.json', root));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!manifest.planningContract) throw new Error('Skill has no stage contract');
const text = readFileSync(new URL('instructions.md', root), 'utf8').replace(/\r\n/g, '\n');
let hash = 0x811c9dc5;
for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
manifest.planningContract.sourceFingerprint = `fnv1a:${text.length}:${(hash >>> 0).toString(16)}`;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Updated stage source fingerprint: ${id}`);
