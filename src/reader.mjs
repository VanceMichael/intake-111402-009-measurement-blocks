import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';

const MAX_BLOCK_BYTES = 16 * 1024 * 1024;

// Primitive readers listed by the source contract.  A type that is not in
// this table is isolated instead of guessed at, so an unsupported layout can
// never silently turn into a number.
const READERS = new Map([
  ['int8',{size:1,read:(bytes,offset) => bytes.readInt8(offset)}],
  ['uint8',{size:1,read:(bytes,offset) => bytes.readUInt8(offset)}],
  ['int16',{size:2,read:(bytes,offset) => bytes.readInt16LE(offset)}],
  ['uint16',{size:2,read:(bytes,offset) => bytes.readUInt16LE(offset)}],
  ['int32',{size:4,read:(bytes,offset) => bytes.readInt32LE(offset)}],
  ['uint32',{size:4,read:(bytes,offset) => bytes.readUInt32LE(offset)}],
  ['float32',{size:4,read:(bytes,offset) => bytes.readFloatLE(offset)}],
  ['float64',{size:8,read:(bytes,offset) => bytes.readDoubleLE(offset)}]
]);

function problem(reason,fields = {}) {
  return {reason,...fields};
}

function manifestVersion(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest required');
  if (typeof manifest.fileId !== 'string' || !manifest.fileId) throw new Error('manifest fileId required');
  if (typeof manifest.revision !== 'string' || !manifest.revision) throw new Error('manifest revision required');
  return {fileId:manifest.fileId,revision:manifest.revision};
}

function blockReference(block) {
  const next = block?.next;
  if (next === null || next === undefined) return null;
  if (typeof next === 'string' && next) return next;
  if (typeof next === 'object' && typeof next.id === 'string' && next.id) return next.id;
  return undefined;
}

// Walk the block chains first.  Compressed blocks and continuation blocks may
// sit anywhere in the manifest, so only the `next` relation decides order;
// array order is never assumed.
function planChains(blocks) {
  const byId = new Map();
  const duplicates = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block.id !== 'string' || !block.id) continue;
    if (byId.has(block.id)) {duplicates.push(block.id);continue;}
    byId.set(block.id,block);
  }
  const referenceCount = new Map();
  for (const block of byId.values()) {
    const id = blockReference(block);
    if (typeof id === 'string') referenceCount.set(id,(referenceCount.get(id) ?? 0) + 1);
  }
  const nodes = [...byId.values()];
  const heads = nodes.filter(block => !referenceCount.has(block.id));
  const order = [...heads,...nodes.filter(block => referenceCount.has(block.id))];
  const ownerOf = new Map();
  const chains = [];
  for (const start of order) {
    if (ownerOf.has(start.id)) continue;
    const chain = {index:chains.length,headId:start.id,blocks:[],blockIds:[],errors:[],data:Buffer.alloc(0),
      records:[],complete:true};
    chains.push(chain);
    let id = start.id;
    while (id !== null) {
      const owner = ownerOf.get(id);
      if (owner === chain) {
        chain.complete = false;
        chain.errors.push(problem('block-reference-cycle',{blockId:id,blockIds:[...chain.blockIds]}));
        break;
      }
      if (owner) {
        // A block reachable from two heads makes both chains ambiguous, so
        // neither may be treated as complete.
        owner.complete = false;
        owner.errors.push(problem('shared-block',{blockId:id,otherHead:chain.headId}));
        chain.complete = false;
        chain.errors.push(problem('shared-block',{blockId:id,otherHead:owner.headId}));
        break;
      }
      const block = byId.get(id);
      if (!block) {
        chain.complete = false;
        chain.errors.push(problem('missing-block',{blockId:id,blockIds:[...chain.blockIds]}));
        break;
      }
      ownerOf.set(id,chain);
      chain.blocks.push(block);
      chain.blockIds.push(id);
      const next = blockReference(block);
      if (next === undefined) {
        chain.complete = false;
        chain.errors.push(problem('invalid-block-reference',{blockId:block.id}));
        break;
      }
      id = next;
    }
  }
  return {chains,duplicates};
}

function loadFailure(error) {
  if (error?.reason) return {...error};
  if (error?.status === 404) return problem('missing-block',{status:404,message:error.message});
  if (error?.name === 'SourceError') return problem('block-unavailable',{status:error.status,message:error.message});
  return problem('block-unavailable',{message:error?.message ?? String(error)});
}

