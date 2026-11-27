/**
 * electron-builder leaves node_modules out of extraResources whatever the filter says, so
 * copy the staged amem dependencies in here. afterPack runs before signing, so the SQLite
 * binding is signed with the rest of the app.
 */
const { cpSync, existsSync } = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const from = path.join(__dirname, "..", "build", "amem", "node_modules");
  if (!existsSync(from)) throw new Error("build/amem/node_modules is missing — run npm run stage first");
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  cpSync(from, path.join(resources, "amem", "node_modules"), { recursive: true });
};
