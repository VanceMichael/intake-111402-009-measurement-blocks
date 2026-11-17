# 来源网关契约

GET /manifest 返回 fileId、revision、blocks、groups。组声明 recordId、recordSize、master、channels{offset,type,invalidationBit,conversion}；块声明 next、compression、sha256。GET /blocks/:id 返回 base64 data。样例只支持 LE int16/float64、1字节记录号和 zlib 块，换算描述为 linear 或 unsupported。

## 本地来源操作

默认场景 normal，其他场景为 compressed, bad-reference, interleaved, chained, reference-cycle, unsupported-conversion, missing-block。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 通道组数据

块字节是记录流：每条记录以 1 字节记录号开头，按 groups 中对应 recordId 的 recordSize 切分。记录号用于区分交织在同一流中的组，不能假设所有记录同一宽度。

- 每个组由 master 指定主通道，收存行保留 time/masterTime、各通道 raw 原始值、value 换算值、conversion 引用与 invalidationBit/validity。
- 失效位置 1 的样本 value 为 null，raw 仍保留；不得把无效样本输出为 0。没有声明换算时 value 等于 raw。
- 块按 next 链拼接后再切分记录，记录可以跨越块边界。每块先按 sha256 校验再解压（none/zlib）；校验或解压失败的块不产出样本。
- 引用环、缺失块、未知记录号、截断记录、不支持的换算/类型/压缩会隔离受影响的部分：受影响的记录组标为 isolated 且不产出行（破损链上的可读前缀也不作为完整组交付）；单个通道不可解码时该组为 partial，其余通道照常交付。其他完整链中的组不受影响。
- 收存行形如 fileId:revision:recordId:recordIndex，并带 source{fileId,revision,recordId,blockId,blockOffset,chainOffset}，可按记录回指文件版本和原始位置。

`groups.mjs` 导出 `extractChannelGroups(manifest, payloads, options)`（离线，不访问网络）、`readChannelGroups(client)`、`collectGroupRows(client)`、`collectIntake(client)`、`toDelivery(result)`，均可用 Map 或对象提供块负载（base64 字符串、Buffer 或 `{data}`）。`maxInflatedBytes` 限制解压后大小，`maxSamples` 限制单次解析样本数。

## 收存约定

原始块适配器 collect(client) 仍返回带字符串 id 的原件行，并把分组结果以非枚举属性附在数组上（groups、rows、summary、chains）。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容；每条记录增加 ref 字段指向行 id。Archive.delivery()/GET /delivery 按 fileId、revision、recordId 重建分组视图，逐行给出归档 ref 与来源位置，不导出单一混合表。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，不将未知状态伪造为成功。
