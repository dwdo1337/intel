/**
 * Launcher for gmgn-cli, needed only because the app is an Electron build.
 *
 * THE PROBLEM
 * When packaged, the backend runs as `electron.exe --run-as-node`, so
 * process.execPath is the Electron binary and every child it spawns is also
 * Electron-in-node-mode. argv is correct in that mode:
 *   [electron.exe, script.js, token, info, --chain, sol]
 * but gmgn-cli parses arguments with `commander`, and commander special-cases
 * Electron: seeing process.versions.electron and no process.defaultApp, it
 * treats the process as a PACKAGED Electron app, where argv has no script
 * path, and so slices from index 1 instead of 2. The script path is then read
 * as a command name and every call dies with:
 *   error: unknown command '...\gmgn-cli\dist\index.js'
 *
 * This failed ONLY in the packaged build. In development the backend runs on
 * real node, process.versions.electron is undefined, and commander parses
 * normally -- which is why every GMGN feature worked in dev and silently
 * returned nothing in the .exe.
 *
 * THE FIX
 * Convince commander it is plain node before handing over. Removing the
 * electron version is the narrowest change that does that: it affects only
 * this short-lived child process, which does nothing but run the CLI.
 */

try { delete process.versions.electron; } catch (_) {}
// Belt and braces: if the delete is ever blocked, defaultApp makes commander
// slice from index 2, which is also correct for our argv shape.
try { process.defaultApp = true; } catch (_) {}

const path = require('path');
const { pathToFileURL } = require('url');

const target = process.argv[2];
if (!target) {
  console.error('gmgn-cli-shim: no CLI entry path given');
  process.exit(2);
}

// Drop our own path from argv so the CLI sees exactly what it would have from
// a normal `node cli.js ...` invocation.
process.argv = [process.argv[0], target, ...process.argv.slice(3)];

// gmgn-cli ships as an ES module, so require() throws ERR_REQUIRE_ESM.
// pathToFileURL matters on Windows: import() of a bare "C:\..." path is not a
// valid URL and fails.
import(pathToFileURL(path.resolve(target)).href).catch(err => {
  console.error('gmgn-cli-shim: failed to load CLI:', err && err.message);
  process.exit(3);
});
