# gnome-toolbox

GNOME Shell 聚合工具箱插件（GNOME 51 适配），uuid: `gnome-toolbox@yibin.github`

## 聚合的功能

| 原插件 | 本插件对应模块 | 说明 |
|---|---|---|
| Vitals | `vitals.js` + `indicator.js` | 顶栏实时显示 CPU/内存占用与上下行网速；下拉菜单含温度、磁盘用量详情 |
| Lock Keys | `extension.js` + `indicator.js` | 顶栏显示 Num/Caps Lock 状态，菜单内可直接切换 |
| All-in-One Clipboard | `clipboardManager.js` | 剪贴板历史（去重、可点选回填/粘贴）、隐私模式、一键清空 |
| AppIndicator Support | 移植自 `/usr/share/gnome-shell/extensions/appindicatorsupport@…`（GPL-2.0+） | StatusNotifierItem/AppIndicator/遗留托盘图标接管 |

## 目录结构

- `extension.js` — 装配入口（Extension 基类，ESM 写法）
- `indicator.js` — 顶栏组合指示器 + 下拉菜单
- `vitals.js` — 数据采样（/proc、sysfs 温度、Gio 文件系统信息）
- `clipboardManager.js` — Meta selection 监听 + St.Clipboard 历史
- `schemas/` — GSettings schema（监控开关、刷新间隔、剪贴板条数、托盘外观）
- 其余 `appIndicator.js`、`dbusMenu.js` 等 — 托盘子系统（原样移植）

## 构建安装

```bash
./build-install.sh
```

打包为 `gnome-toolbox@yibin.github.shell-extension.zip` 并 `gnome-extensions install`。

## GNOME 51 适配要点

- `St.BoxLayout` 用 `orientation: Clutter.Orientation.HORIZONTAL`，不再有 `vertical` 属性
- `Clutter.get_default_backend()` 已移除，改用 `global.stage.get_context().get_backend()`
- 扩展目录监视被移除：新装/重装扩展后必须注销重登（或重启 gnome-shell），shell 只在会话启动时扫描扩展目录

## 启用

```bash
gnome-extensions enable gnome-toolbox@yibin.github
```

与旧插件的托盘总线名（`org.kde.StatusNotifierWatcher`）互斥，启用前需禁用 `appindicatorsupport@rgcjonas.gmail.com`。

## 卸载

```bash
gnome-extensions disable gnome-toolbox@yibin.github
gnome-extensions uninstall gnome-toolbox@yibin.github
```

## License

GPL-2.0, see [LICENSE](LICENSE). The tray subsystem (appIndicator.js, dbusMenu.js, etc.) is ported from AppIndicator Support (GPL-2.0+).
