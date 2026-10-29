/**
 * 把 `test/loader.mjs` 注册进当前进程。
 *
 * 用 `node --import ./test/register-loader.mjs` 启动测试；动态 import 也会
 * 经过同一个解析钩子。
 */

import { register } from 'node:module'

register('./loader.mjs', import.meta.url)
