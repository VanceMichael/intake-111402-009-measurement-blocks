import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collectDelivery,collectGroups,collectSamples} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function record12(recordId,time,load,mask = 0) {
  const bytes = Buffer.alloc(12);
  bytes[0] = recordId;
  bytes.writeDoubleLE(time,1);
  bytes.writeInt16LE(load,9);
  bytes[11] = mask;
  return bytes;
}

function record10(recordId,time,mask = 0) {
  const bytes = Buffer.alloc(10);
  bytes[0] = recordId;
  bytes.writeDoubleLE(time,1);
  bytes[9] = mask;
  return bytes;
}

function group12(overrides = {}) {
  return {
    recordId:1,recordSize:12,master:'time',
    channels:[
      {name:'time',offset:1,type:'float64',conversion:null},
      {name:'load',offset:9,type:'int16',invalidationBit:0,conversion:'c1'}
    ],
    invalidationOffset:11,
    ...overrides
  };
}

function group10() {
  return {recordId:2,recordSize:10,master:'time',
    channels:[{name:'time',offset:1,type:'float64',conversion:null}],invalidationOffset:9};
}

function manifestOf(fileId,revision,blocks,groups,conversions = {c1:{type:'linear',factor:0.1,offset:0}}) {
  return {fileId,revision,blocks,groups,conversions};
}

function block(id,bytes,options = {}) {
  return {id,next:options.next ?? null,compression:options.compression ?? 'none',sha256:sha256(bytes)};
}

function sourceFixture(manifest,blocks) {
  return {
    exchanges:[
      {path:'/manifest',method:'GET',body:manifest,requires:{},sets:{},status:200,query:{}},
      ...blocks.map(({id,bytes}) => ({path:`/blocks/${id}`,method:'GET',
        body:{data:bytes.toString('base64')},requires:{},sets:{},status:200,query:{}}))
    ],
    cases:{}
  };
}

async function withSource(fixture,run) {
  const directory = await mkdtemp(join(tmpdir(),'fixture-'));
  const path = join(directory,'source.json');
  await writeFile(path,JSON.stringify(fixture));
  const source = await createSource({fixture:path});
  try {return await run(createClient(source.origin));}
  finally {await source.close();await rm(directory,{recursive:true,force:true});}
}

const normalBytes = Buffer.concat([record12(1,1,10,0),record12(1,2,20,1)]);

test('按记录标识区分交织组并保留主通道时间',async () => {
  const bytes = Buffer.concat([record12(1,1,10),record10(2,1.5),record12(1,2,20,1)]);
  const manifest = manifestOf('bench','v7',[block('data1',bytes)],[group12(),group10()]);
  await withSource(sourceFixture(manifest,[{id:'data1',bytes}]),async client => {
    const delivery = await collectDelivery(client);
    assert.equal(delivery.complete,true);
    const [first,second] = delivery.groups;
    assert.equal(first.recordId,1);
    assert.equal(second.recordId,2);
    assert.deepEqual(first.samples.map(sample => sample.time),[1,2]);
    assert.deepEqual(second.samples.map(sample => sample.time),[1.5]);
    assert.equal(first.samples[0].channels.load.value,1);
    assert.equal(first.samples[0].channels.load.rawValue,10);
    // The invalidated record keeps its raw value and never becomes a zero.
    const invalid = first.samples[1];
    assert.equal(invalid.channels.load.invalidated,true);
    assert.equal(invalid.channels.load.rawValue,20);
    assert.equal(invalid.channels.load.value,null);
    assert.notEqual(invalid.channels.load.value,0);
    assert.equal(invalid.channels.load.valid,false);
    assert.equal(invalid.channels.time.valid,true);
    assert.equal(invalid.status,'invalidated');
    assert.equal(second.samples[0].channels.load,undefined);
  });
});

test('压缩块解压后仍按原字节校验并解析',async () => {
  const compressed = deflateSync(normalBytes);
  const manifest = manifestOf('bench','v2',[block('data1',compressed,{compression:'zlib'})],[group12()]);
  await withSource(sourceFixture(manifest,[{id:'data1',bytes:compressed}]),async client => {
    const delivery = await collectDelivery(client);
    assert.equal(delivery.complete,true);
    assert.equal(delivery.samples.length,2);
    assert.deepEqual(delivery.samples.map(sample => sample.time),[1,2]);
  });
});

test('链式块按 next 顺序拼接，记录可跨块边界',async () => {
  const bytes = Buffer.concat([record12(1,1,10),record12(1,2,20),record12(1,3,30)]);
  const first = bytes.subarray(0,17); // splits the second record mid-way
  const second = bytes.subarray(17);
  const blocks = [
    block('data1',first,{next:'data2'}),
    block('data2',second,{next:null})
  ];
  // Continuation block listed before its head on purpose.
  const manifest = manifestOf('bench','v4',[blocks[1],blocks[0]],[group12()]);
  await withSource(sourceFixture(manifest,[{id:'data1',bytes:first},{id:'data2',bytes:second}]),async client => {
    const delivery = await collectDelivery(client);
    assert.equal(delivery.complete,true);
    assert.deepEqual(delivery.samples.map(sample => sample.time),[1,2,3]);
    assert.deepEqual(delivery.samples[2].blockIds,['data1','data2']);
  });
});

