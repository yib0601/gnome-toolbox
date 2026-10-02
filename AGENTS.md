# gnome-toolbox 开发规则（AI 必读）

本机：Fedora，GNOME Shell 版本以 `gnome-shell --version` 为准（当前抽源时记录于 `shell-src/SHELL-VERSION`）。

## 1. shell-src/ 是 API 唯一事实源

`shell-src/` 是从**当前已安装**的 `/usr/lib64/gnome-shell/libshell-<版本>.so` 抽出的官方 JS 源码（`./sync-shell-src.sh` 生成），**不进 git**。

写任何调用 `resource:///org/gnome/shell/ui/*` 的代码前，必须先 `read`/`grep` `shell-src/ui/<模块>.js` 确认：
- 目标符号是否存在、导出名是什么（`export`/`export const`/`export default`）
- 构造函数/方法签名是否和记忆一致（GNOME 45+ 大改过多次：ESM import、`GObject.registerClass`、`imports.ui.*` 已废除、PanelMenu 构造方式、appMenu 拆分等）
- 信号名与回调签名（grep `emit(` / `connect(` 定位）

**禁止凭模型记忆写 shell JS API。** 记忆只用来缩小排查范围，落笔前一律对照 `shell-src/` 原文。若 `shell-src/SHELL-VERSION` 与 `gnome-shell --version` 不一致，先跑 `./sync-shell-src.sh` 再动手。

## 2. 结构检索走 codegraph

项目已有 `.codegraph/` 索引。改扩展代码前用 `codegraph_explore(projectPath=/home/yibin/Code/gnome-toolbox)` 查调用链与影响面，不要凭猜。`shell-src/` 未入索引，用 grep/read。

## 3. 修改后必过验证闭环

1. `node --check` 所有改动文件（ESM 语法）
2. `./build-install.sh`（内含语法检查 + schema 编译 + 打包安装）
3. **运行时验证**：改完必须验证扩展真实加载——`journalctl -f` 观察注销/重登录后无 `JS ERROR` / `Extension <uuid> had error`。Wayland 下 shell 模块有 ESM 缓存，改了必须注销重登录才生效，`gnome-shell -r` 不可用
4. 验证通过前不得声称完成

## 4. 参考对照（可选）

`/usr/share/gnome-shell/extensions/` 下有官方维护的参考扩展（apps-menu、places-menu、window-list 等），都是跟随当前版本更新的，遇到同类功能先对照它们的写法。

## 5. 踩坑回写

本项目反直觉的坑（某 API 在某版本行为变化、信号时序、缓存陷阱等）经用户同意后回写笔记仓库 `mcp__search-notes__search_notes` 可检索的 `.notes`。
