# zxfw-online-filing

面向律师办案场景的人民法院在线服务网（`zxfw.court.gov.cn`）自动化网上立案 Skill（基于 Playwright）。

给定一个包含 PDF 材料的案件目录和 `case.json`，脚本可自动完成创建草稿、选择法院、上传各槽位材料、引入常用材料、填写当事人及代理人信息，并停在「预览和提交」页面等待人工核对后手动点击提交。

## 适用范围

- **支持**：民事一审网上立案（默认）、首次强制执行立案（`--zhixing`）
- **暂不支持**：刑事、行政、二审/再审、诉前保全、支付令等其他立案类型
- **安全边界**：脚本永远不会点击最终「提交」按钮；每一步均需人工核对确认

## 快速安装

### 方式一：直接交给 AI 智能体安装（推荐）

直接把本仓库链接和下面这段话发给你的 AI 智能体（Claude Code / Antigravity / Cursor / WorkBuddy 等）：

```text
帮我安装这个网上立案 skill：https://github.com/Goodman1888/zxfw-online-filing
1. 克隆到本地的 skills 目录；
2. 装好 scripts/ 下的 npm 和 Playwright Chromium 依赖；
3. 帮我把默认代理人（姓名、电话、律所地址）和常用材料名称改成我自己的，之后先跑一次让我扫码登录人民法院在线服务网。
```

### 方式二：手动安装

1. 克隆本仓库到你的 AI Agent skills 目录（例如 `~/.claude/skills/zxfw-online-filing` 或 `~/.gemini/config/skills/zxfw-online-filing`）：

```bash
git clone https://github.com/Goodman1888/zxfw-online-filing.git
```

2. 安装 Node.js 依赖与 Chromium：

```bash
cd zxfw-online-filing/scripts
npm install
npx playwright install chromium
```

3. 首次运行并在弹出的浏览器中扫码登录人民法院在线服务网（登录态保存在本地 `.chrome-profile/`，请勿上传或分享该目录）。

## 使用方式

准备案件材料目录（起诉状、身份证明、委托手续、证据材料等 PDF）及 `case.json` 后运行：

```bash
node filing.js "/path/to/case-dir" \
  --court "某市某区人民法院" --province "某省" --city "某市" \
  --lawyers "张律师"
```

- 因不同账号在平台内的「常用材料 / 常用联系人」命名不同，请根据自身账号实际情况在命令行传入 `--plaintiff-cert`、`--certs`、`--cause`，或在 `case.json` 中配置 `plaintiff`、`plaintiffInfo`、`agentPhone`、`agentAddress` 等字段。
- 详细字段说明、命令行参数、执行立案续跑与常见避坑指南见 [SKILL.md](./SKILL.md) 及 [references/execution-resume.md](./references/execution-resume.md)。
