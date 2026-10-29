# archcanvas Codex 版试用说明

[下载 0.5.2 试用包](https://github.com/931482694/archcanvas-codex/releases/tag/codex-v0.5.2) · [反馈问题](https://github.com/931482694/archcanvas-codex/issues)

版本：0.5.2。适合先在 Windows 上试用。无需参与开发或提交代码。

## 1. 准备

- 安装支持插件和 hooks 的 Codex，并正常登录。
- 安装 Node.js 24 LTS，保证终端中 `node --version` 能显示版本。
- 如果使用 GitHub 安装方式，还需要 Git 和仓库读取权限。ZIP 本地安装不需要访问发布者的 GitHub 仓库。

目前实际验证环境是 Windows、Node.js 24 和 Codex Desktop 自带 CLI 0.165.0-alpha.1.2。其他系统尚未实测。

## 2. 安装 ZIP 试用包（现在可用）

1. 将 `archcanvas-codex-0.5.2.zip` 完整解压到一个固定文件夹，不要只取里面的插件子目录。
2. 在解压后的根文件夹打开 PowerShell。这里应能看到 `README.md`、`.agents` 和 `codex` 文件夹。
3. 执行：

   ```powershell
   codex plugin marketplace add .
   ```

4. 在 Codex 的插件管理中找到来源 **claude-mods** 下的 **archcanvas** 并安装。也可以在 Codex CLI 中输入 `/plugins` 打开插件管理。
5. 在 **Codex CLI 的交互输入框**输入 `/hooks`，审阅 archcanvas 的 PreToolUse、PostToolUse、UserPromptSubmit 三项，选择信任。桌面聊天输入框不一定支持这个命令；直接把它作为聊天消息发送不等于完成信任。
6. 在 Codex 中打开自己的项目文件夹，开启新会话。

如果 `codex` 命令不存在，或提示不支持 `plugin marketplace`，请先安装/更新支持插件的 Codex CLI，或把报错发给提供插件的同事。不要下载来历不明的安装脚本。

如果此前已安装同名 `claude-mods` 来源，请先执行 `codex plugin marketplace list` 确认当前来源，避免误把正式来源切换成另一份目录。

## 3. 首次使用

在自己的项目会话中说：

> 请阅读这个项目的源码，生成初始架构图，然后打开架构画布。数据文件只看目录，不读内容。

看到画布后，可以查看模块、文件与连线。要修改项目时，在画布上写提议、交付待办，再回到 Codex 发送“处理画布上的提议”。浏览器按钮不会直接启动 Codex 执行。

建议首次用一个小型示例项目完成一次“生成图 → 提议 → 交付 → 查看修改记录”的流程。

## 4. 从本仓库安装固定版本

在终端执行：

```powershell
codex plugin marketplace add https://github.com/931482694/archcanvas-codex.git --ref codex-v0.5.2
```

接着按第 2 节完成插件安装与钩子审阅。私有仓库需要读取权限；仅有链接并不能访问。

## 5. 更新与移除

- ZIP：收到新版后解压到新的固定文件夹，从该目录添加 marketplace，再在插件管理中更新或重新安装 archcanvas。确认新版可用前保留旧包。
- GitHub：按发布者给的新标签重新添加来源，再更新插件。固定在旧标签时，不会自动变成新版本。
- 更新后检查 `/hooks`。显示“已修改”时，重新审阅并信任，然后开启新会话。
- 不再使用：在插件管理中卸载 archcanvas。项目内 `.archcanvas` 保存架构图和修改历史，卸载插件不意味着这些项目记录已删除；请按需要保留。

## 6. 使用范围与反馈

画布服务只监听本机。Codex 读取源码和执行任务仍使用你自己的 Codex 账户；“本机画布”不表示 AI 推理离线运行。

命令原始输出不会自动打码。敏感项目中读取非敏感源码请使用绝对路径；钩子会拒绝无法确定目标的相对路径内容读取。钩子规则不是系统文件权限隔离。

宿主没有回传退出码时，工作记录会注明“结果已返回；宿主未提供退出码”。旧快照没保存大文件内容时，会注明“无法比较”，不会猜测修改行数。

遇到问题，请把下面内容发给提供插件的同事：

- 插件版本、系统、Codex 与 Node.js 版本；
- 做了哪几步、期望看到什么、实际发生什么；
- 报错文字或截图，以及能否重复出现。

截图前隐藏项目中的个人信息、数据内容和密钥。不需要提交修改分支，也不用发送整个项目或完整对话记录。

安装参考：[OpenAI 插件打包与来源](https://developers.openai.com/plugins/build/plugins)、[钩子审阅说明](https://learn.chatgpt.com/docs/hooks)。