test('缺失块只隔离受影响通道组，其他组仍可用',async () => {
  const good = record12(1,1,10);
  const blocks = [
    block('data1',good),
    block('data2',record10(2,5),{next:'missing'})
  ];
  const manifest = manifestOf('bench','v5',blocks,[group12(),group10()]);
  await withSource(sourceFixture(manifest,[{id:'data1',bytes:good},{id:'data2',bytes:record10(2,5)}]),async client => {
    const delivery = await collectDelivery(client);
    const [first,second] = delivery.groups;
    assert.equal(first.usable,true);
    assert.equal(first.samples.length,1);
    assert.equal(second.usable,false);
    assert.equal(second.status,'isolated');
    assert.match(second.reason,/missing-block/);
    assert.equal(delivery.problems.some(item => item.reason === 'missing-block'),true);
    assert.equal(delivery.complete,false);
  });
});

test('引用环被识别且不会无限读取',async () => {
  const bytes = record12(1,1,10);
  const blocks = [
    block('data1',bytes,{next:'data2'}),
    block('data2',Buffer.alloc(0),{next:'data1'})
  ];
  const manifest = manifestOf('bench','v6',blocks,[group12()]);
  await withSource(sourceFixture(manifest,[{id:'data1',bytes},{id:'data2',bytes:Buffer.alloc(0)}]),async client => {
    const delivery = await collectDelivery(client);
    assert.equal(delivery.groups[0].status,'isolated');
    assert.equal(delivery.problems.some(item => item.reason === 'block-reference-cycle'),true);
    assert.equal(delivery.samples.length,0);
  });
});

test('不支持的换算隔离所在通道，主通道与其他组不受影响',async () => {
  const bytes = Buffer.concat([record12(1,1,10),record10(2,4)]);
  const unsupported = {type:'unsupported',expression:'secret'};
  const group = group12();
  group.channels[1].conversion = 'u1';
  const manifest = manifestOf('bench','v8',[block('data1',bytes)],[group,group10()],{u1:unsupported});
  await withSource(sourceFixture(manifest,[{id:'data1',bytes}]),async client => {
    const delivery = await collectDelivery(client);
    const [first,second] = delivery.groups;
    assert.equal(first.status,'partial');
    assert.equal(first.usable,true);
    assert.equal(first.samples[0].channels.time.valid,true);
    assert.equal(first.samples[0].channels.load.usable,false);
    assert.equal(first.samples[0].channels.load.reason,'unsupported-conversion');
    assert.equal(first.samples[0].channels.load.value,null);
    assert.equal(first.samples[0].channels.load.rawValue,10);
    assert.equal(second.usable,true);
  });
});

test('校验失败只隔离使用该块的组',async () => {
  const good = record12(1,1,10);
  const bad = record12(1,2,20);
  const blocks = [
    block('data1',good),
    block('data2',bad)
  ];
  blocks[1].sha256 = sha256(Buffer.from('other'));
  const manifest = manifestOf('bench','v9',blocks,[group12(),group12({recordId:2})]);
  const altered = Buffer.from(bad);
  await withSource(sourceFixture(manifest,[{id:'data1',bytes:good},{id:'data2',bytes:altered}]),async client => {
    const delivery = await collectDelivery(client);
    assert.equal(delivery.groups[0].usable,true);
    assert.equal(delivery.groups[1].usable,false);
    assert.equal(delivery.problems.some(item => item.reason === 'checksum-mismatch'),true);
  });
});

test('收存记录可回指文件版本与具体记录',async () => {
  const directory = await mkdtemp(join(tmpdir(),'archive-ref-'));
  try {
    const manifest = manifestOf('bench','v7',[block('data1',normalBytes)],[group12()]);
    await withSource(sourceFixture(manifest,[{id:'data1',bytes:normalBytes}]),async client => {
      const delivery = await collectDelivery(client);
      const archive = new Archive(directory);
      await archive.put(delivery.samples,{source:'local',fileId:delivery.fileId,revision:delivery.revision});
      await archive.put(delivery.samples,{source:'local',fileId:delivery.fileId,revision:delivery.revision});
      const rows = await archive.list();
      assert.equal(rows.length,2);
      for (const entry of rows) {
        assert.equal(entry.fileId,'bench');
        assert.equal(entry.revision,'v7');
        assert.equal(entry.reference.recordId,1);
        assert.ok([0,1].includes(entry.reference.recordIndex));
        assert.equal(entry.row.sourceRecord.fileId,'bench');
        assert.equal(entry.row.sourceRecord.revision,'v7');
      }
      const invalid = await archive.query({fileId:'bench',revision:'v7',recordId:'1',recordIndex:'1'});
      assert.equal(invalid.length,1);
      assert.equal(invalid[0].row.channels.load.rawValue,20);
      assert.equal(invalid[0].row.channels.load.value,null);
      assert.equal(invalid[0].row.channels.load.invalidated,true);
      assert.equal((await archive.query({revision:'v6'})).length,0);
    });
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('通道组与样本入口共享同一份交付结果',async () => {
  const manifest = manifestOf('bench','v7',[block('data1',normalBytes)],[group12()]);
  await withSource(sourceFixture(manifest,[{id:'data1',bytes:normalBytes}]),async client => {
    const groups = await collectGroups(client);
    assert.equal(Array.isArray(groups),true);
    assert.equal(groups[0].recordId,1);
    assert.equal(groups.fileId,'bench');
    const samples = await collectSamples(client);
    assert.equal(samples.length,2);
    assert.equal(samples.groups[0].recordId,1);
    assert.equal(samples[1].time,2);
  });
});
