import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collectIntake,toDelivery} from './groups.mjs';
import {Archive} from './archive.mjs';
import {createApi} from './api.mjs';

const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(resolve(process.env.DATA_DIR ?? '.state'));
const api = await createApi(archive,Number(process.env.PORT ?? 4020));
console.log(JSON.stringify({source:source.origin,api:api.origin}));
try {
  const intake = await collectIntake(createClient(source.origin));
  const provenance = {
    source:source.origin,adapter:'channel-groups-v1',
    fileId:intake.fileId,revision:intake.revision,
    groups:intake.rows.map(row => ({
      recordId:row.recordId,blockId:row.blockId,chainOffset:row.chainOffset
    })),
    isolated:intake.groups.filter(group => group.status !== 'complete').map(group => ({
      recordId:group.recordId,status:group.status,issues:group.issues
    }))
  };
  const rows = [...intake.blockRows,...intake.rows];
  console.log(JSON.stringify(await archive.put(rows,provenance)));
  console.log(JSON.stringify({summary:intake.summary,fetchErrors:intake.fetchErrors,
    delivery:toDelivery(intake).groups.map(group => ({recordId:group.recordId,status:group.status,rows:group.rows.length}))}));
} catch(error) {console.error(error.message);}
let stopping = false;
const stop = async () => {if(stopping) return;stopping = true;await Promise.all([source.close(),api.close()]);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