async function fetchBlock(client,block,cache) {
  if (cache.has(block.id)) {
    const cached = cache.get(block.id);
    if (cached.error) throw cached.error;
    return cached;
  }
  let entry;
  try {
    const response = await client(`/blocks/${encodeURIComponent(block.id)}`);
    if (!response || typeof response.data !== 'string') {
      throw problem('invalid-block-payload',{blockId:block.id});
    }
    const raw = Buffer.from(response.data,'base64');
    if (block.sha256 && createHash('sha256').update(raw).digest('hex') !== String(block.sha256).toLowerCase()) {
      throw problem('checksum-mismatch',{blockId:block.id});
    }
    const compression = block.compression ?? 'none';
    let data = raw;
    if (compression === 'zlib') {
      try {data = inflateSync(raw,{maxOutputLength:MAX_BLOCK_BYTES});}
      catch (error) {
        throw problem(error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'decompressed-block-too-large' : 'decompression-failed',
          {blockId:block.id,message:error.message});
      }
    } else if (compression !== 'none') {
      throw problem('unsupported-compression',{blockId:block.id,compression});
    }
    entry = {data,sourceData:response.data};
  } catch (error) {
    entry = {error:loadFailure(error)};
    entry.error.blockId ??= block.id;
  }
  cache.set(block.id,entry);
  if (entry.error) throw entry.error;
  return entry;
}

async function loadChains(client,chains) {
  const cache = new Map();
  for (const chain of chains) {
    const parts = [];
    for (const block of chain.blocks) {
      try {
        parts.push((await fetchBlock(client,block,cache)).data);
      } catch (error) {
        chain.complete = false;
        chain.errors.push({...error,chainIndex:chain.index,blockIds:[...chain.blockIds]});
        break;
      }
    }
    chain.data = parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
  }
  return cache;
}

function validateGroup(group) {
  if (!group || typeof group !== 'object') return {ok:false,reason:'invalid-group-definition'};
  if (!Number.isInteger(group.recordId) || group.recordId < 0 || group.recordId > 255) {
    return {ok:false,reason:'invalid-record-id'};
  }
  if (!Number.isInteger(group.recordSize) || group.recordSize < 1) return {ok:false,reason:'invalid-record-size'};
  if (!Array.isArray(group.channels) || group.channels.length === 0) return {ok:false,reason:'missing-channels'};
  if (typeof group.master !== 'string' || !group.master) return {ok:false,reason:'missing-master'};
  return {ok:true};
}

function resolveConversion(reference,conversions) {
  if (reference === null || reference === undefined) return {ok:true,spec:null};
  const spec = typeof reference === 'string' ? conversions?.[reference] : reference;
  if (!spec || typeof spec !== 'object') return {ok:false,reason:'missing-conversion',spec:null};
  if (spec.type === 'linear' && Number.isFinite(spec.factor) && Number.isFinite(spec.offset ?? 0)) {
    return {ok:true,spec:{type:'linear',factor:spec.factor,offset:spec.offset ?? 0}};
  }
  return {ok:false,reason:'unsupported-conversion',spec};
}

function planChannels(group,conversions) {
  return group.channels.map(channel => {
    const conversion = channel?.conversion ?? null;
    const base = {
      name:channel?.name,offset:channel?.offset,type:channel?.type,
      invalidationBit:Number.isInteger(channel?.invalidationBit) ? channel.invalidationBit : null,
      conversion,conversionSpec:null,reader:null,readable:false,usable:false,
      status:'isolated',reason:null
    };
    if (!channel || typeof channel !== 'object' || typeof channel.name !== 'string' || !channel.name) {
      return {...base,reason:'invalid-channel-definition'};
    }
    const reader = READERS.get(channel.type);
    if (!reader) return {...base,reason:'unsupported-channel-type'};
    if (!Number.isInteger(channel.invalidationBit) && channel.invalidationBit !== undefined &&
        channel.invalidationBit !== null) {
      return {...base,reason:'invalid-invalidation-bit'};
    }
    if (base.invalidationBit !== null && (base.invalidationBit < 0 || base.invalidationBit > 7)) {
      return {...base,reason:'invalid-invalidation-bit'};
    }
    if (!Number.isInteger(channel.offset) || channel.offset < 0 ||
        channel.offset + reader.size > group.recordSize) {
      return {...base,reason:'channel-out-of-bounds'};
    }
    // The raw bits are still readable when only the conversion is unknown, so
    // an isolated channel keeps its raw value and conversion reference.
    const resolved = resolveConversion(conversion,conversions);
    if (!resolved.ok) {
      return {...base,reader,readable:true,conversionSpec:resolved.spec,reason:resolved.reason};
    }
    return {...base,conversionSpec:resolved.spec,reader,readable:true,usable:true,status:'ok'};
  });
}

