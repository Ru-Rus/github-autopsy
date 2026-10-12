const fs = require("node:fs");
const path = require("node:path");
const { Module, createRequire } = require("node:module");
const ts = require("typescript");
function context() {
  const cache = new Map();
  function load(name, mocks = {}) {
    const file = path.resolve(__dirname, "..", name);
    if (cache.has(file)) return cache.get(file).exports;
    const loaded = new Module(file, module);
    cache.set(file, loaded);
    loaded.filename = file;
    loaded.require = (specifier) =>
      Object.hasOwn(mocks, specifier)
        ? mocks[specifier]
        : specifier.startsWith(".") &&
            fs.existsSync(path.resolve(path.dirname(file), specifier + ".ts"))
          ? load(
              path.relative(
                path.resolve(__dirname, ".."),
                path.resolve(path.dirname(file), specifier + ".ts"),
              ),
              mocks,
            )
          : createRequire(file)(specifier);
    loaded._compile(
      ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
      file,
    );
    return loaded.exports;
  }
  return { load };
}
module.exports = { context };
