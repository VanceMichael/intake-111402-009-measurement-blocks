import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';

const SUPPORTED_TYPES = {
  int16: {size:2, read:(bytes,offset) => bytes.readInt16LE(offset)},
  float64: {size:8, read:(bytes,offset) => bytes.readDoubleLE(offset)}
};
const DEFAULT_MAX_INFLATED = 16 * 1024 * 1024;
const RECORD_ID_BYTES = 1;

function issue(type,detail = {}) {return {type,...detail};}
function asArray(value) {return Array.isArray(value) ? value : [];}
function hasOwn(object,key) {return object !== null && typeof object === 'object' && Object.hasOwn(object,key);}

function payloadBytes(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (typeof payload === 'string') return Buffer.from(payload,'base64');
  if (payload && typeof payload.data === 'string') return Buffer.from(payload.data,'base64');
  throw Object.assign(new Error('block payload is not base64 or bytes'),{code:'payload'});
}

function payloadOf(payloads,id) {
  if (payloads instanceof Map) return payloads.get(id);
  if (hasOwn(payloads,id)) return payloads[id];
  return undefined;
}

function decodeBlock(block,payload,maxInflated) {
  const wire = payloadBytes(payload);
  const digest = createHash('sha256').update(wire).digest('hex');
  if (typeof block.sha256 !== 'string' || digest !== block.sha256) {
    throw Object.assign(new Error('block checksum mismatch'),{code:'checksum'});
  }
  const compression = block.compression ?? 'none';
  if (compression === 'none') return {wire,bytes:wire,compression};
  if (compression === 'zlib') {
    let bytes;
    try {bytes = inflateSync(wire,{maxOutputLength:maxInflated});}
    catch (error) {throw Object.assign(new Error(`block inflate failed: ${error.message}`),{code:'inflate'});}
    return {wire,bytes,compression};
  }
  throw Object.assign(new Error(`unsupported compression: ${compression}`),{code:'compression'});
}

/**
 * Walk every `next` link. A block is used as a starting point only when no
 * other block references it; closed cycles without an entry point are then
 * walked from the first remaining block. `local` detects loops, so malformed
 * manifests terminate instead of hanging the intake.
 */
function assembleChains(blocks) {
  const byId = new Map();
  const duplicates = new Set();
  for (const block of blocks) {
    if (!block || typeof block.id !== 'string' || !block.id) continue;
    if (byId.has(block.id)) duplicates.add(block.id);
    else byId.set(block.id,block);
  }
  const referenced = new Set();
  for (const block of blocks) {
    if (block && typeof block.next === 'string' && block.next) referenced.add(block.next);
  }
  const chains = [];
  const visited = new Set();
  const walk = head => {
    const chain = {head,blockIds:[],status:'complete',issues:[]};
    const local = new Set();
    let current = head;
    while (current != null && current !== '') {
      if (local.has(current)) {
        chain.status = 'broken';
        chain.issues.push(issue('reference-cycle',{blockId:current,blocks:[...local]}));
        break;
      }
      if (visited.has(current)) {
        // The block was already consumed by an earlier chain (a merged/diamond
        // link). Parsing it twice would duplicate samples, so stop here and
        // report the ambiguity instead.
        chain.status = 'broken';
        chain.issues.push(issue('shared-block',{blockId:current}));
        break;
      }
      if (duplicates.has(current)) {
        chain.status = 'broken';
        chain.issues.push(issue('duplicate-block-id',{blockId:current}));
      }
      const block = byId.get(current);
      if (!block) {
        chain.status = 'broken';
        chain.issues.push(issue('missing-block',{blockId:current}));
        break;
      }
      local.add(current);
      chain.blockIds.push(current);
      visited.add(current);
      current = block.next;
    }
    chains.push(chain);
  };
  for (const block of blocks) {
    if (!block || typeof block.id !== 'string' || !block.id) continue;
    if (!referenced.has(block.id) && !visited.has(block.id)) walk(block.id);
  }
  for (const block of blocks) {
    if (!block || typeof block.id !== 'string' || !block.id) continue;
    if (!visited.has(block.id)) walk(block.id);
  }
  return {chains,duplicates,byId};
}

