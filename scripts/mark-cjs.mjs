// The CommonJS build's folder says it is CommonJS, so Node and TypeScript read its .js and
// .d.ts as such inside a package whose own type is module (the dual package's layout).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

writeFileSync(join(process.argv[2], 'package.json'), '{ "type": "commonjs" }\n');
