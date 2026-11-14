import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('原始块收件校验实际字节', async () => {
  const rows = await collect(client);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blockId, 'data1');
  assert.equal(Buffer.from(rows[0].data,'base64').length, 24);
});
