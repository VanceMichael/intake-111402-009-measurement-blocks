import {createHash} from 'node:crypto';
export async function collect(client) {
  const manifest = await client('/manifest');
  const records = [];
  for (const block of manifest.blocks) {
    const response = await client(`/blocks/${block.id}`);
    const bytes = Buffer.from(response.data,'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== block.sha256) throw new Error('block checksum mismatch');
    records.push({id:`${manifest.fileId}:${manifest.revision}:${block.id}`,blockId:block.id,sha256:block.sha256,data:response.data});
  }
  return records;
}
