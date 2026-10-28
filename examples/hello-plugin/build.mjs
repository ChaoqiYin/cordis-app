/**
 * 插件构建入口。
 *
 * 服务端与前端是两次独立的 esbuild 调用：目标平台不同（node24 / browser），
 * external 规则也不同——这正是 preset 不封装成一条命令的原因。
 */

import { build } from 'esbuild'
import { clientPreset, serverPreset } from '@cordis-app/preset'

const shared = { sourcemap: true }

await Promise.all([
  build(serverPreset({ entry: 'src/server.ts', outfile: 'lib/server.js', ...shared })),
  build(clientPreset({ entry: 'src/client.tsx', outfile: 'lib/client.js', ...shared })),
])