function invalidationMask(group,bytes) {
  const offset = group.invalidationOffset;
  if (!Number.isInteger(offset) || offset < 0 || offset >= group.recordSize) {
    return {offset:Number.isInteger(offset) ? offset : null,known:false,byte:null};
  }
  return {offset,known:true,byte:bytes[offset]};
}

function isInvalidated(channel,mask) {
  if (channel.invalidationBit === null) return false;
  if (!mask.known) return null;
  return ((mask.byte >> channel.invalidationBit) & 1) === 1;
}

// Split one chain's bytes into records by looking at each record's leading
// record identifier (one byte, per the contract).  Record boundaries are not
// assumed to line up with block boundaries.
function scanChain(chain,groupsByRecordId) {
  const data = chain.data;
  let offset = 0;
  while (offset < data.length) {
    const recordId = data[offset];
    const group = groupsByRecordId.get(recordId);
    if (!group) {
      chain.complete = false;
      chain.errors.push(problem('unknown-record-id',{recordId,offset,chainIndex:chain.index}));
      break;
    }
    if (offset + group.recordSize > data.length) {
      chain.complete = false;
      chain.errors.push(problem('truncated-record',{recordId,offset,recordSize:group.recordSize,
        available:data.length - offset,chainIndex:chain.index}));
      break;
    }
    chain.records.push({group,chain,offset,bytes:data.subarray(offset,offset + group.recordSize)});
    offset += group.recordSize;
  }
}

function readChannel(channel,bytes,mask) {
  const invalidated = isInvalidated(channel,mask);
  const detail = {
    name:channel.name,offset:channel.offset,type:channel.type,
    invalidationBit:channel.invalidationBit,
    conversion:channel.conversion,conversionRef:channel.conversion,
    conversionSpec:channel.conversionSpec,usable:channel.usable,
    raw:null,rawValue:null,value:null,convertedValue:null,
    valid:false,invalidated:invalidated === true,status:channel.status,reason:channel.reason
  };
  // Unknown layout leaves even the raw value unavailable; an unknown
  // conversion or missed invalidation mask still lets the raw bits through.
  if (!channel.readable) return detail;
  let raw;
  try {raw = channel.reader.read(bytes,channel.offset);}
  catch (error) {return {...detail,status:'isolated',reason:`channel-read-failed:${error.message}`};}
  if (invalidated === null) {
    return {...detail,raw,rawValue:raw,status:'isolated',reason:'invalidation-mask-unavailable'};
  }
  // An invalidated sample keeps its raw value; only the physical value is
  // withheld.  It must never be replaced by a plausible-looking zero.
  if (invalidated) {
    return channel.usable
      ? {...detail,raw,rawValue:raw,status:'invalidated'}
      : {...detail,raw,rawValue:raw};
  }
  if (!channel.usable) return {...detail,raw,rawValue:raw};
  const value = channel.conversionSpec
    ? raw * channel.conversionSpec.factor + channel.conversionSpec.offset
    : raw;
  return {...detail,raw,rawValue:raw,value,convertedValue:value,valid:true,status:'ok'};
}

