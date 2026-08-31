# novelai-ui

NovelAI 生图前端界面，对应站点 [ai.bailan.shop](https://ai.bailan.shop)。

支持 NovelAI 官方格式、OpenAI 兼容格式，以及第三方图片生成接口。

## 功能

- 文生图、图生图
- 多种 API 格式：NovelAI、OpenAI Chat Completions、第三方 Images API
- 自定义模型、尺寸、采样器和提示词
- 兼容上游返回 `text/plain` 的图片 JSON

## 本地开发

```bash
npm install
npm run dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。

主要页面文件：`src/app/page.tsx`。

## 生产构建

```bash
npm run build
npm start
```

也可以用 Docker 部署：

```bash
npm run build
docker compose up -d --build
```

默认映射端口为 `3002`。

## 接口说明

- `/api/generate`：NovelAI 官方格式
- `/api/openai`：OpenAI Chat Completions 格式
- `/api/thirdparty`：第三方文生图
- `/api/thirdparty-edit`：第三方图生图

API 地址和密钥在页面中填写，不会写入仓库。