function resolveChannels(group,conversions) {
  const isolated = [];
  const channels = [];
  const names = new Set();
  const groupSize = Number(group.recordSize);
  const groupInvalidation = group.invalidationOffset;
  for (const [position,channel] of asArray(group.channels).entries()) {
    // Keep the declared reference even when the channel is isolated, so an
    // engineer can see what would have been applied.
    const declared = channel && typeof channel === 'object' ? {
      type:channel.type ?? null,
      offset:channel.offset ?? null,
      conversion:channel.conversion ?? null,
      invalidationBit:channel.invalidationBit ?? null,
      invalidationOffset:channel.invalidationOffset ?? groupInvalidation ?? null
    } : {type:null,offset:null,conversion:null,invalidationBit:null,invalidationOffset:null};
    const reject = (reason,detail = {}) => isolated.push({
      name:channel?.name ?? null,position,reason,...declared,...detail
    });
    if (!channel || typeof channel.name !== 'string' || !channel.name) {reject('missing-channel-name');continue;}
    const name = channel.name;
    if (names.has(name)) {reject('duplicate-channel-name');continue;}
    names.add(name);
    const type = SUPPORTED_TYPES[channel.type];
    if (!type) {reject('unsupported-channel-type',{type:channel.type ?? null});continue;}
    if (!Number.isInteger(groupSize) || groupSize < RECORD_ID_BYTES) {
      reject('invalid-record-size',{recordSize:group.recordSize});
      continue;
    }
    if (!Number.isInteger(channel.offset) || channel.offset < RECORD_ID_BYTES || channel.offset + type.size > groupSize) {
      reject('channel-outside-record',{offset:channel.offset ?? null,size:type.size,recordSize:groupSize});
      continue;
    }
    let convert = null;
    let conversionId = null;
    if (channel.conversion !== null && channel.conversion !== undefined) {
      conversionId = channel.conversion;
      const descriptor = typeof conversionId === 'string' ? conversions[conversionId] : undefined;
      if (!descriptor || descriptor.type !== 'linear' ||
          !Number.isFinite(descriptor.factor) || !Number.isFinite(descriptor.offset ?? 0)) {
        reject('unsupported-conversion',{conversion:conversionId,type:descriptor?.type ?? null});
        continue;
      }
      const factor = descriptor.factor;
      const conversionOffset = descriptor.offset ?? 0;
      convert = raw => raw * factor + conversionOffset;
    }
    let invalidationBit = null;
    let invalidationOffset = groupInvalidation;
    if (channel.invalidationBit !== undefined && channel.invalidationBit !== null) {
      if (!Number.isInteger(channel.invalidationBit) || channel.invalidationBit < 0 || channel.invalidationBit > 7) {
        reject('invalid-invalidation-bit',{invalidationBit:channel.invalidationBit});
        continue;
      }
      // A channel may point at its own invalidation byte; otherwise the
      // group-level invalidationOffset is shared by all channels.
      if (channel.invalidationOffset !== undefined && channel.invalidationOffset !== null) {
        invalidationOffset = channel.invalidationOffset;
      }
      if (!Number.isInteger(invalidationOffset) || invalidationOffset < 0 || invalidationOffset >= groupSize) {
        reject('invalidation-outside-record',{invalidationOffset:invalidationOffset ?? null,recordSize:groupSize});
        continue;
      }
      invalidationBit = channel.invalidationBit;
    }
    channels.push({
      name,type:channel.type,offset:channel.offset,size:type.size,
      conversion:conversionId,convert,invalidationOffset,
      invalidationBit
    });
  }
  return {channels,isolated};
}

function sampleChannel(channel,record) {
  const raw = SUPPORTED_TYPES[channel.type].read(record,channel.offset);
  let invalid = false;
  if (channel.invalidationBit !== null) {
    invalid = ((record[channel.invalidationOffset] >> channel.invalidationBit) & 1) === 1;
  }
  // An invalid sample keeps its raw value for diagnosis, but its converted
  // value is null: it must never be read downstream as a physical zero. The
  // distinction between "no conversion declared" and "conversion not applied"
  // stays visible through conversion/null and the quality field.
  const converted = invalid ? null : (channel.convert ? channel.convert(raw) : raw);
  return {
    name:channel.name,type:channel.type,
    raw,rawValue:raw,
    value:converted,convertedValue:converted,
    conversion:channel.conversion,conversionRef:channel.conversion,
    conversionType:channel.conversion === null ? null
      : (invalid ? 'not-applied' : 'linear'),
    conversionApplied:channel.conversion !== null && !invalid,
    invalidationBit:channel.invalidationBit,
    invalid,valid:!invalid,
    quality:invalid ? 'invalid' : 'valid'
  };
}

