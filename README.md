# ModelSpace · 模型管理工作台

面向百人以内的内网团队，提供模型接入与管理、用户与模型授权、知识库、文档处理与引用溯源、流式对话。当前仅包含前端实现与完整 Mock 模式，后端尚未接入。

## 项目结构

```
.
├── README.md                              # 本文件
├── 需求与架构分析规划.md                    # 全栈技术选型、RAG 流水线、部署与资源规划
├── 前端系统设计规划.md                      # 前端架构、Mermaid 图、API 契约、验收与边界
├── .gitignore
└── frontend/                              # Vue 3 前端
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── compose.yaml                       # Docker Compose 部署
    ├── Dockerfile
    ├── nginx.conf.template
    ├── .env.example
    ── src/
        ├── api/                           # 统一业务 API（Mock / REST 双模式）
        ├── mock/                          # 演示适配器、种子数据、权限与任务模拟
        ├── types/                         # 实体、DTO、权限、SSE 事件
        ├── stores/                        # Pinia 身份状态
        ├── router/                        # Vue Router + RBAC 守卫
        ├── utils/                         # SSE 解析、校验、错误处理
        ├── layouts/                       # 工作台布局
        ├── views/                         # 登录 / 工作台 / 模型 / 用户 / 知识库 / 文档 / 对话
        ├── styles.css                     # 公共样式
        ├── main.ts
        └── App.vue
```

## 已实现能力

- 登录与 RBAC 路由守卫，固定 `admin` / `user` 两角色，权限变更实时生效。
- 模型管理（Chat / Embedding / Rerank），搜索、筛选、分页、CRUD、启停、连接测试；密钥不回显、不持久化。
- 用户管理，CRUD、启停、密码重置、多模型授权；禁止删除最后一个启用管理员。
- 知识库 CRUD，Embedding 必选、Rerank 可选；非空库禁止更换向量模型。
- 文档工作台，PDF / DOCX / MD / TXT 上传，独立上传进度与处理阶段进度，失败重试，切分参数预览与确认重处理，分页内容卡片。
- 流式对话，会话列表、模型与知识库配置、SSE 逐段输出、中止、引用详情鉴权与原文下载。
- Mock 模式无需后端即可完整体验；真实模式通过 `VITE_DATA_MODE=rest` 切换，经同源 `/api/v1` 转发。
- 白色扁平主题，窄屏折叠导航；所有页面具备加载、空态、失败重试、提交中反馈。

## 未实现范围

- 后端服务（Fastify / Prisma / BullMQ / Qdrant / Xinference）尚未接入。
- 真实模型推理、PDF / DOCX 解析、向量化与检索效果待联调。
- 自定义角色编辑器、共享知识库 ACL、消息分支、OCR、拖拽切分编排、服务端全文分页。

## 快速开始

环境要求：Node.js 22.12+（22 系列）或 24+。

```powershell
# 安装依赖
npm --prefix ./frontend ci --registry=https://registry.npmjs.org

# 启动开发服务（默认 Mock 模式，端口 5173）
npm --prefix ./frontend run dev
```

演示账号：`admin / admin123`，`member / member123`；新增演示用户统一使用 `demo123`。侧栏可重置演示数据。请勿上传敏感文件。

## 切换真实 API

复制 `frontend/.env.example` 为 `frontend/.env.local` 并修改：

```dotenv
VITE_DATA_MODE=rest
VITE_API_BASE_URL=/api/v1
API_PROXY_TARGET=http://localhost:3000
```

重启 Vite。真实模式后端不可达时显示错误，不降级演示。模型服务地址在模型管理表单配置，凭据由后端保存。

## 质量检查

```powershell
npm --prefix ./frontend run typecheck
npm --prefix ./frontend test
npm --prefix ./frontend run build
npm --prefix ./frontend run format:check
npm --prefix ./frontend audit --registry=https://registry.npmjs.org
```

当前 146 项 Vitest 测试通过，依赖审计 0 个已知漏洞。Windows 下 Vitest 4 对路径大小写敏感，绝对路径请使用规范盘符 `C:\Users\X\Desktop\模型管理系统\frontend`。

## 容器部署

```powershell
docker compose -f ./frontend/compose.yaml up --build -d
```

默认发布到 8080。真实模式设置构建参数 `VITE_DATA_MODE=rest`，运行变量 `BACKEND_HOST`、`BACKEND_PORT` 指向业务后端。镜像不包含密钥，生产 HTTPS 由入口反向代理终止。

## 文档

- [需求与架构分析规划](./需求与架构分析规划.md)：全栈技术选型、RAG 流水线、部署与资源规划。
- [前端系统设计规划](./前端系统设计规划.md)：前端架构、Mermaid 图、API 契约、验收与边界。

## 许可证

私有项目，未公开授权。
