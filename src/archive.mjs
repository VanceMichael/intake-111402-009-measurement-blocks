import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open} from 'node:fs/promises';
import {join} from 'node:path';

const RECORDS = 'records.json';

export class Archive {
  constructor(directory) { this.directory = directory; this.serial = Promise.resolve(); }

  /** All archived rows, raw blocks and channel samples alike. */
  async list() {
    try {return JSON.parse(await readFile(join(this.directory,RECORDS),'utf8'));}
    catch(error) {if(error.code === 'ENOENT') return [];throw error;}
  }

  /**
   * Archive received rows. Content-addressed by row + provenance, so repeated
   * receipts do not grow the archive and changed content keeps a new version.
   * Every entry stores `ref` (the row id) so a delivery row can be traced back
   * to the exact archived record, not just to the file.
   */
  put(rows, provenance) {
    const operation = this.serial.then(async () => {
      if (!Array.isArray(rows) || rows.some(row => typeof row.id !== 'string' || !row.id)) throw new Error('record id required');
      await mkdir(this.directory,{recursive:true});
      const current = await this.list();
      const known = new Set(current.map(entry => entry.digest));
      let added = 0;
      let deliveryAdded = 0;
      for (const row of rows) {
        const digest = createHash('sha256').update(JSON.stringify({row,provenance})).digest('hex');
        if (known.has(digest)) continue;
        current.push({ref:row.id,row,provenance,digest});
        known.add(digest);
        added++;
        if (row.kind === 'channel-sample') deliveryAdded++;
      }
      const temporary = join(this.directory,`${randomUUID()}.tmp`);
      await writeFile(temporary,JSON.stringify(current,null,2)+'\n');
      const handle = await open(temporary,'r');
      try {await handle.sync();} finally {await handle.close();}
      await rename(temporary,join(this.directory,RECORDS));
      return {added,total:current.length,deliveryAdded};
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  /**
   * Grouped view for engineers: fileId/revision -> recordId -> samples. Every
   * sample carries the archive ref, digest, source block and offsets, so it can
   * be checked against the received originals. Rows stay separated by record id
   * instead of becoming one mixed table.
   */
  async delivery() {
    const entries = await this.list();
    const files = new Map();
    for (const entry of entries) {
      const row = entry.row ?? {};
      if (row.kind !== 'channel-sample') continue;
      const fileKey = `${row.fileId ?? 'unknown'}:${row.revision ?? 'unknown'}`;
      if (!files.has(fileKey)) files.set(fileKey,{fileId:row.fileId ?? null,revision:row.revision ?? null,groups:new Map()});
      const file = files.get(fileKey);
      const groupKey = String(row.recordId);
      if (!file.groups.has(groupKey)) file.groups.set(groupKey,{
        recordId:row.recordId,master:row.master ?? null,rows:[],blocks:new Set(),invalidRows:0,omittedChannels:new Set()
      });
      const group = file.groups.get(groupKey);
      for (const name of row.omittedChannels ?? []) group.omittedChannels.add(name);
      if (row.valid === false) group.invalidRows++;
      group.rows.push({
        ref:entry.ref ?? row.id,
        digest:entry.digest,
        recordIndex:row.recordIndex,
        time:row.time,
        values:row.values,
        raw:row.raw,
        validity:row.validity,
        valid:row.valid ?? null,
        invalidChannels:row.invalidChannels ?? [],
        omittedChannels:row.omittedChannels ?? [],
        blockId:row.blockId ?? null,
        blockIds:row.blockIds ?? [],
        blockOffset:row.blockOffset ?? null,
        chainOffset:row.chainOffset ?? null,
        source:row.source ?? {fileId:row.fileId ?? null,revision:row.revision ?? null,recordId:row.recordId}
      });
      for (const id of row.blockIds ?? (row.blockId ? [row.blockId] : [])) group.blocks.add(id);
    }
    return [...files.values()].map(file => ({
      fileId:file.fileId,
      revision:file.revision,
      groups:[...file.groups.values()].map(group => ({
        recordId:group.recordId,
        master:group.master,
        rowCount:group.rows.length,
        invalidRows:group.invalidRows,
        omittedChannels:[...group.omittedChannels],
        blocks:[...group.blocks],
        rows:group.rows
      }))
    }));
  }
}