function segmentAt(segments,offset) {
  for (const segment of segments) {
    if (offset >= segment.start && offset < segment.end) return segment;
  }
  return null;
}

function parseChainRecords(bytes,segments,groupsByRecordId,maxSamples) {
  const samples = [];
  const recordIds = new Set();
  const issues = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (samples.length >= maxSamples) {
      issues.push(issue('sample-budget-exceeded',{offset,maxSamples}));
      break;
    }
    if (bytes.length - offset < RECORD_ID_BYTES) {
      issues.push(issue('truncated-record-id',{offset,available:bytes.length-offset}));
      break;
    }
    const recordId = bytes.readUInt8(offset);
    const declaration = groupsByRecordId.get(String(recordId));
    if (!declaration) {
      issues.push(issue('unknown-record-id',{recordId,offset}));
      break;
    }
    recordIds.add(String(declaration.recordId));
    const size = Number(declaration.group.recordSize);
    if (!Number.isInteger(size) || size < RECORD_ID_BYTES) {
      issues.push(issue('invalid-record-size',{recordId,recordSize:declaration.group.recordSize,offset}));
      break;
    }
    if (offset + size > bytes.length) {
      issues.push(issue('truncated-record',{recordId,offset,recordSize:size,available:bytes.length-offset}));
      break;
    }
    const startSegment = segmentAt(segments,offset);
    const endSegment = segmentAt(segments,offset + size - 1);
    const span = startSegment && endSegment && startSegment !== endSegment
      ? segments.filter(segment => segment.start < offset + size && segment.end > offset)
      : [startSegment].filter(Boolean);
    samples.push({
      recordId:String(declaration.recordId),
      group:declaration.group,
      offset,
      physicalIndex:samples.length,
      bytes:bytes.subarray(offset,offset+size),
      blockId:startSegment?.blockId ?? null,
      blockIds:span.map(segment => segment.blockId),
      blockOffset:startSegment ? offset - startSegment.start : null
    });
    offset += size;
  }
  return {samples,recordIds,issues};
}

function manifestIssues(manifest) {
  const issues = [];
  if (typeof manifest?.fileId !== 'string' || !manifest.fileId) issues.push(issue('missing-file-id'));
  if (typeof manifest?.revision !== 'string' || !manifest.revision) issues.push(issue('missing-revision'));
  return issues;
}

/**
 * Decode a manifest plus already-fetched block payloads into per-record channel
 * samples. No network access happens here, which keeps the source gateway and
 * the interpretation of its bytes separate.
 *
 * `payloads` may be a Map or plain object of blockId -> base64 string, Buffer,
 * or `{data: base64}`.
 */
