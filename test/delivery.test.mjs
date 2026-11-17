import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collectIntake,readChannelGroups} from '../src/groups.mjs';
import {collect} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';

async function withSource(name,run) {
  const source = await createSource({scenario:name});
  try {return await run(createClient(source.origin),source);}
  finally {await source.close();}
}

test('分组投递按记录回指文件版本与来源位置',async () => {
  const directory = await mkdtemp(join(tmpdir(),'delivery-'));
  try {
    const archive = new Archive(directory);
    const intake = await withSource('interleaved',client => collectIntake(client));
    const provenance = {
      source:'local',adapter:'channel-groups-v1',
      fileId:intake.fileId,revision:intake.revision
    };
    const result = await archive.put([...intake.blockRows,...intake.rows],provenance);
    assert.equal(result.added,4);
    assert.equal(result.deliveryAdded,3);

    const delivery = await archive.delivery();
    assert.equal(delivery.length,1);
    assert.equal(delivery[0].fileId,'bench1');
    assert.equal(delivery[0].revision,'v3');
    assert.deepEqual(delivery[0].groups.map(group => group.recordId),[1,2]);
    const slow = delivery[0].groups.find(group => group.recordId === 2);
    assert.equal(slow.rowCount,1);
    assert.deepEqual(slow.blocks,['data1']);
    for (const group of delivery[0].groups) {
      for (const row of group.rows) {
        assert.equal(row.ref,`bench1:v3:${group.recordId}:${row.recordIndex}`);
        assert.equal(row.source.fileId,'bench1');
        assert.equal(row.source.revision,'v3');
        assert.equal(row.source.recordId,group.recordId);
        assert.ok(row.source.blockId);
        assert.ok(Number.isInteger(row.chainOffset));
      }
    }

    // Re-receiving the same source bytes stays idempotent.
    const again = await archive.put([...intake.blockRows,...intake.rows],provenance);
    assert.equal(again.added,0);
    assert.equal(again.deliveryAdded,0);
    assert.equal((await new Archive(directory).list()).length,4);
    assert.equal((await new Archive(directory).delivery()).length,1);

    const api = await createApi(archive);
    try {
      const response = await fetch(`${api.origin}/delivery`);
      const body = await response.json();
      assert.equal(body[0].revision,'v3');
      assert.equal(body[0].groups.length,2);
    } finally {await api.close();}
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('原始块收件仍附带分组结果且不改变归档形状',async () => {
  const directory = await mkdtemp(join(tmpdir(),'reader-groups-'));
  try {
    const rows = await withSource('normal',client => collect(client));
    assert.equal(rows.length,1);
    assert.equal(rows[0].blockId,'data1');
    assert.equal(rows.groups.length,1);
    assert.equal(rows.rows.length,2);
    assert.equal(rows.rows[1].values.load,null);
    assert.equal(rows.summary.rows,2);
    // The attached diagnostics are not part of the archived row payload.
    assert.deepEqual(Object.keys(rows[0]).sort(),['blockId','data','id','sha256']);
    const archive = new Archive(directory);
    await archive.put(rows,{source:'local'});
    assert.equal((await archive.list()).length,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('隔离的组不会以零值行进入收存',async () => {
  const directory = await mkdtemp(join(tmpdir(),'isolated-'));
  try {
    const intake = await withSource('bad-reference',client => collectIntake(client));
    assert.equal(intake.rows.length,0);
    assert.equal(intake.groups[0].status,'isolated');
    const archive = new Archive(directory);
    await archive.put(intake.rows,{source:'local',adapter:'channel-groups-v1'});
    assert.equal((await archive.list()).length,0);
    assert.deepEqual(await archive.delivery(),[]);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('多次运行不同版本分别回指各自修订',async () => {
  const directory = await mkdtemp(join(tmpdir(),'versions-'));
  try {
    const archive = new Archive(directory);
    for (const name of ['normal','compressed']) {
      const intake = await withSource(name,client => readChannelGroups(client));
      await archive.put(intake.rows,{source:'local',adapter:'channel-groups-v1',fileId:intake.fileId,revision:intake.revision});
    }
    const delivery = await archive.delivery();
    assert.deepEqual(delivery.map(file => file.revision),['v1','v2']);
    assert.equal(delivery[0].groups[0].rows[0].values.load,1);
    assert.equal(delivery[1].groups[0].rows[0].values.load,1);
    assert.equal(delivery[1].groups[0].rows[1].values.load,null);
  } finally {await rm(directory,{recursive:true,force:true});}
});
