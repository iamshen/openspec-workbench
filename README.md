# OpenSpec Workbench

Browse, validate, and archive [OpenSpec](https://github.com/Fission-AI/OpenSpec) changes from Obsidian. Preview task checkmarks, specification changes, and affected links before archiving.

OpenSpec Workbench is a desktop plugin for Windows. The interface is in Simplified Chinese.

## Requirements

- Obsidian 1.12.7 or later on Windows.
- Node.js 20.19 or later and a separate installation of the OpenSpec CLI. Verified with OpenSpec 1.14.1.
- A Vault that is the project root containing `openspec/`, or the project's `openspec/` folder itself.

Install the CLI with `npm install -g @fission-ai/openspec`. Once listed, OpenSpec Workbench can be installed from **Community plugins**. For a manual installation, place `main.js`, `manifest.json`, and `styles.css` in `.obsidian/plugins/openspec-workbench/` and enable the plugin. If CLI detection fails, enter the full paths to `node.exe` and `openspec.js` in the plugin settings.

## 使用

1. 从命令面板运行 **查找提案**，按标题、目录名或主仓库搜索，切换活动提案和已归档提案。
2. 在活动提案的文件夹或笔记上右键，选择 **归档提案**。**已完成** 会按预览同步正式规范。**历史方案**、**撤回提案**和**历史收拢**会跳过规范同步。
3. 选择需要标记完成的任务，查看预览并确认。未勾选的任务保留原状态。遇到同名目标时可以打开已有归档。
4. 如果提案已移动，归档说明或索引尚未写完，运行 **继续更新归档文档**。

标准项目按 OpenSpec 目录浏览提案，归档目录名沿用 CLI 的规则。**Xrzc 索引适配** 额外维护活动与归档 README。已有这两张 Xrzc 索引表的 Vault 会自动启用适配，可以在设置中关闭。

## Local file access

- The plugin runs a separately installed local OpenSpec CLI from the project root. Archiving applies the selected task checkmarks and specification changes, moves the change, and updates the archive note and affected Markdown links inside the Vault.
- Preview runs the CLI on copies in the system temporary directory. The plugin removes these copies when preview ends.
- If the Vault opens `openspec/` directly and **Xrzc 索引适配** is enabled, the plugin also reads the parent project's `HANDOFF.MD` and Markdown files under `docs/`. It lists references for the user to update.
- The plugin processes document contents locally and disables OpenSpec CLI telemetry. Install and update the CLI separately.

## Build and release

Run `npm ci` followed by `npm run build`. Upload `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` to the GitHub Release whose tag matches the version in `manifest.json`. Follow the [Obsidian submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) for the first release.

## License

[MIT](LICENSE). See [NOTICE](NOTICE) for OpenSpec attribution. Licenses for bundled packages are included in `main.js`.