export function extractChannelGroups(manifest,payloads = {},options = {}) {
  const blocks = asArray(manifest?.blocks).filter(block => block !== null && typeof block === 'object');
  const groups = asArray(manifest?.groups);
  const conversions = manifest?.conversions && typeof manifest.conversions === 'object' ? manifest.conversions : {};
  const maxInflated = options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED;
  const maxSamples = options.maxSamples ?? 1000000;
  const topIssues = manifestIssues(manifest);

  const {chains,duplicates} = assembleChains(blocks);
  const chainByBlock = new Map();
  for (const [position,chain] of chains.entries()) {
    for (const id of chain.blockIds) if (!chainByBlock.has(id)) chainByBlock.set(id,{chain,position});
  }

  const groupsByRecordId = new Map();
  const declarations = groups.map((group,position) => {
    const entry = {group,position,recordId:String(group?.recordId),issues:[],isolated:false};
    if (!group || (typeof group.recordId !== 'number' && typeof group.recordId !== 'string')) {
      entry.issues.push(issue('missing-record-id',{position}));
      entry.isolated = true;
      return entry;
    }
    if (groupsByRecordId.has(entry.recordId)) {
      const previous = groupsByRecordId.get(entry.recordId);
      const duplicate = issue('duplicate-record-id',{recordId:group.recordId,positions:[previous.position,position]});
      previous.issues.push(duplicate);
      previous.isolated = true;
      entry.issues.push(duplicate);
      entry.isolated = true;
      return entry;
    }
    groupsByRecordId.set(entry.recordId,entry);
    return entry;
  });

  const loaded = new Map();
  for (const block of blocks) {
    if (typeof block.id !== 'string' || !block.id) {
      topIssues.push(issue('missing-block-id',{block}));
      continue;
    }
    const payload = payloadOf(payloads,block.id);
    if (payload === undefined) {
      loaded.set(block.id,{ok:false,issues:[issue('missing-block-payload',{blockId:block.id})]});
      continue;
    }
    try {
      const decoded = decodeBlock(block,payload,maxInflated);
      loaded.set(block.id,{ok:true,...decoded,issues:[]});
    } catch (error) {
      const type = error.code === 'compression' ? 'unsupported-compression'
        : error.code === 'inflate' ? 'block-inflate-failed'
        : error.code === 'payload' ? 'invalid-block-payload'
        : error.code === 'checksum' ? 'block-checksum-mismatch'
        : 'block-undecodable';
      loaded.set(block.id,{ok:false,issues:[issue(type,{
        blockId:block.id,message:error.message,compression:block.compression ?? 'none'
      })]});
    }
  }

  // Concatenate each chain's decoded bytes so a record may straddle two blocks.
  // A chain stops at the first block that cannot be decoded; the readable
  // prefix is still parsed so the affected record ids can be reported.
  const chainParses = [];
  const blockParse = new Map();
  for (const chain of chains) {
    const segments = [];
    const parts = [];
    let length = 0;
    let complete = chain.status === 'complete';
    for (const id of chain.blockIds) {
      const state = loaded.get(id);
      if (!state?.ok) {
        complete = false;
        for (const problem of state?.issues ?? [issue('missing-block-payload',{blockId:id})]) {
          chain.issues.push(problem);
        }
        break;
      }
      segments.push({blockId:id,start:length,end:length + state.bytes.length});
      parts.push(state.bytes);
      length += state.bytes.length;
    }
    const bytes = Buffer.concat(parts,length);
    const parsed = parseChainRecords(bytes,segments,groupsByRecordId,maxSamples);
    if (parsed.issues.length) {
      complete = false;
      for (const problem of parsed.issues) chain.issues.push(problem);
    }
    chain.status = complete ? 'complete' : 'broken';
    const assigned = new Map();
    for (const blockId of chain.blockIds) assigned.set(blockId,{samples:0,issues:[]});
    for (const problem of chain.issues) {
      const blockId = problem.blockId ?? chain.blockIds[0];
      if (!assigned.has(blockId)) assigned.set(blockId,{samples:0,issues:[]});
      assigned.get(blockId).issues.push(problem);
    }
    for (const sample of parsed.samples) {
      if (sample.blockId && assigned.has(sample.blockId)) assigned.get(sample.blockId).samples++;
    }
    for (const [blockId,state] of assigned) {
      blockParse.set(blockId,{
        chainStatus:chain.status,chainHead:chain.head,chainPosition:chainParses.length,
        sampleCount:state.samples,issues:state.issues,
        complete:chain.status === 'complete'
      });
    }
    chainParses.push({chain,parsed});
  }

  for (const block of blocks) {
    if (typeof block.id !== 'string' || !block.id) continue;
    if (duplicates.has(block.id) && !blockParse.has(block.id)) {
      blockParse.set(block.id,{chainStatus:'broken',chainHead:null,chainPosition:null,sampleCount:0,
        issues:[issue('duplicate-block-id',{blockId:block.id})],complete:false});
    }
    if (chainByBlock.has(block.id)) {
      const position = chainByBlock.get(block.id).position;
      if (!blockParse.has(block.id)) {
        blockParse.set(block.id,{chainStatus:chains[position].status,chainHead:chains[position].head,chainPosition:position,
          sampleCount:0,issues:chains[position].issues,complete:chains[position].status === 'complete'});
      }
    }
  }

  const brokenRecordIds = new Set();
  const sampleRowsByGroup = new Map();
  for (const {chain,parsed} of chainParses) {
    if (chain.status !== 'complete') for (const recordId of parsed.recordIds) brokenRecordIds.add(recordId);
    // Samples from a broken chain are not delivered: the missing part may have
    // carried further samples of the same record, so presenting the readable
    // prefix as a complete group would be misleading.
    if (chain.status !== 'complete') continue;
    for (const sample of parsed.samples) {
      if (!sampleRowsByGroup.has(sample.recordId)) sampleRowsByGroup.set(sample.recordId,[]);
      sampleRowsByGroup.get(sample.recordId).push(sample);
    }
  }
  const anyBrokenChain = chains.some(chain => chain.status !== 'complete');

  const rows = [];
  const groupInfos = [];
  for (const declaration of declarations) {
    const {group,position,recordId} = declaration;
    const {channels,isolated} = group ? resolveChannels(group,conversions) : {channels:[],isolated:[]};
    const samples = sampleRowsByGroup.get(recordId) ?? [];
    const masterName = typeof group?.master === 'string' && group.master ? group.master : null;
    const masterChannel = masterName ? channels.find(channel => channel.name === masterName) : null;
    const masterIsolated = masterName !== null && isolated.some(channel => channel.name === masterName);
    const issues = [...declaration.issues];
    let status = 'complete';
    if (declaration.isolated) status = 'isolated';
    else if (!group) {status = 'isolated';issues.push(issue('missing-group',{recordId}));}
    else if (!masterName) {status = 'isolated';issues.push(issue('missing-master',{recordId}));}
    else if (!masterChannel) {
      status = 'isolated';
      issues.push(issue(masterIsolated ? 'master-channel-isolated' : 'unknown-master-channel',{recordId,master:masterName}));
    }
    if (status !== 'isolated' && brokenRecordIds.has(recordId)) {
      status = 'isolated';
      issues.push(issue('incomplete-block-chain',{recordId}));
    }
    if (status !== 'isolated' && samples.length === 0 && anyBrokenChain) {
      status = 'isolated';
      issues.push(issue('data-not-obtained',{recordId,reason:'no complete block chain carries this record'}));
    }
    if (status !== 'isolated' && samples.length === 0) status = 'empty';
    if (status !== 'isolated' && isolated.length > 0) status = 'partial';

    const groupRows = [];
    if (status === 'complete' || status === 'partial') {
      // Isolated channels are declared in the manifest but cannot be decoded.
      // They stay visible on each row as unavailable values rather than
      // silently disappearing, so consumers can tell them from absent channels.
      const isolatedEntries = isolated.map(channel => ({
        name:channel.name ?? null,
        type:channel.type ?? null,
        offset:channel.offset ?? null,
        raw:null,
        rawValue:null,
        value:null,
        convertedValue:null,
        conversion:channel.conversion ?? null,
        conversionRef:channel.conversion ?? null,
        conversionType:null,
        invalidationBit:channel.invalidationBit ?? null,
        invalid:false,
        valid:false,
        available:false,
        quality:'isolated',
        reason:channel.reason
      }));
      for (const [index,sample] of samples.entries()) {
        const channelSamples = channels.map(channel => sampleChannel(channel,sample.bytes));
        const byName = new Map(channelSamples.map(channel => [channel.name,channel]));
        const master = masterName ? byName.get(masterName) : null;
        const time = master ? master.value : null;
        const values = {};
        const raw = {};
        const validity = {};
        for (const channel of channelSamples) {
          values[channel.name] = channel.value;
          raw[channel.name] = channel.raw;
          validity[channel.name] = channel.valid;
        }
        // An isolated channel appears as null, never as zero.
        for (const channel of isolatedEntries) {
          if (channel.name !== null && !Object.hasOwn(values,channel.name)) {
            values[channel.name] = null;
            raw[channel.name] = null;
            validity[channel.name] = false;
          }
        }
        const invalidChannels = channelSamples.filter(channel => channel.invalid).map(channel => channel.name);
        const row = {
          id: `${manifest?.fileId ?? 'unknown'}:${manifest?.revision ?? 'unknown'}:${group.recordId}:${index}`,
          kind: 'channel-sample',
          fileId: manifest?.fileId ?? null,
          revision: manifest?.revision ?? null,
          recordId: group.recordId,
          recordIndex: index,
          record: {
            id: group.recordId,index,
            blockId: sample.blockId,blockIds: sample.blockIds,
            blockOffset: sample.blockOffset,chainOffset: sample.offset,size: sample.bytes.length
          },
          source: {
            fileId: manifest?.fileId ?? null,
            revision: manifest?.revision ?? null,
            recordId: group.recordId,
            blockId: sample.blockId,
            blockOffset: sample.blockOffset,
            chainOffset: sample.offset
          },
          blockId: sample.blockId,
          blockIds: sample.blockIds,
          blockOffset: sample.blockOffset,
          chainOffset: sample.offset,
          recordSize: group.recordSize,
          master: masterName,
          time,
          masterTime: time,
          masterValid: master ? master.valid : false,
          values,
          raw,
          validity,
          valid: channelSamples.every(channel => channel.valid),
          // `valid` is per-sample quality; `complete` says whether every
          // declared channel could be decoded for this record.
          complete: isolatedEntries.length === 0,
          invalidChannels,
          omittedChannels: isolatedEntries.map(channel => channel.name).filter(name => name !== null),
          channels: [...channelSamples,...isolatedEntries]
        };
        groupRows.push(row);
        rows.push(row);
      }
    }

    const info = {
      recordId: group?.recordId ?? null,
      position,
      master: masterName,
      recordSize: group?.recordSize ?? null,
      status,
      available: status !== 'isolated',
      sampleCount: samples.length,
      rowCount: groupRows.length,
      channels: channels.map(channel => ({
        name:channel.name,type:channel.type,offset:channel.offset,size:channel.size,
        conversion:channel.conversion,invalidationBit:channel.invalidationBit,
        invalidationOffset:channel.invalidationOffset
      })),
      isolatedChannels: isolated,
      issues
    };
    // `samples` aliases the same row objects as `result.rows`; keep it out of
    // JSON serialization so a grouped delivery is not emitted twice.
    Object.defineProperty(info,'samples',{value:groupRows,enumerable:false,configurable:true});
    groupInfos.push(info);
  }

  const summary = {
    groups: groupInfos.length,
    completeGroups: groupInfos.filter(group => group.status === 'complete').length,
    partialGroups: groupInfos.filter(group => group.status === 'partial').length,
    isolatedGroups: groupInfos.filter(group => group.status === 'isolated').length,
    emptyGroups: groupInfos.filter(group => group.status === 'empty').length,
    rows: rows.length
  };

  return {
    fileId: manifest?.fileId ?? null,
    revision: manifest?.revision ?? null,
    rows,
    groups: groupInfos,
    blocks: blocks.map(block => {
      const state = typeof block.id === 'string' ? loaded.get(block.id) : undefined;
      const parsed = typeof block.id === 'string' ? blockParse.get(block.id) : undefined;
      const chain = typeof block.id === 'string' ? chainByBlock.get(block.id) : undefined;
      return {
        id: block.id ?? null,
        compression: block.compression ?? 'none',
        next: block.next ?? null,
        chain: chain?.position ?? null,
        chainStatus: parsed?.chainStatus ?? chain?.chain.status ?? null,
        status: state?.ok === false ? 'unavailable' : (parsed?.complete ? 'complete' : 'incomplete'),
        sampleCount: parsed?.sampleCount ?? 0,
        issues: state?.ok === false ? state.issues : (parsed?.issues ?? [])
      };
    }),
    chains: chains.map(chain => ({
      head:chain.head,blockIds:chain.blockIds,status:chain.status,
      issues:chain.issues.filter((problem,index,all) => all.findIndex(other =>
        JSON.stringify(other) === JSON.stringify(problem)) === index)
    })),
    issues: [...topIssues,...chains.flatMap(chain => chain.issues.map(problem => ({...problem,chain:chain.head})))],
    summary
  };
}

