# full-body

自定义项目 body 的参考示例：布局由项目决定，但四个宿主出口一个都不少。

`body.tsx` 是完整可用的源码，复制到项目即可：

```bash
cp examples/full-body/body.tsx /tmp/cordis-demo/src/body.tsx
node packages/cli/lib/cli.js dev --project /tmp/cordis-demo
```

示例只依赖脚手架已经生成的 `src/pages/Home.tsx` 与框架公开出口，复制后无需再
改 import。

## 它演示了什么

| 出口 | 写法 |
| --- | --- |
| pages | 项目页面表优先匹配；未命中时用 `<PluginPageOutlet path={path} fallback={…} />` |
| slots | `<PluginSlot name="header.right" />`、`<PluginSlot name="activity.bottom" />` |
| menus | `<PluginMenuTrigger menuId="activity">` 把品牌按钮绑定到活动菜单 |
| settings | `path === SETTINGS_PATH` 时渲染 `<SettingsPanel />`，并保留设置入口 |

与 `DefaultBody` 的区别：

- `DefaultBody` 是框架附带的完整布局，开箱即用；本示例展示如何换掉布局而仍然
  兼容插件。
- 项目页面优先于插件页面。同路径时示例会在开发期 `console.warn`，避免
  「插件装了但看不到」被误判成插件故障。
- 样式刻意留空（只有语义化 class）。body 不 import CSS，样式属于项目自己的
  前端入口，按需补即可。

## 验证

框架的验收测试会把这份 `body.tsx` 复制进一个新建项目并执行真实的
`buildProject`，确认它能在保留出口的同时被 Vite 正常打包。
