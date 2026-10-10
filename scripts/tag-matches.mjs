// THE TAG IS THE VERSION: a publish refuses to run unless the tag it was started by
// names the version both packages carry. "v0.1.0" publishes 0.1.0; "v0.1.0-rehearsal"
// (any suffix after -rehearsal) is the same version rehearsed with npm's dry run.
//   node scripts/tag-matches.mjs v0.1.0
import { readFileSync } from 'node:fs';

const tag = process.argv[2] || process.env.GITHUB_REF_NAME || '';
const match = /^v(\d+\.\d+\.\d+)(-rehearsal.*)?$/.exec(tag);
if (!match) {
  console.error(`"${tag}" is not a release tag: vMAJOR.MINOR.PATCH, or with -rehearsal after it`);
  process.exit(1);
}
const wanted = match[1];
const read = name =>
  JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'));
// npm's provenance check refuses a package whose repository is not the GitHub repository
// the workflow ran in (a 422 at the registry, which a dry run never reaches): asked here,
// so a rehearsal fails on it too.
const REPOSITORY = 'git+https://github.com/saidic-official/sdk.git';
const misplaced = ['sdk', 'server']
  .map(name => [name, read(name).repository || {}])
  .filter(([name, at]) => at.url !== REPOSITORY || at.directory !== `packages/${name}`);
if (misplaced.length) {
  for (const [name, at] of misplaced)
    console.error(
      `packages/${name}: repository is ${JSON.stringify(at)}, not ${REPOSITORY} at packages/${name}`
    );
  process.exit(1);
}
const differ = ['sdk', 'server']
  .map(name => [read(name).name, read(name).version])
  .filter(([, version]) => version !== wanted);
if (differ.length) {
  for (const [name, version] of differ)
    console.error(`${name} is ${version}, the tag is ${wanted}`);
  process.exit(1);
}
console.log(
  `${tag}: both packages are ${wanted}${match[2] ? ' (a rehearsal: nothing is published)' : ''}`
);
