/**
 * 启动 doctor：项目自身与框架版本的兼容性。
 *
 * 插件侧的 peer 校验在 catalog 扫描时完成；项目侧只看 `package.json` 对
 * `cordis-app` 的依赖范围。两者都在启动时执行，因此用户绕过 CLI 直接安装
 * 的包同样会被检查。
 *
 * 项目没有声明 `cordis-app` 依赖时只产生 warning：某些开发布局（例如把
 * 框架通过工作区软链进来）可能刻意不写依赖，阻断启动会让它们无法运行。
 * 但「依赖存在却不兼容」是硬错误——继续启动只会在运行中炸得更难排查。
 */

import { readFileSync } from 'node:fs'
import semver from 'semver'
import { CORE_PACKAGE, FRAMEWORK_VERSION } from '@cordis-app/protocol'

export interface ProjectFrameworkCheck {
  ok: boolean
  /** 没有声明依赖（或 package.json 不可读）：调用方应警告而不是硬失败 */
  missing?: boolean
  reason?: string
}

export function checkProjectFramework(
  packageJson: unknown,
  frameworkVersion: string = FRAMEWORK_VERSION,
): ProjectFrameworkCheck {
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    return {
      ok: false,
      missing: true,
      reason: '项目缺少可解析的 package.json，无法校验 cordis-app 依赖',
    }
  }

  const pkg = packageJson as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const range = pkg.dependencies?.[CORE_PACKAGE] ?? pkg.devDependencies?.[CORE_PACKAGE]
  if (!range) {
    return {
      ok: false,
      missing: true,
      reason: `项目 package.json 没有声明 ${CORE_PACKAGE} 依赖，无法确认框架版本兼容性`,
    }
  }

  let satisfied: boolean
  try {
    satisfied = semver.satisfies(frameworkVersion, range, { includePrerelease: true })
  } catch {
    return { ok: false, reason: `项目声明的 ${CORE_PACKAGE} 依赖范围无法解析: ${range}` }
  }
  if (!satisfied) {
    return {
      ok: false,
      reason: `项目依赖 ${CORE_PACKAGE}@${range} 与当前框架版本 ${frameworkVersion} 不兼容`,
    }
  }

  return { ok: true }
}

/** 读取项目 package.json 后再做 doctor；文件缺失按 missing 处理。 */
export function checkProjectFrameworkFile(
  packageJsonPath: string,
  frameworkVersion: string = FRAMEWORK_VERSION,
): ProjectFrameworkCheck {
  try {
    return checkProjectFramework(JSON.parse(readFileSync(packageJsonPath, 'utf8')), frameworkVersion)
  } catch {
    return {
      ok: false,
      missing: true,
      reason: `无法读取项目 ${packageJsonPath}，无法校验 cordis-app 依赖`,
    }
  }
}
