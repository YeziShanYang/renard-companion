// Copies the on-device model engine into src/vendor/transformers/:
// Transformers.js (browser build, which bundles ONNX Runtime Web's JavaScript)
// and the ONNX Runtime WebAssembly it loads for WebGPU. Extensions may not
// load code from the network, so these ship inside the package; only model
// weights (data) are downloaded at run time.
//
// Runs on npm install; the copies are git-ignored and come from the pinned
// versions in package.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'vendor', 'transformers');
const TJS = path.join(ROOT, 'node_modules', '@huggingface', 'transformers');
const ORT = path.join(ROOT, 'node_modules', 'onnxruntime-web');

const FILES = [
  [path.join(TJS, 'dist', 'transformers.min.js'), 'transformers.min.js'],
  [path.join(ORT, 'dist', 'ort-wasm-simd-threaded.asyncify.mjs'), 'ort-wasm-simd-threaded.asyncify.mjs'],
  [path.join(ORT, 'dist', 'ort-wasm-simd-threaded.asyncify.wasm'), 'ort-wasm-simd-threaded.asyncify.wasm'],
  [path.join(TJS, 'LICENSE'), 'LICENSE-transformers.txt'],
];

if (!fs.existsSync(TJS)) {
  console.error('vendor: @huggingface/transformers is not installed; run npm install.');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [from, to] of FILES) fs.copyFileSync(from, path.join(OUT, to));

const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
fs.writeFileSync(
  path.join(OUT, 'NOTICE.md'),
  `# Third-party code in this folder

- transformers.min.js: Transformers.js ${version(TJS)} by Hugging Face, Apache License 2.0
  (LICENSE-transformers.txt). https://github.com/huggingface/transformers.js
- ort-wasm-simd-threaded.asyncify.mjs / .wasm: ONNX Runtime Web ${version(ORT)} by
  Microsoft, MIT License. https://github.com/microsoft/onnxruntime

Copied unmodified from the npm packages by scripts/vendor.mjs.
`,
);
const bytes = FILES.reduce((n, [, to]) => n + fs.statSync(path.join(OUT, to)).size, 0);
console.log(`vendor: copied ${FILES.length} files (${(bytes / 1e6).toFixed(1)} MB) to src/vendor/transformers/`);
