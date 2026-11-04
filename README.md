# gnome-toolbox

GNOME Shell 聚合工具箱插件（GNOME 51 适配），uuid: `gnome-toolbox@yibin.github`

## 聚合的功能

| 原插件 | 本插件对应模块 | 说明 |
|---|---|---|
| Vitals | `features/vitals.js` | 顶栏实时显示 CPU/内存占用与上下行网速；下拉菜单只补顶栏没有的温度与磁盘用量（顶栏已有项不重复入菜单） |
| Lock Keys | `features/lockkeys.js` | Num/Caps Lock 状态变化时弹出 OSD 提示 |
| All-in-One Clipboard | `features/clipboard.js` | 剪贴板历史（文本 + 图片、去重、可点选回填/粘贴）、隐私模式、一键清空、复制时 OSD 屏显提示、截图格式归一（BMP 伪装 PNG → 真 PNG） |
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

## 剪贴板图片记录的实现约束（GNOME 50）

`features/clipboard.js` 要同时处理文本和图片，依赖以下几处 shell/St 行为（改动前对照 `shell-src/` 与 `st-clipboard.c`）：

- `St.Clipboard` 只认 4 个文本 mimetype（`text/plain;charset=utf-8`、`UTF8_STRING`、`text/plain`、`STRING`）。截图类剪贴板（GNOME 自带 PrtSc「截图已捕获」、微信 Alt+A）**只提供 `image/*`**，一个文本类型都没有，所以纯文本历史必然漏掉截图。`get_text()` 在无匹配类型时回调 `text = NULL`，这是「不是文本」的判定信号。
- 抓取前先用 `get_mimetypes()` 看当前 owner 真正提供什么，再决定取文本还是取图片，不再盲目轮询 4 个文本类型。空列表 == 没有 owner（剪贴板被清空），此时不弹提示也不入库。
- `get_current_owner()` 在 gnome-shell 50 的 typelib 里**未导出**，只能用 `get_mimetypes()` 判空。
- 声明的 mimetype 不可信：微信 Linux 把同一份 **BMP** 字节挂在 `image/png`、`image/jpeg`、`image/bmp` 等所有名字下。因此一律按字节 `GdkPixbuf.PixbufLoader` 解码，再用 `save_to_bufferv('png')` 转 PNG 入库；解码失败就试下一个候选类型。
- 列表缩略图用 `St.ImageContent`（它是 `Gio.Icon`，`St.Icon.gicon` 能直接吃；`st_texture_cache_load_gicon()` 对 `ST_IS_IMAGE_CONTENT` 有专门分支，不会重复解码）。`set_bytes()` 要 `RGBA_8888` 紧凑排列，截图多为 3 通道 BGR，必须先 `add_alpha()`。
- 取图/取文的回调可能不回来（owner 卡住），`_fetch()` 里有 3s 兜底并在 settle 时移除该 timer。

## 截图格式归一（BMP 伪装 PNG）

微信 Alt+A 的 Qt 截图器把**同一份 BMP 字节**挂在 `image/png`、`image/jpeg`、`image/webp`、`image/bmp`、`application/x-qt-image` 所有名字下。解码党（本项目历史、GdkPixbuf、ImageMagick）都能正常显示，但**信声明类型的消费方会拒收**——浏览器把 `file.type` 报成 `image/png` 却拿到 `BM` 魔数，DSH 的附件管线用 sharp 解码直接判 `INVALID_IMAGE`（提示「仅支持 PNG、JPG、WebP、GIF 格式的图片」）。

归一路径（`ClipboardManager.normalizeScreenshot()`）：

- 用 `loader.get_format().get_name()` 取**真实容器名**（`bmp`/`tiff`/`png`…），与声明类型无关。这是判断「声明是否撒谎」的唯一可靠依据。
- 真实格式属于 `NATIVE_FORMATS`（png/jpeg/webp/gif）→ 直接返回 `native`，**不重编码、不抢剪贴板所有权**，所以连按两次快捷键不会产生新字节。
- 否则 `save_to_bufferv('png')` 重编码，用 `set_content(CLIPBOARD, 'image/png', bytes)` 写回。`_writeImageBytes()` 统一处理 `_busy` / `_internalWrite` / `_pendingFetch`，避免触发自己的「复制成功」提示和回抓。
- 纯文本剪贴板返回 `no-image` 并静默退出，绝不覆盖用户正在粘贴的文本。

三个入口共用同一实现：

| 入口 | 行为 |
|---|---|
| 菜单「截图转 PNG」 | 手动触发，静默执行。**仅当剪贴板里确实躺着一张伪装格式图片时才出现**（见下） |
| 快捷键（默认 `Ctrl+Alt+V`） | `Main.wm.addKeybinding('normalize-shortcut', …)` 直接吃 schema 的 `as` 键，改设置即时生效 |
| `normalize-on-copy`（默认关） | 图片落地剪贴板即自动转换，在历史条目入库之后执行，转换失败不损失抓取 |

`normalize-screenshots` 是总开关：关掉时菜单项隐藏、快捷键注销、自动转换不触发。

菜单项还有第二层条件：只有最近一次抓到的剪贴板图片，其**真实容器**不属于 png/jpeg/webp/gif 时才可见（`ClipboardManager.needsNormalize` + `normalize-changed` 信号驱动）。这个应急动作不再常驻在剪贴板历史区上方——此前它与「清空历史」、历史条目混排，看起来像一条错乱的历史记录。快捷键不受这层条件限制，随时可用。

**归一化全程静默**：不弹 OSD、不弹通知。按键本身已是明确意图，每次截图都回一条提示纯属噪音；失败只写 journal（`gnome-toolbox: screenshot normalize: …`）供排查。与上图「复制时 OSD 屏显提示」完全解耦——那个开关只管复制提示，与转换无关。

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
