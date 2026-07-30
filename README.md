# 流畅切换动画 · Fluid Transitions

给 SillyTavern / TauriTavern 的页面切换加上手机 App 那种进出动效。手机、电脑同一套代码。

## 管了哪些地方

| 位置 | 效果 |
| --- | --- |
| 顶栏下拉面板（API / 世界书 / 高级格式化 / 用户设置 / 背景 / 扩展 / 用户角色） | 下移 + 缩放 + 淡入，关闭反向 |
| 左右侧边栏（AI 配置栏 / 角色栏） | 从屏幕边缘滑入；手机上是整屏推入 |
| 面板互切 | 旧面板滑出与新面板滑入交叠，形成交叉过渡 |
| 弹窗 | 换掉原生的纵向压扁，改成缩放 + 上浮 + 淡入 |
| 切换聊天 / 角色 | 聊天区淡入上浮 |
| 新消息 | 单条淡入上浮（整屏重绘时不重复播放） |
| 启动 | 顶栏与聊天区依次淡入 |
| 顶栏图标 | 按下缩一下，选中的略放大 |

每一项都能单独关。风格三档：轻快（纯淡入）/ 顺滑（推入，默认）/ 弹性（带回弹）；时长 120–480ms。

## 安装

**方式 A：手动**
把 `manifest.json` / `index.js` / `style.css` 放进酒馆数据目录的
`extensions/fluid-transitions/`，重启客户端。

**方式 B：Git URL（推荐）**
在酒馆「扩展 → 安装扩展」里填 `https://github.com/tqzbceb/animation`。
更新也点同一处重装即可。

装好后设置在「扩展」面板里，标题是「流畅切换动画」。

## 设计约定

- 动画本体用 Web Animations API，不依赖 `calc-size()` / `@starting-style`，老 WebView 也能跑。
- 不改任何 DOM 结构，只加 class 和动画；关掉开关后原生的过渡属性逐字还原。
- 勾了酒馆的「减少动画」或系统开启了 prefers-reduced-motion 时自动让位给原生行为（可关）。
- 侧边栏横滑期间会临时给 `<html>` 加 `overflow: hidden`，避免手机上闪一条横向滚动条。
- 低端手机可以打开「动画期间关闭毛玻璃」换帧率。

## 调试

控制台里有 `fluidTransitions`：

```js
fluidTransitions.cfg()            // 取当前设置对象，改完调 apply()
fluidTransitions.apply()          // 让改动生效
fluidTransitions.preview()        // 重播一次面板动画
fluidTransitions.launch()         // 重播启动动画
fluidTransitions.teardown()       // 完全卸下，回到原生行为
```

在 TauriTavern v1.6.5（SillyTavern 1.16 系）上开发并测试。
