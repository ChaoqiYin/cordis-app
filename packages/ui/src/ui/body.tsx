/**
 * SPA 的 body 选择点。
 *
 * 默认使用框架提供的参考实现。项目模式（#7）会把这个模块替换成项目自己的
 * body，而 `cordis-app/ui` 的宿主出口保持稳定。
 */

export { DefaultBody as default } from '../host/DefaultBody.js'
