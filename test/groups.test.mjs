import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {readChannelGroups,collectGroupRows,extractChannelGroups,describeGroups} from '../src/groups.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function record12(time,load,invalidation = 0) {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt8(1,0);
  bytes.writeDoubleLE(time,1);
  bytes.writeInt16LE(load,9);
  bytes[11] = invalidation;
  return bytes;
}
function record10(time) {
  const bytes = Buffer.alloc(10);
  bytes.writeUInt8(2,0);
  bytes.writeDoubleLE(time,1);
  return bytes;
}

const conversions = {c1:{type:'linear',factor:0.1,offset:0}};
const groups = [
  {recordId:1,recordSize:12,master:'time',channels:[
    {name:'time',offset:1,type:'float64',conversion:null},
    {name:'load',offset:9,type:'int16',invalidationBit:0,conversion:'c1'}
  ],invalidationOffset:11},
  {recordId:2,recordSize:10,master:'time',channels:[
    {name:'time',offset:1,type:'float64',conversion:null}
  ],invalidationOffset:9}
];
const manifestOf = (blocks,overrides = {}) => ({fileId:'f',revision:'r',blocks,groups,conversions,...overrides});

async function withScenario(name,run) {
  const source = await createSource({scenario:name});
  try {return await run(createClient(source.origin),source);}
  finally {await source.close();}
}

test('普通场景分离主通道时间、原始值、换算引用与失效位',async () => {
  const result = await withScenario('normal',client => readChannelGroups(client));
  assert.equal(result.rows.length,2);
  const [first,second] = result.rows;
  assert.equal(first.time,1);
  assert.equal(first.master,'time');
  assert.equal(first.raw.load,10);
  assert.equal(first.values.load,1);
  assert.equal(first.channels.find(channel => channel.name === 'load').conversion,'c1');
  assert.equal(first.valid,true);
  // The second sample has its invalidation bit set: raw stays visible, the
  // converted value must be null rather than a fabricated zero.
  assert.equal(second.raw.load,20);
  assert.equal(second.values.load,null);
  assert.notEqual(second.values.load,0);
  assert.equal(second.valid,false);
  assert.deepEqual(second.invalidChannels,['load']);
  assert.equal(second.masterValid,true);
});

test('压缩块按实际字节校验后解码并保留原字节',async () => {
  const result = await withScenario('compressed',client => readChannelGroups(client));
  assert.equal(result.revision,'v2');
  assert.equal(result.blocks[0].compression,'zlib');
  assert.equal(result.blocks[0].status,'complete');
  assert.equal(result.rows.length,2);
  assert.equal(result.rows[0].values.load,1);
});

test('交织组按来源记录标识拆分而非按固定宽度',async () => {
  const result = await withScenario('interleaved',client => readChannelGroups(client));
  assert.deepEqual(result.groups.map(group => group.recordId),[1,2]);
  assert.deepEqual(result.groups.map(group => group.rowCount),[2,1]);
  assert.equal(result.rows.length,3);
  const slow = result.rows[2];
  assert.equal(slow.recordId,2);
  assert.equal(slow.time,3);
  assert.deepEqual(Object.keys(slow.values),['time']);
  assert.equal(slow.values.load,undefined);
});

test('链式块跨块拼接收件，跨越块的记录仍可解析',async () => {
  const plain = await withScenario('chained',client => readChannelGroups(client));
  assert.deepEqual(plain.chains[0].blockIds,['data1','data2']);
  assert.equal(plain.chains[0].status,'complete');
  assert.deepEqual(plain.rows.map(row => [row.time,row.values.load]),[[1,1],[2,null],[3,undefined]]);

  // Put the block boundary in the middle of the first record.
  const bytes = Buffer.concat([record12(1,10,0),record12(2,20,1),record10(3)]);
  const split = manifestOf([
    {id:'data1',next:'data2',compression:'none',sha256:sha(bytes.subarray(0,9))},
    {id:'data2',next:null,compression:'none',sha256:sha(bytes.subarray(9))}
  ]);
  const result = extractChannelGroups(split,new Map([
    ['data1',bytes.subarray(0,9)],['data2',bytes.subarray(9)]
  ]));
  assert.equal(result.summary.completeGroups,2);
  assert.deepEqual(result.rows[0].blockIds,['data1','data2']);
  assert.deepEqual(result.rows[0].blockIds.length,2);
  assert.equal(result.rows[1].blockIds[0],'data2');
});

