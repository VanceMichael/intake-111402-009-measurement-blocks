# 台架测量交付的通道组与失效位接收

台架测量原件入口。授权网关将 MDF4 块目录投影为 manifest，数据块保持原字节；领取器校验每个块哈希，再按来源记录标识解交织成通道组。支持范围写于 contracts.md。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取、解交织并打印分组收件结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /delivery 返回按文件版本与记录号分组的收存视图，GET /health 检查服务。

```sh
docker build --network=none -t measurement-blocks .
docker run --rm --network=none measurement-blocks npm test
docker run --rm --network=none measurement-blocks npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是当前来源适配器；不修改来源来迎合适配结果。
- src/groups.mjs 把块字节按记录号解交织成通道组，处理 next 链、zlib 块、失效位与隔离；不访问网络，便于单独校验。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本；delivery() 按版本与记录重建分组视图。
- src/api.mjs 提供收件查询；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本。测试和演示自己创建空目录，不依赖上次执行遗留状态。
