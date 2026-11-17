// Where the built-in model's files come from: the Transformers.js settings
// for each load, and what a finished download leaves in the cache. Kept out
// of engine.js, which loads Transformers.js itself, so the background script
// and the tests can use it too.

export const CACHE_NAME = 'transformers-cache';

// A model's files at its pinned commit. Transformers.js keys the cache by
// these addresses.
export function fileBase(model) {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/`;
}

// Transformers.js settings for loading a model. Every file comes from the
// pinned commit, including the ones Transformers.js 4.3 looks up without a
// revision (pipeline()'s file list and the tokenizer's check for its files),
// which would otherwise ask the network for the repository's latest commit.
//
// With cacheOnly nothing is fetched, and files come from the cache or not at
// all. Transformers.js reads the cache before anything else, but it refuses
// to start with local and remote files both turned off, so local files stay
// on. Their path is inside the extension, which holds no model files.
export function hubSettings(model, { cacheOnly = false } = {}) {
  return {
    remotePathTemplate: `{model}/resolve/${model.revision}/`,
    allowRemoteModels: !cacheOnly,
    allowLocalModels: cacheOnly,
  };
}

// Whether the cached addresses hold a whole download of a model for this
// dtype: its config, its tokenizer, and weights in that dtype. Checked before
// a cache-only load, because Transformers.js remembers a missing tokenizer for
// as long as the page lives, and a later download there would fail too.
// Both built-in models keep each part's weights in an .onnx_data file beside
// its .onnx, so a part missing either one is not whole.
export function hasModelFiles(urls, model, dtype) {
  const base = fileBase(model);
  const files = new Set(urls.filter((u) => u.startsWith(base)).map((u) => u.slice(base.length)));
  const graphs = [...files].filter((f) => f.startsWith('onnx/') && f.endsWith(`_${dtype}.onnx`));
  const weights = graphs.length > 0 && graphs.every((f) => files.has(`${f}_data`));
  return weights && ['config.json', 'tokenizer.json', 'tokenizer_config.json'].every((f) => files.has(f));
}
