# ClawMail

ClawMail 是一个 Docker-ready 的 ClawEmail 收件箱项目，也可以打包成 Windows 桌面安装程序。它保留原来的 IMAP 同步核心，并增加了 Web 管理界面、访客密钥访问、邮箱订阅到期管理和到期日历。

## 功能说明

- 管理员模式：添加邮箱、手动刷新单个邮箱、查看/重置访客密钥、删除邮箱、设置密钥有效期、设置邮箱订阅到期时间。
- 访客模式：输入邮箱对应的访客密钥后，只能访问该密钥绑定的邮箱。
- 默认首页是访客模式，管理员需要手动切换到管理员登录页。
- 访客使用密钥进入时，会立即刷新对应邮箱；平时不会后台刷新全部邮箱，避免邮箱数量多时卡顿。
- 邮箱订阅到期时间只用于倒计时和日历管理，不会阻止访客访问。
- 密钥有效期会控制访客是否还能进入邮箱。
- 管理员默认账号密码是 `admin` / `admin`，第一次登录会提示修改密码。

## Docker 部署

首次启动前可以编辑 `docker-compose.yml`：

- `CLAWMAIL_ADMIN_USERNAME`：管理员账号，默认 `admin`。
- `CLAWMAIL_ADMIN_PASSWORD`：初始管理员密码，默认 `admin`。
- `CLAWMAIL_MASTER_KEY`：用于加密保存 IMAP 凭据的主密钥。添加邮箱后不要再修改，否则旧凭据无法解密。
- `CLAWMAIL_REFRESH_COOLDOWN_MS`：访客手动刷新冷却时间，默认 `60000` 毫秒。

启动：

```bash
docker compose up -d
```

访问：

```text
http://服务器IP:8080
```

## Windows 桌面版

Windows 安装包会以内置本地 Web 服务的方式启动，打开后仍然是同一套管理员/访客界面。桌面版数据默认保存在系统用户数据目录中。

本地构建 Windows 安装包：

```bash
npm install
npm run dist:win
```

构建产物位置：

```text
release/ClawMail-0.1.1-Windows-x64.exe
```

说明：在 macOS 或 Linux 上直接构建 Windows 安装包可能需要额外的 Wine/NSIS 环境。推荐使用 GitHub Actions 的 Windows runner 构建，避免本机环境差异。

## 本地开发

启动 Web 构建：

```bash
npm install
npm run build
CLAWMAIL_DATA_DIR=./data CLAWMAIL_ADMIN_PASSWORD=admin CLAWMAIL_MASTER_KEY=development-master-key node dist/server/index.js
```

访问：

```text
http://127.0.0.1:8080
```

## 常用操作

1. 访客访问：打开首页，输入访客密钥，点击“进入并刷新”。
2. 管理员登录：切换到管理员模式，使用 `admin` / `admin` 首次登录并修改密码。
3. 添加邮箱：管理员粘贴 ClawEmail Hermes 安装命令或 `t1/` 开头的 auth-url。
4. 查看密钥：在邮箱行点击查看密钥图标，可以显示完整访客密钥并复制。
5. 时间管理：在邮箱行点击时间管理图标，可以设置密钥有效期和邮箱订阅到期时间，支持快速设置 7/14/30 天。
6. 到期日历：管理员切换到日历页，可以按日期查看哪些密钥或邮箱订阅即将到期。

## 安全说明

- IMAP auth code 会加密后写入本地数据目录。
- 访客密钥会以哈希形式保存在 SQLite 中，完整密钥只在生成、重置或管理员查看时展示。
- 公开部署时建议在容器前增加 HTTPS 反向代理。
- 第一次部署后请及时修改默认管理员密码。

## English Summary

ClawMail is a Docker-ready ClawEmail inbox with admin and guest-key access. Guest access refreshes only the selected mailbox on demand. Admins can add mailboxes, refresh one mailbox, view/reset guest keys, configure key expiration, track mailbox subscription dates, and manage dates in a calendar view.