function withRowMetadata(rows,result) {
  const hidden = {
    fileId:result.fileId,revision:result.revision,groups:result.groups,blocks:result.blocks,
    chains:result.chains,issues:result.issues,summary:result.summary,result
  };
  for (const [key,value] of Object.entries(hidden)) {
    Object.defineProperty(rows,key,{value,enumerable:false,configurable:true});
  }
  return rows;
}

/** Offline variant: returns archived rows plus group/block diagnostics. */
export function extractGroupRows(manifest,payloads = {},options = {}) {
  const result = extractChannelGroups(manifest,payloads,options);
  return withRowMetadata(result.rows,result);
}

async function loadManifestAndBlocks(client) {
  const manifest = await client('/manifest');
  const payloads = new Map();
  const fetchErrors = new Map();
  for (const block of asArray(manifest?.blocks)) {
    if (!block || typeof block.id !== 'string' || !block.id) continue;
    // A failed block is recorded as unavailable rather than aborting the
    // whole delivery; extraction isolates the groups that depend on it.
    let payload;
    try {payload = await client(`/blocks/${encodeURIComponent(block.id)}`);}
    catch (error) {
      fetchErrors.set(block.id,{type:'block-fetch-failed',blockId:block.id,status:error.status ?? null,message:error.message});
      payloads.set(block.id,undefined);
      continue;
    }
    let wire;
    try {wire = payloadBytes(payload);}
    catch (error) {
      fetchErrors.set(block.id,{type:'invalid-block-payload',blockId:block.id,message:error.message});
      payloads.set(block.id,undefined);
      continue;
    }
    // Verify before any row can be archived: a corrupt payload must not look
    // like a successfully received block.
    const digest = createHash('sha256').update(wire).digest('hex');
    if (typeof block.sha256 !== 'string' || digest !== block.sha256) {
      fetchErrors.set(block.id,{type:'block-checksum-mismatch',blockId:block.id,expected:block.sha256 ?? null,actual:digest});
      payloads.set(block.id,undefined);
      continue;
    }
    payloads.set(block.id,payload);
  }
  return {manifest,payloads,fetchErrors};
}

