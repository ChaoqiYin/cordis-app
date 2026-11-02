/**
 * 把 `cordis-app/package.json` 的版本同步到协议层的版本常量。
 *
 * 版本号只能有一个真源：聚合包的 package.json。运行时 manifest、CLI 的
 * frameworkVersion 与 peer 校验都从 `FRAMEWORK_VERSION` 读取，而这个常量
 * 由本脚本生成；测试会校验生成结果与 package.json 一致，防止手改漂移。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageJsonPath = join(here, '..', 'package.json')
const target = join(here, '..', '..', 'protocol', 'src', 'version.ts')

const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
if (typeof version !== 'string' || version.length === 0) {
  throw new Error(`${packageJsonPath} 缺少合法的 version`)
}

const content = `/**
 * 框架版本常量（生成文件，请勿手改）。
 *
 * 唯一真源是 packages/cordis-app/package.json 的 version。
 * 由 packages/cordis-app/scripts/sync-version.mjs 生成。
 */
export const FRAMEWORK_VERSION = '${version}'
`

writeFileSync(target, content)
console.log(`  FRAMEWORK_VERSION = ${version}  ← packages/cordis-app/package.json`)
