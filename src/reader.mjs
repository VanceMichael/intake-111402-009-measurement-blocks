import {createHash} from 'node:crypto';
import {extractChannelGroups} from './groups.mjs';

function attach(rows,result) {
  const metadata = {
    fileId:result.fileId,
    revision:result.revision,
    groups:result.groups,
    blocks:result.blocks,
    chains:result.chains,
    issues:result.issues,
    summary:result.summary,
    rows:result.rows,
    channelRows:result.rows,
    result
  };
  for (const [key,value] of Object.entries(metadata)) {
    Object.defineProperty(rows,key,{value,enumerable:false,configurable:true});
  }
  return rows;
}

/**
 * Raw-block intake. Each row is one source block; the checksum is verified
 * against the bytes actually received before the row is returned. Channel
 * group results are attached to the returned array (non-enumerably) so callers
 * that only archive raw blocks keep working, while group consumers can read
 * `rows.groups`, `rows.rows`, `rows.chains` and `rows.summary`.
 */
export async function collect(client) {
  const manifest = await client('/manifest');
  const records = [];
  const payloads = new Map();
  for (const block of manifest.blocks ?? []) {
    const response = await client(`/blocks/${encodeURIComponent(block.id)}`);
    const bytes = Buffer.from(response.data,'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== block.sha256) throw new Error('block checksum mismatch');
    payloads.set(block.id,bytes);
    records.push({id:`${manifest.fileId}:${manifest.revision}:${block.id}`,blockId:block.id,sha256:block.sha256,data:response.data});
  }
  return attach(records,extractChannelGroups(manifest,payloads));
}

// Channel-group intake lives in groups.mjs; re-exported so the source adapter
// remains the single import point for intake callers.
export {
  extractChannelGroups,
  extractGroupRows,
  readChannelGroups,
  collectGroupRows,
  collectIntake,
  describeGroups,
  collectGroups,
  collectChannels,
  readGroups,
  inspectGroups
} from './groups.mjs';
