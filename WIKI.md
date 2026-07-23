# Minimalist-Web-Notepad-Go · Code Wiki

> 本文档是对 **Minimalist-Web-Notepad-Go** 仓库的完整代码维基（Code Wiki），涵盖项目整体架构、主要模块职责、关键类与函数说明、依赖关系、请求流程时序、运行方式、安全注意事项与改进建议等内容。
>
> 文档基于仓库当前磁盘状态生成，反映的是代码的实际实现而非版本控制历史。

---

## 目录

1. [项目概述](#1-项目概述)
2. [项目背景与定位](#2-项目背景与定位)
3. [目录结构](#3-目录结构)
4. [整体架构](#4-整体架构)
5. [技术栈](#5-技术栈)
6. [核心模块职责](#6-核心模块职责)
7. [关键类与函数说明](#7-关键类与函数说明)
8. [请求流程时序](#8-请求流程时序)
9. [依赖关系](#9-依赖关系)
10. [配置与命令行参数](#10-配置与命令行参数)
11. [项目运行方式](#11-项目运行方式)
12. [数据存储机制](#12-数据存储机制)
13. [前端自动保存机制](#13-前端自动保存机制)
14. [安全注意事项](#14-安全注意事项)
15. [已知局限与改进建议](#15-已知局限与改进建议)
16. [许可证](#16-许可证)

---

## 1. 项目概述

**Minimalist-Web-Notepad-Go** 是一个基于 Go 语言与 [Gin](https://github.com/gin-gonic/gin) Web 框架实现的极简网页记事本服务。用户通过浏览器访问一个随机（或自定义）的 URL 路径，即可在该路径对应的"记事本"中编辑纯文本内容；前端会以 1 秒为周期轮询检测内容变化并自动 POST 回服务端持久化。再次访问同一 URL 即可读取之前保存的内容，从而实现跨设备的临时文本记录与传输。

核心特征：

- **极简**：后端单文件 `main.go`，前端仅一个 HTML 模板 + 一个 JS + 一个 CSS。
- **无数据库**：以文件系统作为存储后端，每条记事本即一个文件。
- **URL 即标识**：记事本的"身份"由 URL 路径段（如 `/12345678`）唯一确定。
- **自动保存**：前端定时比对内容差异，发生变化即上传，无需手动保存按钮。
- **暗色模式与打印支持**：CSS 通过 `prefers-color-scheme` 与 `@media print` 适配。

---

## 2. 项目背景与定位

本项目是 PHP 项目 [Minimalist Web Notepad](https://github.com/pereorga/minimalist-web-notepad) 的 Go 语言重置版（reset 版）。作者在 GitHub 发现原 PHP 项目后，认为其"用于临时记录与传输纯文本非常方便"，遂用 Go 重新实现，面向极简主义使用者。

定位：**个人/小范围的临时文本中转站**，而非生产级协作笔记系统。这一定位决定了其存储方式（文件系统）、并发模型（单实例进程内）与安全模型（无鉴权）。

---

## 3. 目录结构

```text
Minimalist-Web-Notepad-Go/
├── main.go                 # 后端入口：路由、请求处理、文件读写、随机串生成
├── index.html              # 前端 HTML 模板（Gin 模板，含 {{.title}} {{.body}} 占位）
├── go.mod                  # Go 模块定义（模块名 Minimalist-Web-Notepad-Go）
├── go.sum                  # 依赖校验和
├── static/                 # 静态资源目录（由 r.Static("/static", "./static") 暴露）
│   ├── script.js           # 前端自动保存逻辑（轮询 + XHR POST）
│   ├── styles.css          # 样式（亮/暗色、打印适配）
│   └── favicon.svg         # 站点图标（SVG）
├── _tmp_/                  # 运行时自动生成：存放每条记事本的文件（不纳入仓库）
│   └── <path>              #   文件名即 URL 路径段
├── README.md               # 项目说明与运行教程
├── LICENSE                 # WTFPL 许可证
├── .gitattributes          # Git 文本属性（LF 规范化）
└── Minimalist-Web-Notepad-PY.zip  # 附带的 Python 版压缩包（参考资料）
```

> 说明：`_tmp_/` 目录在源码中通过 `os.MkdirAll` / `os.Mkdir` 在运行时按需创建，仓库初始不含该目录。

---

## 4. 整体架构

### 4.1 架构分层

项目采用经典的 **单进程 Web 服务 + 文件存储 + 静态前端** 三层结构，无中间件层、无数据库层、无鉴权层。

```text
┌──────────────────────────────────────────────────────────────────┐
│                         浏览器（客户端）                          │
│  ┌────────────────────┐   ┌──────────────────────────────────┐   │
│  │  index.html        │   │  script.js                       │   │
│  │  - textarea#content│   │  - checkAndUploadContent()       │   │
│  │  - pre#printable   │   │  - 每 1s 轮询比对并 XHR POST     │   │
│  └────────────────────┘   └──────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  styles.css：亮/暗色、@media print 打印视图              │    │
│  └──────────────────────────────────────────────────────────┘    │
└───────────────▲───────────────────────────────▲──────────────────┘
                │ HTTP GET / (重定向)           │ HTTP POST /:path (保存)
                │ HTTP GET /:path (读取/渲染)   │
                │ HTTP GET /static/* (静态资源) │
┌───────────────┴───────────────────────────────┴──────────────────┐
│                    Go 进程（main.go, Gin ReleaseMode）            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  路由层（gin.Engine）                                      │  │
│  │   GET  /          → 生成随机串 → 302 重定向到 /:random     │  │
│  │   GET  /:path     → 读取/创建文件 → 渲染 index.html        │  │
│  │   POST /:path     → 写入文件 → 空内容则删除文件            │  │
│  │   GET  /static/*  → 静态资源服务                          │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  存储层（os 标准库）                                       │  │
│  │   ./_tmp_/<path>  ← 文件名 = URL 路径段                    │  │
│  │   0755 目录权限 / 0644 文件权限                            │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 组件协作关系

```text
            ┌─────────┐
  用户访问  │ Browser │
──────────▶│         │
            └────┬────┘
   GET /        │  1. 请求根路径
                 ▼
            ┌─────────┐  2. randomString(-l) 生成随机串
            │  Gin    │ ────────────────────┐
            │ Router  │                     │
            └────┬────┘                     │
   302 Found     │  3. 重定向 /<random>     │
                 ▼                          │
            ┌─────────┐  4. GET /:path      │
            │  Gin    │ ◀───────────────────┘
            │ Handler │
            └────┬────┘
   os.Stat       │  5. 文件不存在则 MkdirAll + Create
                 ▼
            ┌─────────┐
            │ 文件系统│ ./_tmp_/<path>
            └────┬────┘
   ReadFile      │  6. 读取内容
                 ▼
            ┌─────────┐  7. c.HTML 渲染 index.html（注入 title/body）
            │  Gin    │ ───────────────────▶ 浏览器展示 textarea
            └─────────┘
                                            8. script.js 每 1s 检测变化
                                            9. 变化则 POST /:path（body=纯文本）
            ┌─────────┐ ◀───────────────────┘
            │  Gin    │ 10. io.ReadAll → os.WriteFile → 空则 os.Remove
            │ Handler │ 11. 返回 JSON {"status":"Success"}
            └─────────┘
```

---

## 5. 技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 语言 | Go | 1.23.0（toolchain go1.24.7） | 见 `go.mod` |
| Web 框架 | gin-gonic/gin | v1.11.0 | 唯一直接依赖 |
| 模板引擎 | Gin 内置 `html/template` | - | `r.LoadHTMLGlob("index.html")` |
| 静态资源 | Gin `r.Static` | - | 暴露 `./static` 到 `/static` |
| 存储 | `os` / `path/filepath` 标准库 | - | 文件系统 |
| 随机数 | `math/rand` 标准库 | - | 生成 URL 路径（非加密安全） |
| 前端 | 原生 HTML + JS(XHR) + CSS | - | 无构建工具、无框架 |
| HTTP/3 支持 | quic-go/quic-go | v0.54.0 | 通过 gin 间接引入（HTTP/3 可用） |

---

## 6. 核心模块职责

### 6.1 后端模块（`main.go`）

后端为单文件、单 `package main`，职责集中但清晰：

| 职责 | 实现位置 | 说明 |
|------|----------|------|
| 框架初始化 | `main()` 开头 | 设置 `gin.ReleaseMode`，创建 `gin.Default()` 引擎 |
| 静态资源挂载 | `r.Static("/static", "./static")` | 提供 JS/CSS/favicon |
| 模板加载 | `r.LoadHTMLGlob("index.html")` | 加载根目录的 `index.html` 作为唯一模板 |
| 命令行参数 | `flag.IntVar` / `flag.StringVar` | `-l` 随机串长度，`-p` 监听端口 |
| 路由注册 | 3 个匿名 handler | `GET /`、`GET /:path`、`POST /:path` |
| 业务逻辑 | handler 内联 | 文件读写、目录创建、空文件清理 |
| 工具函数 | `randomString()` | 生成随机 URL 路径 |
| 启动监听 | `r.Run(port)` | 监听指定端口 |

### 6.2 前端模块

| 文件 | 职责 |
|------|------|
| `index.html` | 页面骨架；通过 Gin 模板注入 `{{.title}}`（路径作为标题）与 `{{.body}}`（已保存内容回填到 textarea） |
| `static/script.js` | 自动保存核心：每 1 秒轮询比对 `textarea.value` 与上次记录值，不同则 XHR POST 当前内容到当前 URL；同步更新 `#printable` 以支持打印 |
| `static/styles.css` | 全屏 textarea 布局；`@media (prefers-color-scheme: dark)` 暗色适配；`@media print` 隐藏编辑器、显示 `#printable` 打印视图 |
| `static/favicon.svg` | 站点图标（记事本造型的矢量图） |

### 6.3 存储模块（运行时生成）

- **位置**：`./_tmp_/`（相对当前工作目录）
- **命名**：文件名 = URL `:path` 参数原值，无扩展名
- **生命周期**：首次 GET 时创建空文件；POST 时覆盖写入；内容为空时删除文件
- **权限**：目录 `0755`，文件 `0644`

---

## 7. 关键类与函数说明

> 本项目无自定义类型/结构体，全部逻辑由函数与匿名闭包路由组成。以下逐一说明。

### 7.1 `main()`

**位置**：[main.go](file:///workspace/main.go#L14-L132)

**职责**：程序入口，完成框架初始化、路由注册、参数解析与监听启动。

**关键流程**：

1. `gin.SetMode(gin.ReleaseMode)` —— 设为生产模式，关闭调试日志输出（代码中保留了 Debug/Test 模式的注释行）。
2. `r := gin.Default()` —— 创建带 Logger 与 Recovery 中间件的默认引擎。
3. `r.Static("/static", "./static")` —— 挂载静态资源。
4. `r.LoadHTMLGlob("index.html")` —— 加载模板。
5. 注册 3 个路由 handler（见 7.3 ~ 7.5）。
6. `flag.IntVar(&random_int, "l", 10, ...)` 与 `flag.StringVar(&port, "p", ":80", ...)` —— 定义命令行参数。
7. `flag.Parse()` —— 解析参数。
8. `r.Run(port)` —— 阻塞监听。

> **注意**：`flag.Parse()` 在所有路由注册之后才调用，但参数变量 `random_int`、`port` 在路由 handler 闭包中以引用捕获，故监听时已解析完毕，逻辑正确。

### 7.2 `randomString(length int) string`

**位置**：[main.go](file:///workspace/main.go#L134-L142)

**职责**：生成指定长度的随机字符串，用作新记事本的 URL 路径。

**实现要点**：

- 字符集：`abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`（62 个字符）。
- 使用 `math/rand.Intn` —— **非加密安全**，未调用 `rand.Seed`（Go 1.20+ 默认自动种子化，故每次启动序列不同，但仍不可用于安全场景）。
- 长度由 `-l` 参数控制，默认 10。

**示例**：`randomString(8)` → 形如 `aB3xK9mQ`。

### 7.3 路由 `GET /`（根路径重定向）

**位置**：[main.go](file:///workspace/main.go#L32-L35)

**职责**：访问根路径时，生成一个随机字符串并 302 重定向到 `/<randomString>`，从而为用户分配一个新的记事本地址。

**响应**：`http.StatusFound`（302），`Location: /<random>`。

### 7.4 路由 `GET /:path`（读取/创建并渲染）

**位置**：[main.go](file:///workspace/main.go#L37-L73)

**职责**：读取（必要时创建）指定路径对应的记事本文件，并将内容渲染到 `index.html` 模板。

**关键逻辑**：

1. `path := c.Param("path")` —— 取 URL 路径段。
2. `filePath := "./_tmp_/" + path` —— 拼接文件路径。
3. `os.Stat` 判断文件是否存在：
   - 不存在 → `os.MkdirAll(filepath.Dir(filePath), 0755)` 创建 `_tmp_` 目录 → `os.Create(filePath)` 创建空文件。
   - 任一步失败 → 返回 `500 JSON {"error": ...}`。
4. `os.ReadFile(filePath)` 读取内容 → `c.HTML(200, "index.html", gin.H{"title": path, "body": string(fileContent)})`。

**渲染注入**：
- `{{.title}}` → 用于 `<title>` 标签。
- `{{.body}}` → 回填到 `<textarea id="content">{{.body}}</textarea>`。

### 7.5 路由 `POST /:path`（保存内容）

**位置**：[main.go](file:///workspace/main.go#L75-L123)

**职责**：接收前端 POST 的纯文本 body，写入对应文件；若内容为空则删除文件。

**关键逻辑**：

1. `io.ReadAll(c.Request.Body)` —— 读取请求体。
2. `filePath := "./_tmp_/" + path` —— 拼接路径。
3. 确保 `_tmp_/` 目录存在（`os.Mkdir`，忽略已存在）。
4. `os.WriteFile(filePath, body, 0644)` —— 写入文件。
5. **空内容清理**（双保险）：
   - 重新 `os.ReadFile`，若 `len(fileContent) == 0` → `os.Remove`。
   - 若 `len(body) == 0` → `os.Remove` 并返回 `{"status":"Success"}`。
6. 返回 `200 JSON {"status": "Success"}`。

> **观察**：步骤 5 存在重复删除逻辑（先读文件判断空，再判断 body 空），且写入空 body 后又读回判断，逻辑略显冗余，但功能正确。

### 7.6 前端 `checkAndUploadContent()`

**位置**：[static/script.js](file:///workspace/static/script.js#L9-L30)

**职责**：定时检测 textarea 内容变化并自动上传。

**关键逻辑**：

1. 模块级变量 `content` 记录上次上传内容（初始为 `textarea.value`）。
2. 函数内取 `currentContent = textarea.value`，与 `content` 比较：
   - 不同 → 构造 `XMLHttpRequest`，`POST` 到 `window.location.href`（当前页面 URL），`send(currentContent)`；同步更新 `#printable` 文本节点；更新 `content`。
3. `setTimeout(checkAndUploadContent, 1000)` —— 1 秒后递归调用，形成轮询。

**特性**：
- 无防抖/节流，固定 1 秒周期。
- 无错误处理（`request` 未监听 `onerror`/`onload`）。
- `Content-Type` 设为 `application/x-www-form-urlencoded; charset=UTF-8`，但 body 为纯文本（非键值对），服务端 `io.ReadAll` 直接读取原始字节，故能正常工作。

### 7.7 前端样式关键规则

**位置**：[static/styles.css](file:///workspace/static/styles.css)

| 规则 | 作用 |
|------|------|
| `.container` 绝对定位 `top/right/bottom/left: 20px` | 编辑器距视口四边 20px |
| `#content` `width/height: 100%`、`resize: none` | 全屏 textarea，禁用缩放手柄 |
| `@media (prefers-color-scheme: dark)` | 系统暗色模式下切换背景 `#383934`、编辑区 `#282923`、文字 `#f8f8f2` |
| `@media print` | 打印时隐藏 `.container`，显示 `#printable` 并 `white-space: pre-wrap` 保留换行 |

---

## 8. 请求流程时序

### 8.1 首次访问（分配新记事本）

```text
浏览器                Gin(GET /)        Gin(GET /:path)      文件系统
  │  GET /              │                    │                  │
  │────────────────────▶│                    │                  │
  │                     │ randomString(-l)   │                  │
  │                     │ 生成 random        │                  │
  │  302 → /random      │                    │                  │
  │◀────────────────────│                    │                  │
  │  GET /random        │                    │                  │
  │─────────────────────────────────────────▶│                  │
  │                     │                    │ os.Stat(不存在)  │
  │                     │                    │ MkdirAll+Create  │
  │                     │                    │─────────────────▶│
  │                     │                    │ ReadFile(空)     │
  │                     │                    │◀─────────────────│
  │  200 HTML(body="")  │                    │                  │
  │◀─────────────────────────────────────────│                  │
  │  渲染空 textarea     │                    │                  │
```

### 8.2 编辑自动保存

```text
浏览器(script.js)        Gin(POST /:path)      文件系统
  │  用户输入文本         │                       │
  │  1s 轮询：content≠当前 │                       │
  │  POST /:path body=文本│                       │
  │──────────────────────▶│                       │
  │                       │ io.ReadAll(body)      │
  │                       │ Mkdir(确保存在)       │
  │                       │ WriteFile(0644)       │
  │                       │──────────────────────▶│
  │                       │ if 空: Remove         │
  │  200 {"status":"OK"}  │                       │
  │◀──────────────────────│                       │
  │  更新 content=当前    │                       │
  │  setTimeout(1s) 递归  │                       │
```

### 8.3 跨设备读取

```text
设备B 浏览器             Gin(GET /:path)      文件系统
  │  GET /12345678        │                       │
  │──────────────────────▶│                       │
  │                       │ os.Stat(存在)         │
  │                       │ ReadFile(已有内容)    │
  │                       │◀──────────────────────│
  │  200 HTML(body=内容)  │                       │
  │◀──────────────────────│                       │
  │  textarea 回填内容    │                       │
```

---

## 9. 依赖关系

### 9.1 直接依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `github.com/gin-gonic/gin` | v1.11.0 | Web 框架（路由、中间件、模板、静态服务、JSON） |

### 9.2 间接依赖（来自 `go.mod`，按功能分组）

**JSON 序列化（gin 高性能 JSON 栈）**

- `github.com/bytedance/sonic` v1.14.0 + `loader` v0.3.0 —— 字节跳动高性能 JSON 库
- `github.com/goccy/go-json` v0.10.2 —— 备选 JSON 库
- `github.com/json-iterator/go` v1.1.12 —— 兼容标准库的迭代器实现
- `google.golang.org/protobuf` v1.36.9 —— protobuf 支持

**表单/参数校验**

- `github.com/go-playground/validator/v10` v10.27.0 —— gin 默认校验器
- `github.com/go-playground/locales` v0.14.1 / `universal-translator` v0.18.1 —— 校验本地化
- `github.com/leodido/go-urn` v1.4.0 —— URN 解析

**HTTP/3 与 QUIC**

- `github.com/quic-go/quic-go` v0.54.0 + `qpack` v0.5.1 —— QUIC/HTTP3 协议栈（gin v1.11 可启用 HTTP/3）

**编解码与配置**

- `github.com/ugorji/go/codec` v1.3.0 —— msgpack 等编解码
- `github.com/pelletier/go-toml/v2` v2.2.4 —— TOML 解析
- `github.com/goccy/go-yaml` v1.18.0 —— YAML 解析
- `github.com/gabriel-vasile/mimetype` v1.4.8 —— MIME 类型检测

**底层工具**

- `github.com/gin-contrib/sse` v1.1.0 —— Server-Sent Events
- `github.com/cloudwego/base64x` v0.1.6 —— base64 加速
- `github.com/klauspost/cpuid/v2` v2.3.0 —— CPU 特性检测（sonic 用以选 SIMD 路径）
- `github.com/mattn/go-isatty` v0.0.20 —— 终端检测（日志着色）
- `github.com/twitchyliquid64/golang-asm` v0.15.1 —— 汇编生成（sonic JIT）
- `github.com/modern-go/concurrent` / `reflect2` —— 并发与反射工具
- `go.uber.org/mock` v0.5.0 —— mock 测试支持

**Go 扩展库**

- `golang.org/x/crypto` v0.40.0 / `net` v0.42.0 / `sys` v0.35.0 / `text` v0.27.0 / `arch` v0.20.0 / `mod` v0.25.0 / `sync` v0.16.0 / `tools` v0.34.0

### 9.3 依赖关系树（简化）

```text
Minimalist-Web-Notepad-Go
└── github.com/gin-gonic/gin v1.11.0
    ├── gin-contrib/sse            (SSE 支持)
    ├── bytedance/sonic ─┬─ cloudwego/base64x
    │                    ├─ klauspost/cpuid/v2
    │                    └─ twitchyliquid64/golang-asm (JIT)
    ├── go-playground/validator/v10 ─┬─ locales
    │                                 ├─ universal-translator
    │                                 └─ leodido/go-urn
    ├── goccy/go-json                (备选 JSON)
    ├── json-iterator/go ─ modern-go/{concurrent,reflect2}
    ├── ugorji/go/codec              (编解码)
    ├── pelletier/go-toml/v2         (TOML)
    ├── goccy/go-yaml                (YAML)
    ├── gabriel-vasile/mimetype      (MIME 检测)
    ├── mattn/go-isatty              (终端检测)
    ├── quic-go/quic-go ─ qpack      (HTTP/3)
    └── (golang.org/x/* 系列)
```

### 9.4 内部模块依赖

```text
main.go
├── 标准库：flag, io, math/rand, net/http, os, path/filepath
├── 外部库：github.com/gin-gonic/gin
└── 运行时文件：index.html(模板), ./static/*(静态), ./_tmp_/*(存储)

index.html
├── ./static/styles.css
├── ./static/script.js
└── ./static/favicon.svg

static/script.js
└── 依赖 DOM: #content, #printable; 依赖 URL: window.location.href
```

---

## 10. 配置与命令行参数

项目无配置文件，全部通过命令行 `flag` 控制：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `-l` | int | `10` | 根路径重定向时生成的随机字符串长度 |
| `-p` | string | `:80` | 监听端口（Gin `r.Run` 接受 `addr` 字符串，需带冒号） |

**定义位置**：[main.go](file:///workspace/main.go#L29) 与 [main.go](file:///workspace/main.go#L127)。

> 注意：`-p` 默认 `:80` 在非 root 环境下可能因权限不足绑定失败，建议显式指定 `:8080` 等高端口。

---

## 11. 项目运行方式

### 11.1 环境要求

- **Go**：≥ 1.23.0（`go.mod` 声明 `go 1.23.0`，toolchain `go1.24.7`）
- **操作系统**：跨平台（Linux/macOS/Windows），需文件系统写权限

### 11.2 直接运行（开发）

```bash
# 在仓库根目录执行
go run . -l 8 -p :8080
```

访问 `http://localhost:8080/`，将被重定向到 `http://localhost:8080/<8位随机串>`。

### 11.3 编译后运行（生产）

```bash
# 编译（生成与目录同名的可执行文件，或自定义输出名）
go build -o Minimalist-Web-Notepad-Go

# 运行
./Minimalist-Web-Notepad-Go -l 8 -p :8080
```

### 11.4 运行时工作目录约定

程序使用相对路径，**必须从仓库根目录启动**，否则以下路径会失效：

- `./static/`（静态资源）
- `index.html`（模板）
- `./_tmp_/`（存储目录）

### 11.5 使用示例（来自 README）

1. 访问网页根路径，自动分配随机地址（如 `https://example.com:8080/12345678`）。
2. 想用自定义地址，直接在浏览器地址栏修改路径段即可。
3. 在 textarea 中编辑文本。
4. 等待数秒（前端 1 秒轮询 + 网络延迟），服务端即持久化。
5. 在其他设备访问同一 URL，即可读取内容。
6. 关闭网页过快可能丢失最后一次未上传的编辑。

---

## 12. 数据存储机制

### 12.1 存储模型

- **后端**：本地文件系统，无索引、无元数据。
- **目录**：`./_tmp_/`（相对工作目录）。
- **文件名**：URL `:path` 参数的原始字符串（无转义、无扩展名）。
- **文件内容**：纯文本，即用户在 textarea 中的原始字符序列。

### 12.2 读写时序与一致性

| 操作 | 触发 | 文件动作 |
|------|------|----------|
| 首次 GET | 用户访问新路径 | `Stat` → `MkdirAll` → `Create`（空文件）→ `ReadFile` |
| 后续 GET | 用户访问已有路径 | `Stat`(存在) → `ReadFile` |
| POST 保存 | 前端轮询检测到变化 | `Mkdir` → `WriteFile`(覆盖) → 若空则 `Remove` |
| 清空保存 | 用户清空 textarea | `WriteFile`(空) → `Remove` |

### 12.3 并发一致性

- **无锁**：多请求并发写同一文件时，`os.WriteFile` 不保证原子性，可能产生交错写入。
- **无版本控制**：后写覆盖先写，无乐观锁/ETag 机制。
- **无目录清理**：`_tmp_/` 中的非空文件不会被自动清理，需手动维护。

---

## 13. 前端自动保存机制

### 13.1 轮询模型

```text
checkAndUploadContent()
        │
        ▼
  读取 currentContent = textarea.value
        │
        ▼
  currentContent !== content ?
        ├─ 是 ──▶ XHR POST(当前URL, currentContent)
        │         更新 #printable
        │         content = currentContent
        │
        └─ 否 ──▶ (无操作)
        │
        ▼
  setTimeout(checkAndUploadContent, 1000)
```

### 13.2 特性与局限

| 特性 | 说明 |
|------|------|
| 固定 1 秒周期 | 简单可靠，但低频编辑时仍有不必要的比对开销（极小） |
| 差异触发 | 仅内容变化才发请求，减少无效写盘 |
| 无错误重试 | XHR 失败静默丢弃，不重试、不提示 |
| 无防抖 | 快速连续输入时，每秒最多一次写入，可接受 |
| 关闭即丢 | 页面关闭时未触发的最后一次变化会丢失（README 已说明） |
| 无 `beforeunload` | 未监听页面卸载事件做最后一次保存 |

---

## 14. 安全注意事项

> 本项目定位为极简个人工具，安全模型薄弱。以下为客观分析，供部署参考。

### 14.1 路径遍历风险（高）

`GET /:path` 与 `POST /:path` 直接以 `c.Param("path")` 拼接文件路径：

```go
filePath := "./_tmp_/" + path
```

Gin 的 `:path` 单段路由参数 **不含斜杠**（多段需用 `*filepath`），故 `../` 难以通过单段注入。但若未来改为 `*path` 或前置反代未规范化路径，存在目录穿越风险。建议对 `path` 做 `filepath.Base` 清洗。

### 14.2 无鉴权（高）

任何知道 URL 的人均可读取与覆盖内容，无访问控制、无加密。**不应用于敏感信息**。

### 14.3 随机路径非加密安全（中）

`math/rand` 生成的路径可被预测/碰撞。默认长度 10、字符集 62，组合空间 62¹⁰ ≈ 8.4×10¹⁷，暴力枚举不现实，但若 `rand` 未良好播种（Go 1.20+ 已自动种子化），理论可预测。建议改用 `crypto/rand`。

### 14.4 XSS 风险（中）

`index.html` 使用 Gin 模板 `{{.body}}` 回填到 `<textarea>`：

```html
<textarea id="content">{{.body}}</textarea>
```

Gin 的 `html/template` 默认对内容做 HTML 转义，`<textarea>` 内的 `</textarea>` 闭合注入理论上会被转义处理。但 `{{.title}}` 注入到 `<title>{{.title}}</title>`，若路径含特殊字符，需确认转义生效。整体依赖模板引擎默认转义，未显式配置。

### 14.5 无速率限制与容量控制（中）

- 无请求频率限制，可被刷写打满磁盘。
- 无文件大小上限，`io.ReadAll` 可被大 body 耗尽内存。
- 无 `_tmp_` 总量上限。

### 14.6 文件权限宽松（低）

文件 `0644`、目录 `0755`，同主机其他用户可读。多用户主机需收紧。

---

## 15. 已知局限与改进建议

### 15.1 功能局限

| 局限 | 影响 |
|------|------|
| 仅纯文本 | 不支持富文本、图片、附件 |
| 无历史版本 | 后写覆盖先写，无法回滚 |
| 无搜索 | 无法在已有记事本中检索 |
| 单实例 | 无水平扩展能力（文件存储本地化） |
| 关闭丢字 | 未监听 `beforeunload` 做最终保存 |

### 15.2 代码层面建议

1. **空文件清理逻辑冗余**：[main.go:101-118](file:///workspace/main.go#L101-L118) 先读回判断空、再判断 body 空，可简化为 `if len(body) == 0 { os.Remove(filePath); ... }`。
2. **POST 与 GET 的目录创建重复**：GET 用 `MkdirAll`，POST 用 `Mkdir`，建议统一为 `MkdirAll` 并抽函数。
3. **错误处理不一致**：部分用 `c.JSON(500, gin.H{"error": err.Error()})`，部分仅返回固定字符串，建议统一错误响应格式。
4. **路由 handler 内联过重**：可拆分为 `handleGetPath`、`handlePostPath` 函数，便于测试。
5. **`flag.Parse` 位置**：虽逻辑正确，但建议前置到路由注册前，提升可读性。
6. **无单元测试**：仓库无 `_test.go`，建议对 `randomString`、文件读写 handler 补充测试。
7. **无 `.gitignore`**：`_tmp_/` 与编译产物未忽略，建议添加。
8. **随机源**：建议 `math/rand` → `crypto/rand` 以提升路径不可预测性。
9. **前端无错误处理**：XHR 建议加 `onerror` 与状态提示。
10. **`beforeunload` 最终保存**：建议页面卸载时同步发送一次，减少丢字。

### 15.3 部署建议

- 反向代理（Nginx/Caddy）前置，统一处理 TLS、路径规范化、速率限制。
- 以 systemd/容器方式运行，限制工作目录与磁盘配额。
- 定期清理 `_tmp_/` 中长期未访问文件（可加 cron）。
- 监听端口避免 `:80` 默认值，使用非特权端口。

---

## 16. 许可证

项目采用 **WTFPL（Do What The Fuck You Want To Public License）v2**，见 [LICENSE](file:///workspace/LICENSE)。允许任意复制、修改、分发，无任何条件限制。

---

## 附录 A：关键文件速查

| 文件 | 行数 | 核心内容 |
|------|------|----------|
| [main.go](file:///workspace/main.go) | 142 | 后端全部逻辑 |
| [index.html](file:///workspace/index.html) | 16 | 页面模板 |
| [static/script.js](file:///workspace/static/script.js) | 33 | 自动保存 |
| [static/styles.css](file:///workspace/static/styles.css) | 51 | 样式与适配 |
| [go.mod](file:///workspace/go.mod) | 41 | 模块与依赖声明 |
| [README.md](file:///workspace/README.md) | 29 | 运行教程与使用方法 |

## 附录 B：路由速查表

| 方法 | 路径 | 处理 | 响应 |
|------|------|------|------|
| GET | `/` | 生成随机串并重定向 | 302 → `/<random>` |
| GET | `/:path` | 读取/创建文件，渲染模板 | 200 HTML |
| POST | `/:path` | 写入文件，空则删除 | 200 JSON `{"status":"Success"}` |
| GET | `/static/*` | 静态资源服务 | 静态文件 |

---

*本文档生成于仓库当前磁盘状态，如代码后续变更，请同步更新对应章节。*
