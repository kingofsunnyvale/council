import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('compiled gateway loads in native Node ESM without the development TS loader', () => {
  const folder=mkdtempSync(join(tmpdir(),'council-gateway-'));
  try {
    writeFileSync(join(folder,'package.json'),'{"type":"module"}');
    const compiled=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--ignoreConfig','--outDir',folder,'--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--skipLibCheck','--types','node','api/gateway.ts','shared/config.ts'],{encoding:'utf8'});
    assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
    const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(join(folder,'api/gateway.js')).href)})`],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}});
    assert.equal(imported.status,0,imported.stdout+imported.stderr);
  } finally {rmSync(folder,{recursive:true,force:true});}
});
