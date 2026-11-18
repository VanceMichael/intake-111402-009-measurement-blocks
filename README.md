# 台架测量交付的通道组与失效位接收

台架测量原件入口。授权网关将 MDF4 块目录投影为 manifest，数据块保持原字节；已有领取器校验每个块哈希。支持范围写于 contracts.md。

除原始块收件外，接入现在按来源记录标识把数据流拆成交织的通道组：保留主通道时间、原始值、换算引用与失效位。某块缺失、引用成环、解压或换算不受支持时，只隔离受影响的通道/通道组，已完整取得的其他组仍会交付。收存记录回指文件版本与具体记录，可用查询接口按文件版本、记录号与记录序号核对。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取并打印通道组、收件结果与按记录回查结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /health 检查服务。

查询服务支持按文件版本和具体记录回查：

```sh
curl 'http://127.0.0.1:4020/records?fileId=bench1&revision=v1&recordId=1&recordIndex=1'
```

可用过滤键为 fileId、revision、groupId、recordId、recordIndex、blockId；不带过滤参数时返回全部收件。

```sh
docker build --network=none -t measurement-blocks .
docker run --rm --network=none measurement-blocks npm test
docker run --rm --network=none measurement-blocks npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是当前来源适配器；不修改来源来迎合适配结果。collectDelivery 一次读取 manifest 与块链，返回通道组、样本、原始块与问题清单；collectGroups / collectSamples / collect(client) 是兼容入口。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本。每条记录带 fileId、revision、groupId 与 reference（记录号、记录序号、块号），query() 按这些字段回查。
- src/api.mjs 提供收件查询；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本。测试和演示自己创建空目录，不依赖上次执行遗留状态。

## 交付语义

- 记录布局由来源声明：每字节记录标识决定记录归属哪个通道组，recordSize 决定记录长度；记录可以跨越块边界，块链只按 next 串联，不依赖数组顺序。
- compressed 块先按原始字节校验 sha256，再解压；解压失败、校验失败、缺块、引用环都记为问题，并只隔离使用该链的通道组。
- 主通道（group.master）的值作为该样本的 time。主通道不可用时整个组隔离，不伪造时间。
- 失效位为 1 的通道保留 raw/rawValue，value/convertedValue 置为 null 并标记 invalidated；绝不把无效样本写成 0。
- 换算引用随样本保留（conversion/conversionRef）；缺换算或换算类型不支持时该通道隔离，原始值仍保留，其他通道和通道组仍可用。
- 通道组状态：ok（全部通道可用）、partial（组可用但有通道被隔离）、invalidated 样本级标记、isolated（整组不可交付）。无法解析的组不会出现在交付样本里，但会出现在 group 汇总、auditSamples 与 problems 中，便于核对。