test('引用环终止并隔离受影响记录，不悬挂进程',async () => {
  const result = await withScenario('reference-cycle',client => readChannelGroups(client));
  assert.equal(result.chains[0].status,'broken');
  assert.ok(result.chains[0].issues.some(problem => problem.type === 'reference-cycle'));
  assert.equal(result.rows.length,0);
  assert.ok(result.groups.every(group => group.status === 'isolated'));
});

test('缺块只隔离依赖该链的组，其他完整组仍可用',async () => {
  const result = await withScenario('missing-block',client => readChannelGroups(client));
  const byRecord = new Map(result.groups.map(group => [group.recordId,group]));
  assert.equal(byRecord.get(1).status,'isolated');
  assert.ok(byRecord.get(1).issues.some(problem => problem.type === 'incomplete-block-chain'));
  assert.equal(byRecord.get(2).status,'complete');
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].recordId,2);
  assert.equal(result.rows[0].time,3);
});

test('不支持的换算隔离通道而保留同组其他通道',async () => {
  const result = await withScenario('unsupported-conversion',client => readChannelGroups(client));
  const group = result.groups.find(entry => entry.recordId === 1);
  assert.equal(group.status,'partial');
  assert.equal(group.isolatedChannels.length,1);
  assert.equal(group.isolatedChannels[0].name,'load');
  assert.equal(group.isolatedChannels[0].reason,'unsupported-conversion');
  const row = result.rows.find(entry => entry.recordId === 1);
  assert.equal(row.values.load,null);
  assert.equal(row.values.time,1);
  assert.equal(row.raw.load,null);
  assert.deepEqual(row.omittedChannels,['load']);
  assert.equal(row.channels.find(channel => channel.name === 'load').reason,'unsupported-conversion');
  const untouched = result.groups.find(entry => entry.recordId === 2);
  assert.equal(untouched.status,'complete');
  assert.equal(untouched.rowCount,1);
});

test('校验失败的块不产出样本，且错误可见',async () => {
  const bytes = record12(1,10,0);
  const manifest = manifestOf([{id:'data1',next:null,compression:'none',sha256:sha(bytes)}]);
  const result = extractChannelGroups(manifest,new Map([['data1',record12(9,99,0)]]));
  assert.equal(result.rows.length,0);
  assert.equal(result.groups[0].status,'isolated');
  assert.equal(result.blocks[0].status,'unavailable');
  assert.ok(result.blocks[0].issues.some(problem => problem.type === 'block-checksum-mismatch'));
});

test('远程领取失败时其余组继续交付',async () => {
  const first = record12(1,10,0);
  const second = record10(5);
  const manifest = manifestOf([
    {id:'data1',next:null,compression:'none',sha256:sha(first)},
    {id:'data2',next:null,compression:'zlib',sha256:sha(deflateSync(second))}
  ]);
  const client = async path => {
    if (path === '/manifest') return manifest;
    if (path === '/blocks/data1') return {data:first.toString('base64')};
    throw Object.assign(new Error('source HTTP 404'),{status:404});
  };
  const result = await readChannelGroups(client);
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].recordId,1);
  assert.equal(result.groups.find(group => group.recordId === 1).status,'complete');
  assert.equal(result.groups.find(group => group.recordId === 2).status,'isolated');
  assert.equal(result.fetchErrors.length,1);
  assert.equal(result.fetchErrors[0].blockId,'data2');
  assert.equal(result.fetchErrors[0].status,404);
});

