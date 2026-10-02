# gnome-toolbox

GNOME Shell 聚合工具箱插件（GNOME 51 适配），uuid: `gnome-toolbox@yibin.github`

## 聚合的功能

| 原插件 | 本插件对应模块 | 说明 |
|---|---|---|
| Vitals | `features/vitals.js` | 顶栏实时显示 CPU/内存占用与上下行网速；下拉菜单含温度、磁盘用量详情 |
| Lock Keys | `features/lockkeys.js` | Num/Caps Lock 状态变化时弹出 OSD 提示 |
| All-in-One Clipboard | `features/clipboard.js` | 剪贴板历史（去重、可点选回填/粘贴）、隐私模式、一键清空、复制时 OSD 屏显提示 |
| AppIndicator Support | `tray/`（移植自 `appindicatorsupport@…`，GPL-2.0+） | StatusNotifierItem/AppIndicator/遗留托盘图标接管 |

每个功能对应一个 `PanelFeature` 实现，可在设置中单独启停（`enable-*` 开关，热生效）。

## 目录结构

```
extension.js            装配入口：feature 注册表、开关热启停、面板位置
indicator.js            顶栏外壳（PanelMenu.Button + 顶栏 actor 条 + 共享菜单）
core/
  feature.js            PanelFeature 基类（所有功能实现该契约）
  settings.js           gsettings 单例（原 settingsManager.js）
  logger.js             结构化日志
  input.js              共享虚拟键盘 / keymap 获取（防 use-after-free）
features/               自研功能，一文件一 Feature
  vitals.js             VitalsSampler 采样 + 顶栏/菜单展示
  lockkeys.js           Num/Caps Lock 监听与 OSD 提示
  clipboard.js          ClipboardManager + 菜单展示
  tray.js               AppIndicator 通道包装（watcher 启停）
tray/                   移植子系统（与上游 appindicator 结构一一对应）
  appIndicator.js dbusMenu.js dbusProxy.js dbusUtils.js iconCache.js
  indicatorStatusIcon.js interfaces.js pixmapsUtils.js promiseUtils.js
  statusNotifierWatcher.js trayIconsManager.js util.js
  interfaces-xml/       DBus 接口定义
  tools/busAnalyzer.js  独立调试脚本（gjs 运行）
schemas/                GSettings schema
```

约定：`core/`、`features/` 为本项目代码，可自由演进；`tray/` 保持与上游
appindicator 可比对，仅允许 import 路径等机械改动，不掺入自研逻辑。

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
