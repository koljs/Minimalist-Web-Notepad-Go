# Minimalist Web Notepad - Cloudflare 部署指南

> 本文档指导你将极简网页记事本部署到 **Cloudflare Pages + Functions + R2**,实现通过自定义域名访问、数据持久化到 R2 对象存储。
>
> 部署完成后访问你的域名,即可进入网页记事本进行临时文本记录,数据保存在 Cloudflare R2。
>
> 本版本为**增强版**,在前端与后端均做了安全与体验增强(见第 1 节)。

---

## 目录

1. [架构概述](#1-架构概述)
2. [前置条件](#2-前置条件)
3. [目录结构](#3-目录结构)
4. [方式一:命令行部署(wrangler)](#4-方式一命令行部署wrangler)
5. [方式二:Git 集成部署(推荐)](#5-方式二git-集成部署推荐)
6. [配置 R2 绑定(关键步骤)](#6-配置-r2-绑定关键步骤)
7. [绑定自定义域名](#7-绑定自定义域名)
8. [验证与测试](#8-验证与测试)
9. [故障排查](#9-故障排查)
10. [成本说明](#10-成本说明)
11. [与原 Go 项目的对照](#11-与原-go-项目的对照)
12. [安全与限制](#12-安全与限制)

---

## 1. 架构概述

```text
┌─────────────────────────────────────────────────────────┐
│  用户浏览器                                              │
│   访问 https://你的域名/                                 │
└───────────────▲─────────────────────────▲───────────────┘
                │ GET /(重定向)           │ GET/POST /api/<path>
                │ GET /<path>(HTML)       │
                │ GET /static/*(静态)     │
┌───────────────┴─────────────────────────┴───────────────┐
│  Cloudflare Pages + Functions(边缘运行)                 │
│   functions/[[path]].js(增强版)                         │
│   - GET  /           → 生成随机串(crypto 安全),302 重定向│
│   - GET  /<path>     → 返回 public/index.html           │
│   - GET  /api/<path> → R2.get() + ETag/304 协商缓存     │
│   - POST /api/<path> → 频率限制(60次/分)→ R2.put/delete │
│   - 路径白名单        → 仅允许 [A-Za-z0-9_-]            │
│   - GET  /static/*   → Pages 静态资源托管               │
│  前端增强:                                               │
│   - beforeunload + sendBeacon 最终保存                  │
│   - 保存成功/失败状态提示条                              │
└───────────────▲─────────────────────────────────────────┘
                │ R2 Binding(env.NOTEPAD)
┌───────────────┴─────────────────────────────────────────┐
│  Cloudflare R2 Bucket(notepad)                          │
│   key = URL 路径段, value = 纯文本内容                  │
└─────────────────────────────────────────────────────────┘
```

**核心特点**:
- 全球边缘节点,低延迟
- R2 无出口流量费
- 无服务器维护,自动扩缩容
- 数据持久化在 R2,跨设备同步

**增强功能(相较首版)**:
- 前端:`beforeunload` 最终保存(sendBeacon)、保存成功/失败状态提示
- 后端:路径白名单校验、ETag/304 协商缓存、POST 频率限制(60 次/分钟)

---

## 2. 前置条件

| 条件 | 说明 |
|------|------|
| Cloudflare 账号 | 免费即可,注册 https://dash.cloudflare.com/sign-up |
| Node.js(仅命令行部署需要) | ≥ 18,用于运行 wrangler CLI |
| 域名(可选) | 若要用自定义域名,需将域名 DNS 托管到 Cloudflare |
| Git 仓库(仅 Git 集成需要) | GitHub/GitLab 均可 |

---

## 3. 目录结构

```text
cloudflare/
├── functions/
│   └── [[path]].js              # Pages Functions(增强版):路由 + R2 读写 + 白名单 + ETag + 频率限制
├── public/                      # Pages 静态资源根目录
│   ├── index.html               # 纯静态 HTML(含 #status 状态提示元素)
│   └── static/
│       ├── script.js            # 前端(增强版):自动保存 + 客户端渲染 + beforeunload + 状态提示
│       ├── styles.css           # 样式(亮/暗色 + 打印 + 状态提示条)
│       └── favicon.svg          # 图标
├── wrangler.toml                # Cloudflare 配置
└── DEPLOY.md                    # 本部署文档
```

> `[[path]].js` 文件名中的双方括号是 Cloudflare 的 **splat 路由**语法,匹配任意层级路径,使单个文件处理所有路由。

---

## 4. 方式一:命令行部署(wrangler)

适合首次快速验证或一次性部署。

### 4.1 安装 wrangler

```bash
npm install -g wrangler
# 或用 npx 临时运行,无需全局安装
```

### 4.2 登录 Cloudflare

```bash
wrangler login
```

执行后浏览器会打开授权页面,点击 Allow 即可。

### 4.3 创建 R2 bucket

```bash
wrangler r2 bucket create notepad
```

> 若提示 bucket 已存在,可跳过此步。
> 注意:bucket 名 `notepad` 是独立专用 bucket,不要复用同账号下其他项目(如云盘 `cloud-pan`)的 bucket,否则会被云盘的孤儿清扫功能误删。

### 4.4 部署 Pages

```bash
cd cloudflare
wrangler pages deploy public --project-name minimalist-web-notepad
```

首次部署会自动创建 Pages 项目。部署成功后输出形如:

```text
✨ Successfully deployed!
https://minimalist-web-notepad.pages.dev
```

### 4.5 配置 R2 绑定

命令行部署**不会自动**应用 `wrangler.toml` 中的 R2 绑定到 Pages 项目,需在 Dashboard 手动配置(见第 6 节)。

---

## 5. 方式二:Git 集成部署(推荐)

适合长期维护,每次 `git push` 自动部署。

### 5.1 推送代码到 Git 仓库

将本仓库推送到 GitHub/GitLab,确保 `cloudflare/` 目录在仓库中。

### 5.2 在 Dashboard 创建 Pages 项目

1. 登录 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 选择你的仓库,授权 Cloudflare 访问
3. 配置构建设置:

| 设置项 | 值 |
|--------|-----|
| Project name | `minimalist-web-notepad` |
| Production branch | `main`(或你的主分支) |
| Framework preset | `None` |
| Build command | 留空 |
| Build output directory | `public` |
| Root directory | `cloudflare` |

4. 点击 **Save and Deploy**

### 5.3 等待首次部署完成

Dashboard 会显示构建日志,成功后得到 `*.pages.dev` 域名。

### 5.4 后续更新

每次向主分支 `git push`,Cloudflare 自动重新部署。

---

## 6. 配置 R2 绑定(关键步骤)

**无论哪种部署方式,都必须完成此步,否则数据无法保存**(Function 会返回 `R2 binding not configured`)。

### 6.1 进入绑定配置页

Dashboard → **Workers & Pages** → 选择你的 Pages 项目 → **Settings** → **Functions** → **R2 bucket bindings**

### 6.2 添加绑定

| 字段 | 值 |
|------|-----|
| Variable name | `NOTEPAD`(必须与代码中 `R2_BINDING` 常量一致) |
| R2 bucket | 选择 `notepad` |

### 6.3 保存并重新部署

绑定配置变更后,需要触发一次重新部署才生效:
- Git 集成方式:随便推一个 commit,或点 Dashboard 的 Retry deployment
- 命令行方式:重新执行 `wrangler pages deploy public`

### 6.4 验证绑定生效

部署后访问 `https://你的域名/api/test`,若返回空字符串(而非 `R2 binding not configured`),说明绑定成功。

---

## 7. 绑定自定义域名

### 7.1 前提

- 域名已添加到 Cloudflare(在 Dashboard → Add a site)
- 域名 DNS 由 Cloudflare 管理(nameservers 已切换)

### 7.2 添加自定义域名

1. Pages 项目 → **Custom domains** → **Set up a custom domain**
2. 输入你的域名(如 `notepad.example.com`)
3. Cloudflare 自动添加 CNAME 记录指向 Pages
4. 等待 DNS 生效(通常几分钟),状态变为 Active

### 7.3 访问

浏览器打开 `https://notepad.example.com`,即进入记事本。

---

## 8. 验证与测试

### 8.1 基本功能测试

| 步骤 | 预期 |
|------|------|
| 访问 `https://你的域名/` | 自动跳转到 `/<10位随机串>` |
| 在 textarea 输入文本 | 等 1-2 秒,右上角出现绿色"已保存"提示 |
| 刷新页面 | 输入的内容仍在 |
| 换浏览器/设备访问同一 URL | 看到之前保存的内容 |
| 清空 textarea 并等待 | 刷新后仍为空(R2 对象被删除) |

### 8.2 API 直测

```bash
# 写入
curl -X POST https://你的域名/api/mytest -d "Hello R2"

# 读取
curl https://你的域名/api/mytest
# 预期输出: Hello R2

# 删除(发送空 body)
curl -X POST https://你的域名/api/mytest -d ""

# 确认已删除
curl https://你的域名/api/mytest
# 预期输出: (空)
```

### 8.3 增强功能测试

| 测试项 | 操作 | 预期 |
|--------|------|------|
| 状态提示 | 输入文本等待 1-2 秒 | 右上角绿色"已保存"提示,3 秒后淡出 |
| 保存失败提示 | 断网后输入文本 | 右上角红色"网络错误,保存失败"提示 |
| beforeunload 保存 | 输入文本后立即关闭页面,再重开同一 URL | 内容仍在(sendBeacon 已发送) |
| ETag 缓存 | F12 → Network,刷新页面,查看 `/api/<path>` | 第二次起状态为 304(灰底),无 body 传输 |
| 频率限制 | 1 分钟内快速 POST 60+ 次 | 第 61 次返回 429,前端显示"操作过快",60s 后自动恢复 |
| 路径白名单 | 访问 `/api/测试` 或 `/api/a b` | 返回 400 Bad Request |
| 内容大小限制 | POST 超过 10MB 内容 | 返回 413,前端显示"内容过大,保存失败" |
| 保存失败重试 | 断网编辑后恢复网络 | 失败内容自动重试保存(不再丢失) |

### 8.4 查看存储

Dashboard → R2 → 选择 bucket,可看到对象列表,key 即 URL 路径段。

---

## 9. 故障排查

### 9.1 访问域名显示 `R2 binding not configured`

**原因**:R2 绑定未配置或未生效。
**解决**:按第 6 节配置 `NOTEPAD` 绑定,然后重新部署。

### 9.2 内容保存后刷新消失

**原因**:R2 绑定未生效,或前端 `apiPath` 推导错误。
**排查**:
- 浏览器 F12 → Network,查看 POST `/api/<path>` 请求返回是否为 `{"status":"Success"}`
- 若返回 500,检查 R2 绑定
- 若前端报 CORS 错误(本方案同源不应出现),检查域名配置

### 9.3 `wrangler pages deploy` 报权限错误

**解决**:
```bash
wrangler logout
wrangler login
```

### 9.4 Git 集成部署后 Function 不生效

**原因**:`Root directory` 或 `Build output directory` 配置错误。
**解决**:确认 Root directory = `cloudflare`,Build output directory = `public`。Functions 目录 `functions/` 必须与 `public/` 同级,位于 `cloudflare/` 下。

### 9.5 自定义域名访问返回 522 / 525

**原因**:DNS 未生效或 SSL 模式不正确。
**解决**:
- 等待 DNS 传播(最多 48 小时,通常几分钟)
- Dashboard → 域名 → SSL/TLS → 模式设为 `Full` 或 `Full (strict)`

### 9.6 随机串页面 404

**原因**:`[[path]].js` 路由未匹配。
**排查**:确认文件名是 `[[path]].js`(双方括号),不是 `[path].js` 或 `index.js`。

### 9.7 首次编辑后内容被清空

**原因**:可能是旧版浏览器缓存了 script.js。
**解决**:强刷(Ctrl+F5)或清除缓存。

### 9.8 保存时提示"操作过快,请稍候"(429)

**原因**:POST 频率超过 60 次/分钟,触发频率限制。
**解决**:
- 正常使用不会触发(轮询每秒最多 1 次)
- 若误触发,等待 60 秒后自动恢复
- 如需调整阈值,修改 `functions/[[path]].js` 中的 `RATE_LIMIT` 常量

### 9.9 自定义路径返回 400 Bad Request

**原因**:路径含白名单外的字符(仅允许字母、数字、下划线、连字符)。
**解决**:修改路径为合法字符,如 `/api/my-note_1`。

### 9.10 保存时提示"内容过大,保存失败"(413)

**原因**:单次 POST body 超过 10MB 上限(`MAX_BODY_SIZE`)。
**解决**:
- 精简内容后重试
- 如需更大上限,修改 `functions/[[path]].js` 中的 `MAX_BODY_SIZE` 常量(注意 Function 内存限制)

### 9.11 限流后多久恢复

**说明**:POST 频率限制为 60 次/分钟,超限后返回 429。
**恢复机制**(已修复死锁):
- 超限后后端**不再更新计数**,旧记录按原 TTL(60s)自然过期
- 60 秒后计数归零,自动恢复
- 前端在 429/网络错误时会**回滚 content 自动重试**,不会丢失未保存内容

---

## 10. 成本说明

| 项目 | 免费额度 | 本项目典型用量 |
|------|---------|---------------|
| Pages 静态请求 | 无限 | 不计费 |
| Pages Functions 调用 | 10 万次/天 | 每次自动保存 1 次,1 秒轮询仅变化才请求 |
| R2 存储 | 10 GB/月 | 单条记事本通常 < 10 KB |
| R2 写操作(Class A) | 100 万次/月 | 编辑保存即 1 次写 |
| R2 读操作(Class B) | 1000 万次/月 | 打开页面即 1 次读;ETag 命中时省 body 读取 |
| R2 出口流量 | **免费**(R2 无出口费) | - |

**结论**:个人使用基本零成本。仅当 Function 调用超 10 万次/天(约等同每秒持续编辑 1.16 次,全天不停)才需付费($5/月起)。

---

## 11. 与原 Go 项目的对照

| 维度 | 原 Go 项目 | Cloudflare 版本(增强版) |
|------|-----------|----------------|
| 运行时 | Go + Gin 长驻进程 | Pages Functions 事件驱动 |
| 存储 | 本地文件系统 `./_tmp_/` | R2 对象存储 |
| 随机串 | `math/rand`(非加密安全) | `crypto.getRandomValues`(密码学安全) |
| 内容渲染 | Gin 模板 `{{.body}}` 服务端渲染 | 客户端 `fetch` 加载 |
| 路由 | `GET/POST /:path` 混用 | 页面 `/<path>` 与 API `/api/<path>` 分离 |
| 空内容处理 | 读回判断 + body 判断(冗余) | 直接 `if body空 then delete` |
| 前端轮询启动 | 立即启动(有覆盖风险) | 加载完成后再启动(修复) |
| 关闭丢字防护 | 无 | `beforeunload` + `sendBeacon` 最终保存 |
| 保存反馈 | 无,静默 | 成功/失败状态提示条 |
| 路径校验 | 仅拒绝 `..` | 白名单 `[A-Za-z0-9_-]` |
| GET 缓存 | 无 | ETag/304 协商缓存 |
| 写频率限制 | 无 | POST 60 次/分钟(Cache API) |
| 水平扩展 | 单实例,文件本地化 | 全球边缘,天然分布式 |
| 部署 | 编译二进制 + systemd/容器 | `wrangler deploy` 或 git push |
| 运维 | 需维护服务器 | 无服务器 |

---

## 12. 安全与限制

### 12.1 安全特性

- **随机串密码学安全**:使用 Web Crypto API,不可预测
- **路径白名单**:仅允许 `[A-Za-z0-9_-]`,拒绝穿越与特殊字符
- **POST 频率限制**:基于 Cache API,60 次/分钟,防止刷写
- **GET 缓存控制**:ETag/304 协商,减少不必要的 R2 读
- **无端口暴露**:全部走 Cloudflare 边缘,无需开放服务器端口
- **自动 HTTPS**:Cloudflare 自动签发 TLS 证书

### 12.2 已知限制

| 限制 | 说明 |
|------|------|
| 无鉴权 | 知道 URL 的人均可读写,勿存敏感信息 |
| 无版本历史 | 后写覆盖先写,无法回滚 |
| 频率限制为单节点级 | Cache API 仅在同数据中心共享,跨节点不共享(可在 Dashboard 加 WAF Rate Limiting 补强) |
| 单条记事本上限 10MB | POST body 超过 10MB 返回 413;R2 单对象虽支持 5GB 但记事本场景无需 |
| 无 `_tmp_` 自动清理 | R2 对象不会自动过期,可配置 R2 Lifecycle 规则清理长期未访问对象 |

### 12.3 增强 R2 对象过期(可选)

若希望记事本内容自动过期清理,在 R2 bucket → Settings → Object Lifecycle Rules 添加规则:
- 按 `Last modified` 时间,如 30 天后删除
- 或按前缀/标签精细化控制

---

## 附录:常用命令速查

```bash
# 登录
npx wrangler login

# 创建 R2 bucket (独立专用,勿复用云盘等项目的 bucket)
npx wrangler r2 bucket create notepad

# 部署 Pages
cd cloudflare
npx wrangler pages deploy public --project-name minimalist-web-notepad

# 本地开发(需先配置 .dev.vars 或本地 R2 绑定)
npx wrangler pages dev public

# 查看 Pages 项目列表
npx wrangler pages project list

# 查看 R2 对象列表
npx wrangler r2 object list notepad

# 删除某个对象
npx wrangler r2 object delete notepad/<key>
```

---

*如有部署问题,参考第 9 节故障排查,或检查 Cloudflare Dashboard 的部署日志与 Function 实时日志。*
