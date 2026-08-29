/**
 * Put the app's icon and version strings into the packaged .exe.
 *
 * WHY THIS EXISTS AT ALL. electron-builder normally does this itself, through
 * rcedit, as part of `signAndEditExecutable`. That flag is `false` in
 * package.json, and it has to stay false: turning it on makes electron-builder
 * fetch and unpack its `winCodeSign` bundle, which contains macOS symlinks
 * (libcrypto.dylib, libssl.dylib). Creating a symlink on Windows needs either
 * admin rights or Developer Mode, so the extraction dies with
 *
 *     ERROR: Cannot create symbolic link : A required privilege is not held
 *
 * and takes the whole build with it. Measured, not guessed -- that is exactly
 * what happened when the flag was flipped to true.
 *
 * The cost of leaving it false was invisible and shipped for months: rcedit
 * never ran, so the executable kept **Electron's default atom icon** and none
 * of the product metadata. The app had a perfectly good icon at
 * build/icon.ico that nothing ever read.
 *
 * So the edit is done here instead -- after the app is packed, before the
 * installer and portable targets wrap it -- which gets the icon without
 * pulling in the signing toolchain.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/**
 * Find rcedit inside electron-builder's own cache.
 *
 * Deliberately searched rather than hardcoded: the cache directory is named
 * after a content hash and changes whenever the toolchain is updated, so a
 * literal path would work until it silently did not.
 */
function findRcedit() {
  const base = path.join(
    process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'),
    'electron-builder', 'Cache', 'winCodeSign',
  );
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base)) {
    const candidate = path.join(base, dir, 'rcedit-x64.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icon = path.join(__dirname, 'icon.ico');

  if (!fs.existsSync(exe)) throw new Error(`afterPack: no executable at ${exe}`);
  if (!fs.existsSync(icon)) throw new Error(`afterPack: no icon at ${icon}`);

  const rcedit = findRcedit();
  if (!rcedit) {
    // LOUD, not silent. A missing icon is precisely the kind of defect that
    // ships unnoticed -- nobody reads the exe's icon in a diff, and the app
    // looks fine until it is sitting in a taskbar wearing Electron's logo.
    throw new Error(
      'afterPack: rcedit not found in the electron-builder cache. Run any ' +
      'build once with network access to populate it, or the packaged app ' +
      'will keep Electron\'s default icon.',
    );
  }

  const version = context.packager.appInfo.version;
  execFileSync(rcedit, [
    exe,
    '--set-icon', icon,
    '--set-file-version', version,
    '--set-product-version', version,
    '--set-version-string', 'ProductName', 'intel. Command Deck',
    '--set-version-string', 'FileDescription', 'intel. Command Deck',
    '--set-version-string', 'CompanyName', 'intel.',
  ], { stdio: 'inherit' });

  console.log(`  • afterPack: icon and version strings written into ${path.basename(exe)}`);
};
