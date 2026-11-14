import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('compressed');
const manifest = await client('/manifest');
assert.equal(manifest.blocks[0].compression,'zlib');
const {inflateSync} = await import('node:zlib');
const bytes = inflateSync(Buffer.from((await client('/blocks/data1')).data,'base64'));
assert.equal(bytes[11],0);
assert.equal(bytes[23],1);
assert.equal(manifest.groups[0].channels[1].invalidationBit,0);
} finally {await source.close();}
});
