// Copies third-party code into src/vendor/:
//   transformers/  Transformers.js (browser build, which bundles ONNX Runtime
//                  Web's JavaScript) and the ONNX Runtime WebAssembly it loads
//                  for WebGPU, for the built-in model.
//   katex/         KaTeX and its fonts, for math in answers.
//   highlight/     highlight.js (common languages), for code in answers.
// Extensions may not load code from the network, so these ship inside the
// package; only model weights (data) are downloaded at run time.
//
// Runs on npm install; the copies are git-ignored and come from the pinned
// versions in package.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'src', 'vendor');
const NM = path.join(ROOT, 'node_modules');
const TJS = path.join(NM, '@huggingface', 'transformers');
const ORT = path.join(NM, 'onnxruntime-web');
const KATEX = path.join(NM, 'katex');
const HLJS = path.join(NM, '@highlightjs', 'cdn-assets');

const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

// The browser uses each KaTeX font's woff2 file, listed first in its CSS, so
// the woff and ttf copies stay out of the package.
const katexFonts = fs.existsSync(KATEX)
  ? fs
      .readdirSync(path.join(KATEX, 'dist', 'fonts'))
      .filter((f) => f.endsWith('.woff2'))
      .map((f) => [path.join(KATEX, 'dist', 'fonts', f), path.join('fonts', f)])
  : [];

const GROUPS = [
  {
    dir: 'transformers',
    from: TJS,
    files: [
      [path.join(TJS, 'dist', 'transformers.min.js'), 'transformers.min.js'],
      [path.join(ORT, 'dist', 'ort-wasm-simd-threaded.asyncify.mjs'), 'ort-wasm-simd-threaded.asyncify.mjs'],
      [path.join(ORT, 'dist', 'ort-wasm-simd-threaded.asyncify.wasm'), 'ort-wasm-simd-threaded.asyncify.wasm'],
      [path.join(TJS, 'LICENSE'), 'LICENSE-transformers.txt'],
    ],
    notice: () => `# Third-party code in this folder

- transformers.min.js: Transformers.js ${version(TJS)} by Hugging Face, Apache License 2.0
  (LICENSE-transformers.txt). https://github.com/huggingface/transformers.js
- ort-wasm-simd-threaded.asyncify.mjs / .wasm: ONNX Runtime Web ${version(ORT)} by
  Microsoft, MIT License. https://github.com/microsoft/onnxruntime

Copied unmodified from the npm packages by scripts/vendor.mjs.
`,
  },
  {
    dir: 'katex',
    from: KATEX,
    files: [
      [path.join(KATEX, 'dist', 'katex.min.js'), 'katex.min.js'],
      [path.join(KATEX, 'dist', 'katex.min.css'), 'katex.min.css'],
      [path.join(KATEX, 'LICENSE'), 'LICENSE-katex.txt'],
      ...katexFonts,
    ],
    notice: () => `# Third-party code in this folder

- katex.min.js, katex.min.css and fonts/*.woff2: KaTeX ${version(KATEX)} by Khan Academy and
  other contributors, MIT License (LICENSE-katex.txt). https://katex.org

Copied unmodified from the npm package (dist/) by scripts/vendor.mjs. Only the woff2
fonts are copied; the CSS lists them first.
`,
  },
  {
    dir: 'highlight',
    from: HLJS,
    files: [
      [path.join(HLJS, 'highlight.min.js'), 'highlight.min.js'],
      [path.join(HLJS, 'LICENSE'), 'LICENSE-highlight.txt'],
    ],
    notice: () => `# Third-party code in this folder

- highlight.min.js: highlight.js ${version(HLJS)} (common languages build) by Josh Goebel,
  Ivan Sagalaev and other contributors, BSD 3-Clause License (LICENSE-highlight.txt).
  https://highlightjs.org

Copied unmodified from the npm package @highlightjs/cdn-assets by scripts/vendor.mjs.
`,
  },
];

for (const g of GROUPS) {
  if (!fs.existsSync(g.from)) {
    console.error(`vendor: ${path.relative(NM, g.from)} is not installed; run npm install.`);
    process.exit(1);
  }
}

for (const g of GROUPS) {
  const out = path.join(VENDOR, g.dir);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const [from, to] of g.files) {
    fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
    fs.copyFileSync(from, path.join(out, to));
  }
  fs.writeFileSync(path.join(out, 'NOTICE.md'), g.notice());
  const bytes = g.files.reduce((n, [, to]) => n + fs.statSync(path.join(out, to)).size, 0);
  console.log(`vendor: copied ${g.files.length} files (${(bytes / 1e6).toFixed(1)} MB) to src/vendor/${g.dir}/`);
}
