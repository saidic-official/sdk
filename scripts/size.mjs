// The size check of section 51.8: @saidic/sdk, minified and compressed, is at most
// 15 KB, as an app bundles it. Run by `npm run size` and the CI gate.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const MOST = 15 * 1024;
const result = await build({
  entryPoints: [new URL('../packages/sdk/src/index.ts', import.meta.url).pathname],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2020',
  write: false,
});
const code = result.outputFiles[0].contents;
const compressed = gzipSync(code, { level: 9 }).length;
console.log(
  `@saidic/sdk: ${code.length} bytes minified, ${compressed} bytes compressed (at most ${MOST}).`
);
if (compressed > MOST) {
  console.error('Too large: the SDK must stay at most 15 KB minified and compressed.');
  process.exit(1);
}