test('行标识回指文件版本与具体来源记录',async () => {
  const rows = await withScenario('interleaved',client => collectGroupRows(client));
  for (const row of rows) {
    assert.equal(row.id,`bench1:v3:${row.recordId}:${row.recordIndex}`);
    assert.equal(row.fileId,'bench1');
    assert.equal(row.revision,'v3');
    assert.equal(row.source.fileId,'bench1');
    assert.equal(row.source.revision,'v3');
    assert.equal(row.source.recordId,row.recordId);
    assert.ok(row.source.blockId);
  }
  assert.equal(rows.groups.length,2);
  assert.equal(rows.summary.rows,3);
});

test('主通道自身失效时保留行但时间标记为不可用',async () => {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt8(3,0);
  bytes.writeDoubleLE(7,1);   // time
  bytes.writeInt16LE(42,9);   // value
  bytes[11] = 1;              // time invalid bit
  bytes[19] = 1;              // value invalid bit
  const manifest = {
    fileId:'f',revision:'r',
    blocks:[{id:'a',next:null,compression:'none',sha256:sha(bytes)}],
    groups:[{recordId:3,recordSize:20,master:'time',channels:[
      {name:'time',offset:1,type:'float64',invalidationBit:0,conversion:null},
      {name:'value',offset:9,type:'int16',invalidationBit:0,conversion:null}
    ],invalidationOffset:11},
    {recordId:4,recordSize:20,master:'time',channels:[
      {name:'time',offset:1,type:'float64',invalidationBit:7,conversion:null}
    ],invalidationOffset:11}],
    conversions:{}
  };
  // Channel-level invalidationOffset override: "value" reads byte 19, not 11.
  manifest.groups[0].channels[1].invalidationOffset = 19;
  const result = extractChannelGroups(manifest,{'a':bytes});
  const row = result.rows.find(entry => entry.recordId === 3);
  assert.equal(row.time,null);
  assert.equal(row.masterValid,false);
  assert.equal(row.values.value,null);
  assert.deepEqual(row.invalidChannels.sort(),['time','value']);
  assert.equal(row.raw.value,42);
  // Only record 3 is in the stream; record 4 is declared but empty.
  assert.equal(result.groups.find(group => group.recordId === 4).status,'empty');
});

test('重复记录标识声明时两组都隔离，不猜宽度',async () => {
  const bytes = record12(1,10,0);
  const manifest = manifestOf([{id:'a',next:null,compression:'none',sha256:sha(bytes)}],{
    groups:[groups[0],{...groups[1],recordId:1}]
  });
  const result = extractChannelGroups(manifest,{'a':bytes});
  assert.equal(result.rows.length,0);
  assert.ok(result.groups[0].issues.some(problem => problem.type === 'duplicate-record-id'));
  assert.ok(result.groups[1].issues.some(problem => problem.type === 'duplicate-record-id'));
});

test('未知记录号和截断记录不会产出猜测的行',async () => {
  const bytes = Buffer.alloc(6);
  bytes.writeUInt8(9,0);
  const manifest = manifestOf([{id:'a',next:null,compression:'none',sha256:sha(bytes)}]);
  const unknown = extractChannelGroups(manifest,{'a':bytes});
  assert.equal(unknown.rows.length,0);
  assert.equal(unknown.chains[0].status,'broken');
  assert.ok(unknown.chains[0].issues.some(problem => problem.type === 'unknown-record-id'));

  const partial = record12(1,1,0).subarray(0,8);
  const truncated = manifestOf([{id:'a',next:null,compression:'none',sha256:sha(partial)}]);
  const result = extractChannelGroups(truncated,{'a':partial});
  assert.equal(result.rows.length,0);
  assert.ok(result.chains[0].issues.some(problem => problem.type === 'truncated-record'));
  assert.equal(result.groups[0].status,'isolated');
});

test('组声明解析不取得数据也能报告隔离通道',async () => {
  const manifest = manifestOf([],{
    conversions:{c1:{type:'unsupported'}},
    groups:[{...groups[0],channels:[...groups[0].channels,{name:'bad',offset:100,type:'int16'}]}]
  });
  const described = describeGroups(manifest);
  assert.equal(described[0].isolatedChannels.length,2);
  assert.deepEqual(described[0].isolatedChannels.map(channel => channel.reason).sort(),
    ['channel-outside-record','unsupported-conversion']);
});
