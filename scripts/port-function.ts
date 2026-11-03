// Mechanically ports legacy Base44 functions to Supabase edge functions.
//
//   deno run -A scripts/port-function.ts health sequenceSender   # port named functions
//   deno run -A scripts/port-function.ts --all                   # port every function
//   deno run -A scripts/port-function.ts --shared                # only (re)copy shared modules
//
// What it does (see docs/PORTING.md for the why):
//   legacy_base44/shared/*.ts      → supabase/functions/_shared/*.ts   (import swaps only; existing files are not overwritten
//                                                                         unless --force, so hand edits survive)
//   legacy_base44/functions/X/entry.ts → supabase/functions/X/handler.ts (import swaps) + supabase/functions/X/index.ts (serve)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY = join(ROOT, 'legacy_base44');
const OUT = join(ROOT, 'supabase', 'functions');
const RUNTIME_FILES = new Set(['runtime.ts', 'entities.ts', 'schema.ts']);

const argv = Deno.args;
const force = argv.includes('--force');
const names = argv.filter((a) => !a.startsWith('--'));

function swapImports(src: string, depth: 'shared' | 'function'): string {
  const runtime = depth === 'shared' ? './runtime.ts' : '../_shared/runtime.ts';
  return src
    .replace(/from\s+['"]npm:@base44\/sdk[^'"]*['"]/g, `from '${runtime}'`)
    .replace(/from\s+['"]base44:runtime['"]/g, `from '${runtime}'`)
    .replace(/from\s+['"]\.\.\/\.\.\/shared\/([^'"]+)['"]/g, "from '../_shared/$1'");
}

async function exists(p: string) { try { await Deno.stat(p); return true; } catch { return false; } }

async function portShared() {
  let copied = 0, kept = 0;
  for await (const e of Deno.readDir(join(LEGACY, 'shared'))) {
    if (!e.name.endsWith('.ts')) continue;
    if (RUNTIME_FILES.has(e.name)) throw new Error(`legacy shared/${e.name} collides with the runtime module of the same name`);
    const target = join(OUT, '_shared', e.name);
    if (!force && await exists(target)) { kept++; continue; }
    await Deno.writeTextFile(target, swapImports(await Deno.readTextFile(join(LEGACY, 'shared', e.name)), 'shared'));
    copied++;
  }
  console.log(`shared: ${copied} copied, ${kept} already present`);
}

async function portFunction(name: string) {
  const entry = join(LEGACY, 'functions', name, 'entry.ts');
  if (!await exists(entry)) throw new Error(`no legacy function ${name}`);
  const dir = join(OUT, name);
  await Deno.mkdir(dir, { recursive: true });
  const handler = join(dir, 'handler.ts');
  if (force || !await exists(handler)) await Deno.writeTextFile(handler, swapImports(await Deno.readTextFile(entry), 'function'));
  const index = join(dir, 'index.ts');
  if (force || !await exists(index)) {
    await Deno.writeTextFile(index, `// Ported from legacy_base44/functions/${name}/entry.ts; the handler is unchanged apart from imports.
import { serve } from '../_shared/runtime.ts';
import handler from './handler.ts';

serve(handler);
`);
  }
  console.log(`ported ${name} → supabase/functions/${name}/`);
}

await portShared();
if (argv.includes('--shared')) Deno.exit(0);
let list = names;
if (argv.includes('--all')) {
  list = [];
  for await (const e of Deno.readDir(join(LEGACY, 'functions'))) if (e.isDirectory) list.push(e.name);
  list.sort();
}
if (!list.length) { console.error('name at least one function, or pass --all / --shared'); Deno.exit(2); }
for (const n of list) await portFunction(n);