function sampleFrom(record,group,plan,version,recordIndex,groupUsable) {
  const mask = invalidationMask(group,record.bytes);
  const channels = {};
  const rawValues = {};
  const values = {};
  let master = null;
  let anyInvalidated = false;
  let anyIsolated = false;
  for (const channel of plan) {
    const detail = readChannel(channel,record.bytes,mask);
    channels[channel.name] = detail;
    rawValues[channel.name] = detail.raw;
    values[channel.name] = detail.value;
    if (channel.name === group.master) master = detail;
    if (detail.invalidated) anyInvalidated = true;
    if (detail.status === 'isolated') anyIsolated = true;
  }
  const time = master?.valid ? master.value : null;
  const status = !groupUsable ? 'isolated'
    : anyIsolated ? 'partial' : anyInvalidated ? 'invalidated' : 'ok';
  return {
    id:`${version.fileId}:${version.revision}:${group.recordId}:${recordIndex}`,
    fileId:version.fileId,
    revision:version.revision,
    groupId:`${version.fileId}:${version.revision}:group:${group.recordId}`,
    recordId:group.recordId,
    recordIndex,
    recordSize:group.recordSize,
    master:group.master,
    time,
    masterTime:time,
    byteOffset:record.offset,
    blockIds:[...record.chain.blockIds],
    chainIndex:record.chain.index,
    sourceRecord:{
      fileId:version.fileId,revision:version.revision,recordId:group.recordId,
      recordIndex,byteOffset:record.offset,blockIds:[...record.chain.blockIds]
    },
    invalidation:{offset:mask.offset,mask:mask.byte,known:mask.known},
    channels,
    rawValues,
    values,
    valid:groupUsable && master?.valid === true && !anyIsolated,
    invalidated:anyInvalidated,
    groupUsable,
    status
  };
}

function groupSummary(group,definition,plan,records,chains,version) {
  const summary = {
    id:`${version.fileId}:${version.revision}:group:${group?.recordId ?? null}`,
    fileId:version.fileId,
    revision:version.revision,
    recordId:group?.recordId ?? null,
    recordSize:group?.recordSize ?? null,
    master:group?.master ?? null,
    status:'unavailable',usable:false,reason:null,
    channels:plan.map(channel => ({
      name:channel.name,offset:channel.offset,type:channel.type,
      invalidationBit:channel.invalidationBit,conversion:channel.conversion,
      conversionSpec:channel.conversionSpec,readable:channel.readable,usable:channel.usable,
      status:channel.status,reason:channel.reason
    })),
    samples:[],auditSamples:[],recordCount:0,blockIds:[],chainIndexes:[],problems:[]
  };
  if (!definition.ok) {
    summary.status = 'isolated';
    summary.reason = definition.reason;
    summary.problems.push(problem(definition.reason,{scope:'group',recordId:summary.recordId}));
    return summary;
  }
  const touched = [...new Set(records.map(record => record.chain.index))].sort((a,b) => a - b);
  summary.chainIndexes = touched;
  summary.blockIds = [...new Set(records.flatMap(record => record.chain.blockIds))];
  summary.recordCount = records.length;
  const broken = chains.filter(chain => touched.includes(chain.index) && (!chain.complete || chain.errors.length));
  if (records.length === 0) {
    const failed = chains.find(chain => chain.errors.length);
    summary.reason = failed ? `block-chain-incomplete:${failed.errors[0].reason}` : 'no-record-data';
    summary.problems.push(problem(summary.reason,{scope:'group',recordId:summary.recordId,
      chainIndexes:chains.map(chain => chain.index)}));
    return summary;
  }
  const masterChannel = plan.find(channel => channel.name === group.master);
  if (!masterChannel || !masterChannel.usable) {
    summary.status = 'isolated';
    summary.reason = masterChannel ? `master-channel-unavailable:${masterChannel.reason}` : 'missing-master-channel';
    summary.problems.push(problem(summary.reason,{scope:'group',recordId:summary.recordId}));
  } else if (broken.length) {
    summary.status = 'isolated';
    summary.reason = `incomplete-block-chain:${broken[0].errors[0].reason}`;
    summary.problems.push(problem(summary.reason,{scope:'group',recordId:summary.recordId,
      chainIndexes:broken.map(chain => chain.index)}));
  } else {
    const isolated = plan.filter(channel => !channel.usable);
    summary.status = isolated.length ? 'partial' : 'ok';
    summary.usable = true;
    if (isolated.length) {
      summary.reason = 'isolated-channels';
      for (const channel of isolated) summary.problems.push(problem(channel.reason,{
        scope:'channel',recordId:summary.recordId,channel:channel.name}));
    }
  }
  const allSamples = records.map((record,index) => sampleFrom(record,group,plan,version,index,summary.usable));
  summary.usable = summary.status !== 'isolated';
  summary.samples = summary.usable ? allSamples : [];
  summary.auditSamples = allSamples;
  return summary;
}