/** Fetch and decode channel-group rows. */
export async function readChannelGroups(client,options = {}) {
  const {manifest,payloads,fetchErrors} = await loadManifestAndBlocks(client);
  const result = extractChannelGroups(manifest,payloads,options);
  result.fetchErrors = [...fetchErrors.values()];
  return result;
}

/**
 * Rows are one per measurement record and group, not one per channel and not a
 * single mixed CSV. Each row can be traced back to fileId/revision/recordId and
 * block bytes.
 */
export async function collectGroupRows(client,options = {}) {
  const result = await readChannelGroups(client,options);
  return withRowMetadata(result.rows,result);
}

/** Raw block rows (existing archive contract) plus decoded channel rows. */
export async function collectIntake(client,options = {}) {
  const {manifest,payloads,fetchErrors} = await loadManifestAndBlocks(client);
  const result = extractChannelGroups(manifest,payloads,options);
  const blockRows = [];
  for (const block of asArray(manifest?.blocks)) {
    if (!block || typeof block.id !== 'string' || !block.id) continue;
    const payload = payloads.get(block.id);
    if (payload === undefined) continue;
    let wire;
    try {wire = payloadBytes(payload);} catch {continue;}
    blockRows.push({
      id:`${manifest.fileId ?? 'unknown'}:${manifest.revision ?? 'unknown'}:${block.id}`,
      kind:'raw-block',
      fileId:manifest.fileId ?? null,
      revision:manifest.revision ?? null,
      blockId:block.id,
      sha256:block.sha256,
      data:wire.toString('base64')
    });
  }
  return {...result,fetchErrors:[...fetchErrors.values()],blockRows};
}

