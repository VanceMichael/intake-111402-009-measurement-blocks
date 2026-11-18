import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collectDelivery} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const source = await createSource({scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const api = await createApi(archive);
try {
  console.log('本地来源',source.origin);
  const delivery = await collectDelivery(createClient(source.origin));
  const provenance = {source:source.origin,adapter:'channel-groups',fileId:delivery.fileId,revision:delivery.revision};
  const blocks = await archive.put(delivery.blocks,{...provenance,kind:'block'});
  const samples = await archive.put(delivery.samples,{...provenance,kind:'sample'});
  console.log('文件版本',`${delivery.fileId}@${delivery.revision}`,'完整',delivery.complete);
  console.log('通道组',JSON.stringify(delivery.groups.map(group => ({recordId:group.recordId,status:group.status,
    reason:group.reason,records:group.recordCount,channels:group.channels.map(channel => ({name:channel.name,status:channel.status}))}))));
  console.log('实际收件',JSON.stringify({blocks,samples}));
  const response = await fetch(`${api.origin}/records?fileId=${encodeURIComponent(delivery.fileId)}&revision=${encodeURIComponent(delivery.revision)}`);
  const stored = await response.json();
  console.log('查询收件',JSON.stringify(stored.map(entry => ({id:entry.row.id,
    recordId:entry.reference?.recordId,recordIndex:entry.reference?.recordIndex,status:entry.row.status}))));
  console.log('来源交互',JSON.stringify(await createClient(source.origin)('/__audit')));
} finally {await Promise.all([source.close(),api.close()]);await rm(directory,{recursive:true,force:true});}
