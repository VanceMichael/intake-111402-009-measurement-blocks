import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open} from 'node:fs/promises';
import {join} from 'node:path';

function referenceOf(row,provenance) {
  const sourceRecord = row?.sourceRecord && typeof row.sourceRecord === 'object' ? row.sourceRecord : {};
  const fileId = row?.fileId ?? sourceRecord.fileId ?? provenance?.fileId ?? null;
  const revision = row?.revision ?? sourceRecord.revision ?? provenance?.revision ?? null;
  const recordId = row?.recordId ?? sourceRecord.recordId ?? null;
  const recordIndex = row?.recordIndex ?? sourceRecord.recordIndex ?? null;
  const blockId = row?.blockId ?? null;
  const groupId = row?.groupId ?? null;
  return {fileId,revision,groupId,recordId,recordIndex,blockId,
    rowId:typeof row?.id === 'string' ? row.id : null};
}

export class Archive {
  constructor(directory) { this.directory = directory; this.serial = Promise.resolve(); }
  async list() {
    try {return JSON.parse(await readFile(join(this.directory,'records.json'),'utf8'));}
    catch(error) {if(error.code === 'ENOENT') return [];throw error;}
  }
  // Look records up by the file version and concrete record they came from.
  // This is what lets a test engineer check a stored row against the source
  // instead of trusting a flattened export.
  async query(filters = {}) {
    const wanted = Object.fromEntries(Object.entries(filters)
      .filter(([,value]) => value !== undefined && value !== null && value !== ''));
    return (await this.list()).filter(entry => {
      const ref = entry.reference ?? entry.row?.sourceRecord ?? {};
      return Object.entries(wanted).every(([key,value]) => {
        if (key === 'fileId') return entry.fileId === value || ref.fileId === value;
        if (key === 'revision') return entry.revision === value || ref.revision === value;
        if (key === 'recordId') return ref.recordId === Number(value);
        if (key === 'recordIndex') return ref.recordIndex === Number(value);
        if (key === 'groupId') return entry.groupId === value || ref.groupId === value;
        if (key === 'blockId') return ref.blockId === value;
        return entry.row?.[key] === value || ref[key] === value;
      });
    });
  }
  put(rows, provenance) {
    const operation = this.serial.then(async () => {
      if (!Array.isArray(rows) || rows.some(row => typeof row.id !== 'string' || !row.id)) throw new Error('record id required');
      await mkdir(this.directory,{recursive:true});
      const current = await this.list();
      const known = new Set(current.map(entry => entry.digest));
      let added = 0;
      for (const row of rows) {
        const reference = referenceOf(row,provenance);
        const digest = createHash('sha256').update(JSON.stringify({row,provenance})).digest('hex');
        if (!known.has(digest)) {
          current.push({row,provenance,digest,fileId:reference.fileId,revision:reference.revision,
            groupId:reference.groupId,reference});
          known.add(digest);added++;
        }
      }
      const temporary = join(this.directory,`${randomUUID()}.tmp`);
      await writeFile(temporary,JSON.stringify(current,null,2)+'\n');
      const handle = await open(temporary,'r');
      try {await handle.sync();} finally {await handle.close();}
      await rename(temporary,join(this.directory,'records.json'));
      return {added,total:current.length};
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
}
