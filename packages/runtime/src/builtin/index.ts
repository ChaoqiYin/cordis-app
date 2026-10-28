/** 内置插件清单：顺序即中间件顺序，不要随意调整。 */

import type { Middleware, RequestView } from './server.js'

export { apply as server } from './server.js'
export { apply as router } from './router.js'
export { apply as static } from './static.js'
export { apply as ws } from './ws.js'
export { apply as auth } from './auth.js'
export { apply as storage } from './storage.js'

export type { Middleware, RequestView }
