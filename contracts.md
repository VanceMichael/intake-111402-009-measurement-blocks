# 来源网关契约

GET /manifest 返回 fileId、revision、blocks、groups。组声明 recordId、recordSize、master、channels{offset,type,invalidationBit,conversion}；块声明 next、compression、sha256。GET /blocks/:id 返回 base64 data。样例只支持 LE int16/float64、1字节记录号和 zlib 块，换算描述为 linear 或 unsupported。

## 本地来源操作

默认场景 normal，其他场景为 compressed, bad-reference, interleaved。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

当前适配器 collect(client) 返回带字符串 id 的原件行。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，不将未知状态伪造为成功。

## 通道组接线

- collectDelivery(client) 返回 {fileId, revision, groups, samples, auditSamples, blocks, problems, complete}。blocks 为校验过的原始块行，可直接交给 Archive.put；samples 为可交付样本（仅来自 usable 组）；auditSamples 额外包含被隔离组的解析尝试，供核对。
- collectGroups(client) 返回组数组（带 .fileId/.revision/.problems 等非枚举属性）；collectSamples(client) 返回样本数组，同样带组与问题信息。两者共用一次 collectDelivery 结果。
- 每个样本带 id = `${fileId}:${revision}:${recordId}:${recordIndex}`，并带 sourceRecord{fileId,revision,recordId,recordIndex,byteOffset,blockIds}，用于回指文件版本与具体记录。
- 块链只按块声明中的 next 串联。记录由数据流首字节的记录标识分组，所以记录可跨越块边界；不假设数组顺序、块边界或固定记录宽度。
- 校验与解压顺序：先对块返回的原始 base64 字节比对 sha256，再按 compression 解压。压缩格式不受支持或解压失败时，该块所在链隔离。
- 失效位：invalidationOffset 指向记录内失效位字节，channel.invalidationBit 指定位号。位为 1 的通道保留 raw，value 为 null 且 invalidated=true；不得以 0 代替。失效位字节不可定位时，声明了 invalidationBit 的通道隔离。
- 换算：conversion 可为 conversions 表的键或内联描述；type=linear 时 value = raw*factor + offset。缺键、缺定义或非 linear 时该通道隔离（保留 raw 与换算引用），不影响同组其他通道或其他组。
- 问题隔离粒度：缺块/校验失败/压缩失败/引用环/缺 next 目标只隔离使用该块链的组；未知记录标识或截断记录只影响所在块链；不支持的通道类型/越界偏移隔离该通道；主通道不可用则整组隔离。
- 组状态：ok、partial（组可用、部分通道隔离，reason=isolated-channels）、isolated（整组不交付）。组汇总的 usable 仅在 ok/partial 时为 true。无法解析的组不出现在 samples 中，但保留在 groups、auditSamples 与 problems 中。
