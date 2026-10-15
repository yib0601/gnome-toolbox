# gnome-toolbox

GNOME Shell 聚合工具箱插件（GNOME 51 适配），uuid: `gnome-toolbox@yibin.github`

## 聚合的功能

| 原插件 | 本插件对应模块 | 说明 |
|---|---|---|
| Vitals | `features/vitals.js` | 顶栏实时显示 CPU/内存占用与上下行网速；下拉菜单只补顶栏没有的温度与磁盘用量（顶栏已有项不重复入菜单） |
| Lock Keys | `features/lockkeys.js` | Num/Caps Lock 状态变化时弹出 OSD 提示 |
| All-in-One Clipboard | `features/clipboard.js` | 剪贴板历史（去重、可点选回填/粘贴）、隐私模式、一键清空、复制时 OSD 屏显提示 |
| AppIndicator Support | `tray/`（移植自 `appindicatorsupport@…`，GPL-2.0+） | StatusNotifierItem/AppIndicator/遗留托盘图标接管 |
| 通知定时关闭（本项目新增） | `features/notifications.js` | 气泡通知完整显示 N 秒（默认 6s）后自动收起，通知保留并进入顶部日历的通知列表；鼠标停在气泡上时推迟收起，移开后重新计时 |

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
  notifications.js      通知气泡定时收起（挂钩 MessageTray 状态机）
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

## 通知定时关闭的实现约束（GNOME 51）

`features/notifications.js` 依赖几处 shell 内部行为，改动前先对照 `shell-src/`：

- 挂钩点是 `Main.messageTray._updateState`。GNOME 51 的 `Notification` **没有** `banner-shown` / `banner-hidden` 信号，也没有 `banner-hints` 属性，横幅从显示到收起的全部转换只经过 `_updateState()`，只能从那里驱动倒计时。
- 收起走 `Main.messageTray._expireNotification()`，即 shell 自己的过期路径（等价于按 Esc），通知因此进入顶部日历的通知列表而不是被销毁。shell 自身的超时受 `_userActiveWhileNotificationShown` 约束 —— 该字段记录「横幅弹出时用户是否活跃」（`_updateState()` 取 `get_idletime() <= 1000`），用户当时不在电脑前时 shell 会跳过超时、挂着横幅等下次活动（用户活跃时反而是 shell 自己先收）。`_expireNotification()` 没有这层约束，插件因此在无人值守时也能收掉气泡。
- 该调用在 shell 处于自身状态机内部（`_updatingState`）或横幅被屏蔽（`_bannerBlocked`，扩展面板在右区、菜单打开时成立）时会被吞掉，且那条提前返回同时跳过 `_notificationExpired` 的清理 —— 残留标志会让下一条横幅瞬间消失。所以插件在不能落地时直接跳过，在没落地时显式清标志。
- 鼠标守卫不能用 `_bannerBin`（它是 `x_expand/y_expand` 的整屏容器）也不能用 `_notificationHovered`（即 `_bannerBin.hover`）或 `_banner.expanded`（shell 对 CRITICAL 与 force-expanded 源会自动展开，用它会让紧急通知开关永久失效）。判定以 `_banner` 这个横幅 actor 的几何 + shell 的 `_pointerInNotification` 为准。

通知超时不是 `org.gnome.desktop.notifications` 的公开键（该 schema 只有 `show-banners` / `show-in-lock-screen`），
所以倒计时由插件自己维护，配置项为 `notification-hide-delay`（秒）与 `auto-hide-critical-notifications`。

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
