/**
 * Bundle the backend into one file.
 *
 * WHY
 * The packaged app unpacks `node_modules/**` out of the asar, because Node's
 * ESM resolver — unlike the CommonJS one — is not patched by Electron to read
 * inside the archive. That is thousands of loose files written on every launch:
 * ~60 seconds of cold start, and a ~280 MB extraction left in %TEMP% each run.
 *
 * Bundling inlines every dependency into a single file, so `node_modules` no
 * longer has to be unpacked at all.
 *
 * WHAT STAYS EXTERNAL, AND WHY
 *   gmgn-cli  — it is SPAWNED as a child process, not imported. A bundled copy
 *               would not exist as a real path on disk for spawn() to run, and
 *               `server/gmgn.js` resolves it via
 *               node_modules/gmgn-cli/dist/index.js. It stays unpacked.
 *   telegram  — GramJS resolves parts of itself at runtime and ships its own
 *               native-ish bits; bundling it is where this gets fragile, so it
 *               is left external and unpacked too. Still a large win: it is one
 *               package instead of the whole tree.
 *
 * Output is CJS. The server is ESM source, but a bundle has no package.json
 * beside it to declare `"type": "module"` — the exact trap documented in
 * AGENTS.md, where asarUnpack moved server/ away from the root manifest and
 * Node silently fell back to CommonJS. Emitting CJS removes the question.
 */
import { build } from 'esbuild';
import { rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'fs';

const OUT = 'dist-server';
const cliVersion = JSON.parse(readFileSync('node_modules/gmgn-cli/package.json', 'utf8')).version;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const result = await build({
  entryPoints: ['server/index.js'],
  outfile: `${OUT}/server.cjs`,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // Not minified on purpose: a stack trace out of backend.log is the primary
  // debugging tool for the packaged build, and mangled frames would take that
  // away for a few MB that do not matter here.
  minify: false,
  sourcemap: false,
  external: ['gmgn-cli'],
  logLevel: 'info',
  metafile: true,
  banner: {
    // Bundled CJS loses import.meta.url, which server/index.js uses to locate
    // itself. __filename is the CJS equivalent and points at the bundle, which
    // is what the path logic actually wants.
    js: `const __import_meta_url = require('url').pathToFileURL(__filename).href;`,
  },
  define: { 'import.meta.url': '__import_meta_url' },
});

// The gmgn-cli shim is SPAWNED, not imported, so esbuild never sees it — and
// server/gmgn.js resolves it as `join(__dirname, 'gmgn-cli-shim.cjs')`, where
// __dirname is now the bundle's directory rather than server/. Copy it beside
// the bundle so that path still lands. (Caught by running the bundle: every
// GMGN call failed with "Cannot find module .../dist-server/gmgn-cli-shim.cjs".)
copyFileSync('server/gmgn-cli-shim.cjs', `${OUT}/gmgn-cli-shim.cjs`);

// gmgn-cli runs as its OWN process, so it needs its OWN dependency tree on
// disk — shipping the package alone got as far as
// "Cannot find package 'undici'". Bundling it removes node_modules from the
// picture entirely: one spawnable file with commander/undici/socks/dotenv
// inlined.
//
// Kept as ESM (`format: 'esm'`) because the shim loads it with dynamic
// import(), and because gmgn-cli is authored as an ES module — converting it
// to CJS would mean rewriting how the shim hands over, for no gain.
// gmgn-cli reads its own version at runtime, from TWO different depths:
//   dist/index.js          -> createRequire(import.meta.url)("../package.json")
//   dist/**/apiClient.js   -> createRequire(import.meta.url)("../../package.json")
// createRequire resolves against the OUTPUT file, not the source, so a flat
// bundle made both miss and every call died with
// "Cannot find module '../package.json'".
//
// Nesting the output under vendor/ makes both land inside our own tree —
// ../ and ../../ from vendor/gmgn-cli/dist/ are vendor/gmgn-cli/ and vendor/ —
// so neither can collide with dist-server/ itself, where a stray package.json
// would start influencing how Node treats server.cjs.
const VENDOR = `${OUT}/vendor`;
mkdirSync(`${VENDOR}/gmgn-cli/dist`, { recursive: true });
const cliManifest = JSON.stringify({ name: 'gmgn-cli', version: cliVersion, type: 'module' }, null, 2);
writeFileSync(`${VENDOR}/gmgn-cli/package.json`, cliManifest);
writeFileSync(`${VENDOR}/package.json`, cliManifest);

await build({
  entryPoints: ['node_modules/gmgn-cli/dist/index.js'],
  outfile: `${VENDOR}/gmgn-cli/dist/index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  minify: false,
  logLevel: 'silent',
  banner: {
    // esbuild's ESM output can reference these CJS globals via shimmed deps;
    // define them so the bundle is self-sufficient under `node file.mjs`.
    js: [
      "import { createRequire as __cr } from 'module';",
      "const require = __cr(import.meta.url);",
      "import { fileURLToPath as __f2p } from 'url';",
      "import { dirname as __dn } from 'path';",
      "const __filename = __f2p(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join('\n'),
  },
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`\nbundled -> ${OUT}/server.cjs  (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`copied   -> ${OUT}/gmgn-cli-shim.cjs  (spawned, cannot be bundled)`);
console.log(`bundled  -> ${VENDOR}/gmgn-cli/dist/index.mjs  (v${cliVersion}, spawned as its own process)`);
console.log('external: nothing — node_modules is no longer shipped at all');
