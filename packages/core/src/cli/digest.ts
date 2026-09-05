/** `vole digest` — "your agent week" as markdown (or `--json`). */
import { openDb } from '../db';
import { getDigest, type Range } from '../queries';
import { digestMarkdown } from '../digest';

const args = process.argv.slice(2);
const raw = args.find((a) => a.startsWith('--range='))?.split('=')[1];
const range: Range = raw === '24h' || raw === '30d' || raw === 'all' ? raw : '7d';
const d = getDigest(openDb(), range, false);
console.log(args.includes('--json') ? JSON.stringify(d, null, 2) : digestMarkdown(d));
