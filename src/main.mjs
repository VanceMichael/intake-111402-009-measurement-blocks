import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collectDelivery} from './reader.mjs';
import {Archive} from './archive.mjs';
import {createApi} from './api.mjs';

const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(resolve(process.env.DATA_DIR ?? '.state'));
const api = await createApi(archive,Number(process.env.PORT ?? 4020));
console.log(JSON.stringify({source:source.origin,api:api.origin}));
try {
  const delivery = await collectDelivery(createClient(source.origin));
  const provenance = {source:source.origin,adapter:'channel-groups',fileId:delivery.fileId,revision:delivery.revision};
  // The verified original block bytes stay archived as their own rows, and the
  // channel-group samples are archived with a reference back to the record.
  const blocks = await archive.put(delivery.blocks,{...provenance,kind:'block'});
  const samples = await archive.put(delivery.samples,{...provenance,kind:'sample'});
  console.log(JSON.stringify({fileId:delivery.fileId,revision:delivery.revision,complete:delivery.complete,
    blocks,samples,groups:delivery.groups.map(group => ({recordId:group.recordId,status:group.status,
      reason:group.reason,records:group.recordCount})),problems:delivery.problems}));
} catch(error) {console.error(error.message);}
let stopping = false;
const stop = async () => {if(stopping) return;stopping = true;await Promise.all([source.close(),api.close()]);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