/** Resolve group/channel declarations without fetching data. */
export function describeGroups(manifest) {
  const conversions = manifest?.conversions && typeof manifest.conversions === 'object' ? manifest.conversions : {};
  return asArray(manifest?.groups).map((group,position) => {
    const {channels,isolated} = group ? resolveChannels(group,conversions) : {channels:[],isolated:[]};
    return {
      recordId: group?.recordId ?? null,
      position,
      master: typeof group?.master === 'string' ? group.master : null,
      recordSize: group?.recordSize ?? null,
      channels: channels.map(channel => ({
        name:channel.name,type:channel.type,offset:channel.offset,size:channel.size,
        conversion:channel.conversion,invalidationBit:channel.invalidationBit,
        invalidationOffset:channel.invalidationOffset
      })),
      isolatedChannels: isolated
    };
  });
}

export const collectGroups = collectGroupRows;
export const collectChannels = collectGroupRows;
export const readGroups = readChannelGroups;
export const inspectGroups = describeGroups;

/**
 * Grouped delivery view for engineers: one entry per record id, each with its
 * own master axis and channels, plus the isolation report. This deliberately
 * does not flatten the record ids into a single table.
 */
export function toDelivery(result) {
  return {
    fileId: result.fileId,
    revision: result.revision,
    summary: result.summary,
    groups: result.groups.map(group => ({
      recordId: group.recordId,
      status: group.status,
      available: group.available,
      master: group.master,
      recordSize: group.recordSize,
      channels: group.channels,
      isolatedChannels: group.isolatedChannels,
      issues: group.issues,
      rows: group.samples
    })),
    blocks: result.blocks,
    chains: result.chains,
    issues: result.issues
  };
}
