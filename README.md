# 悄悄看一眼 Open

输入抖音 dy 号，查看公开主页信息、最近作品、视频/图文内容和首批公开评论。

这是精简开源版：不需要数据库，不写埋点，不带本地看板。Express 进程直接托管 H5 并调用 Playwright，查询任务和缓存都只保存在内存里，服务重启后自动清空。

## 功能

- dy 号查询：昵称、头像、签名、粉丝/关注/获赞和最近作品列表
- 作品查看：视频播放、图文查看、发布时间展示、作品链接复制
- 评论查看：查看作品首批公开评论，并可从评论作者继续查询
- 历史记录：浏览器本地保存最近查询记录
- 移动端交互：H5 优先适配手机浏览器，支持浏览器返回和安卓返回键

## 环境要求

- Node.js 18+
- Google Chrome / Chromium。本地运行时由 Playwright 使用；Docker 镜像已内置浏览器。

## 安装

```bash
git clone <your-repo-url>
cd fangxiaba-open
npm install
```

如果本机没有 Playwright 浏览器：

```bash
npx playwright install chromium
```

## 本地运行

后台运行：

```bash
npm start
```

浏览器打开：

```text
http://localhost:3000/
```

关闭后台服务：

```bash
npm stop
```

前台运行：

```bash
npm run serve
```

健康检查：

```text
GET http://localhost:3000/healthz
GET http://localhost:3000/api/status
```

## API

```text
GET  /healthz
GET  /api/status
POST /api/lookup
POST /api/lookup-secuid
POST /api/lookup-jobs
POST /api/lookup-secuid-jobs
GET  /api/lookup-jobs/:jobId
POST /api/user-info
POST /api/video-url
GET  /api/video?awemeId=...
POST /api/images
POST /api/comments
```

H5 默认使用异步搜索接口：先提交内存任务，再轮询结果。

```bash
curl -X POST http://localhost:3000/api/lookup-jobs \
  -H "Content-Type: application/json" \
  -d "{\"uniqueId\":\"dyhao\",\"count\":15}"
```

```text
GET http://localhost:3000/api/lookup-jobs/<jobId>
```

## 配置

复制 `.env.example` 为 `.env` 后按需调整。

- `PORT`：服务监听端口，默认 `3000`
- `ALLOWED_ORIGINS`：允许跨域调用 API 的来源，H5 和 API 同域部署时可以留空
- `TRUST_PROXY`：默认开启；直连公网部署可设为 `0`
- `PLAYWRIGHT_WARMUP`：是否启动时预热浏览器，默认开启
- `PLAYWRIGHT_PROXY_*`：可选代理配置
- `PLAYWRIGHT_CONCURRENCY` / `PLAYWRIGHT_QUEUE_MAX`：控制单进程内 Playwright 并发和排队上限
- `LOOKUP_JOB_TTL_MS`：内存查询任务保留时间，默认 10 分钟
- `MAX_LOOKUP_COUNT` / `MAX_COMMENT_COUNT`：单次查询数量上限

## Docker

```bash
docker build -t fangxiaba-open .
docker run -d --name fangxiaba-open --env-file .env -p 3000:3000 fangxiaba-open
```

## 项目结构

```text
fangxiaba-open/
  web/                 # H5 客户端、样式和图片资源
  src/
    index.ts           # Playwright 抓取逻辑和内存缓存
    interceptor.ts     # 作品列表响应拦截
    env.ts             # 本地 .env 加载
    types.ts           # 类型定义
  scripts/
    build-assets.js    # 生成带 hash 的前端静态资源
    start.js           # 后台启动服务
    stop.js            # 关闭后台服务
  server.ts            # Express API 服务 + H5 静态托管
```

## 开源前检查

- 不要提交 `.env`、`logs/`、`dist/`、`node_modules/`
- 修改 `package.json` 的仓库地址、作者和 license
- 如果要公开部署，建议加上自己的使用声明和频率限制说明