function rawBlockRows(chains,cache,version) {
  const rows = [];
  const seen = new Set();
  for (const chain of chains) {
    for (const block of chain.blocks) {
      if (seen.has(block.id)) continue;
      const loaded = cache.get(block.id);
      if (!loaded || loaded.error) continue;
      seen.add(block.id);
      rows.push({
        id:`${version.fileId}:${version.revision}:${block.id}`,
        fileId:version.fileId,revision:version.revision,blockId:block.id,
        next:block.next ?? null,compression:block.compression ?? 'none',
        sha256:block.sha256,data:loaded.sourceData
      });
    }
  }
  return rows;
}

export async function collectDelivery(client) {
  const manifest = await client('/manifest');
  const version = manifestVersion(manifest);
  const {chains,duplicates} = planChains(manifest.blocks);
  const cache = await loadChains(client,chains);
  const conversions = manifest.conversions && typeof manifest.conversions === 'object' ? manifest.conversions : {};
  const groups = Array.isArray(manifest.groups) ? manifest.groups : [];
  const definitions = groups.map(validateGroup);
  const groupsByRecordId = new Map();
  const duplicateRecordIds = [];
  groups.forEach((group,index) => {
    if (!definitions[index].ok) return;
    if (groupsByRecordId.has(group.recordId)) {duplicateRecordIds.push({recordId:group.recordId,index});return;}
    groupsByRecordId.set(group.recordId,group);
  });
  for (const chain of chains) scanChain(chain,groupsByRecordId);
  const recordsByGroup = new Map(groups.map(group => [group,[]]));
  for (const chain of chains) {
    for (const record of chain.records) recordsByGroup.get(record.group)?.push(record);
  }
  const problems = [];
  for (const blockId of duplicates) problems.push(problem('duplicate-block-id',{scope:'block',blockId}));
  for (const {recordId,index} of duplicateRecordIds) {
    problems.push(problem('duplicate-record-id',{scope:'group',recordId,index}));
  }
  for (const chain of chains) {
    for (const error of chain.errors) {
      problems.push({scope:'block-chain',chainIndex:chain.index,blockIds:[...chain.blockIds],...error});
    }
  }
  const groupResults = groups.map((group,index) => {
    const duplicate = duplicateRecordIds.some(entry => entry.index === index);
    const definition = definitions[index].ok && !duplicate
      ? definitions[index] : {ok:false,reason:duplicate ? 'duplicate-record-id' : definitions[index].reason};
    const plan = definitions[index].ok ? planChannels(group,conversions) : [];
    const summary = groupSummary(group,definition,plan,recordsByGroup.get(group) ?? [],chains,version);
    for (const item of summary.problems) problems.push(item);
    return summary;
  });
  const samples = groupResults.filter(group => group.usable).flatMap(group => group.samples);
  const auditSamples = groupResults.flatMap(group => group.auditSamples);
  return {
    fileId:version.fileId,
    revision:version.revision,
    groups:groupResults,
    samples,
    auditSamples,
    blocks:rawBlockRows(chains,cache,version),
    problems,
    complete:groupResults.every(group => group.usable) && problems.length === 0
  };
}

function withDelivery(array,delivery) {
  const extra = {
    delivery,
    fileId:delivery.fileId,
    revision:delivery.revision,
    groups:delivery.groups,
    rows:array,
    samples:delivery.samples,
    auditSamples:delivery.auditSamples,
    blocks:delivery.blocks,
    problems:delivery.problems,
    complete:delivery.complete
  };
  for (const [key,value] of Object.entries(extra)) {
    Object.defineProperty(array,key,{value,enumerable:false});
  }
  return array;
}

export async function collectGroups(client) {
  const delivery = await collectDelivery(client);
  return withDelivery(delivery.groups,delivery);
}

export async function collectSamples(client) {
  const delivery = await collectDelivery(client);
  return withDelivery(delivery.samples,delivery);
}

// Raw block receipt stays available unchanged for callers that only need the
// verified original bytes.
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

export const collectChannelGroups = collectDelivery;
export const collectAll = collectDelivery;
export const collectWithGroups = collectDelivery;
export const readChannelGroups = collectDelivery;
export const readGroups = collectGroups;
export const readSamples = collectSamples;
