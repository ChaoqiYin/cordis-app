/**
 * 配置 schema 的实现选择。
 *
 * 选 schemastery 而非 zod 的理由：`role()` 提供的 UI 元数据
 * 是设置面板自动生成的前提。附带好处是 cordis 3.18.1 自身也用 schemastery。
 *
 * schemastery 是 `export =` 风格的 CJS 包，所以只能默认导入再转发。
 */
import Schema from 'schemastery'

export { Schema }
export default Schema
