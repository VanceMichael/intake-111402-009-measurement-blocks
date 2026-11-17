import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collectIntake,toDelivery} from '../src/groups.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const source = await createSource({scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const api = await createApi(archive);
try {
  console.log('本地来源',source.origin);
  const intake = await collectIntake(createClient(source.origin));
  const provenance = {
    source:source.origin,adapter:'channel-groups-v1',
    fileId:intake.fileId,revision:intake.revision,
    groups:intake.rows.map(row => ({recordId:row.recordId,blockId:row.blockId,chainOffset:row.chainOffset})),
    isolated:intake.groups.filter(group => group.status !== 'complete').map(group => ({
      recordId:group.recordId,status:group.status,issues:group.issues
    }))
  };
  console.log('实际收件',JSON.stringify(await archive.put([...intake.blockRows,...intake.rows],provenance)));
  console.log('分组交付',JSON.stringify(toDelivery(intake).groups.map(group => ({
    recordId:group.recordId,status:group.status,
    rows:group.rows.length,isolated:group.isolatedChannels.map(channel => channel.name)
  }))));
  console.log('版本索引',JSON.stringify((await archive.delivery()).map(file => ({
    fileId:file.fileId,revision:file.revision,
    groups:file.groups.map(group => ({recordId:group.recordId,rowCount:group.rowCount,blocks:group.blocks}))
  }))));
  const response = await fetch(`${api.origin}/delivery`);
  console.log('查询分组结果',await response.text());
  console.log('来源交互',JSON.stringify(await createClient(source.origin)('/__audit')));
} finally {await Promise.all([source.close(),api.close()]);await rm(directory,{recursive:true,force:true});}
