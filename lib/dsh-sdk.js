import { readFileSync } from 'node:fs'

const SDK = '@deepseek-ai/dsh-tools'
const expectedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).peerDependencies[SDK]
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function reject(code, message) {
  const error = new Error(`[${code}] ${message}`)
  error.name = 'DshSdkError'
  error.code = code
  throw error
}

// DSH-only bootstrap. MCP never imports this module or the optional host SDK.
// Check metadata before loading SDK code, so a mismatched package cannot execute
// first or hide the diagnostic behind a missing named export.
export async function loadDshSdk() {
  let metadataUrl
  try { metadataUrl = import.meta.resolve(`${SDK}/package.json`) }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') reject('SDK_MISSING', `DSH 入口缺少 ${SDK}。请通过匹配的 DSH 宿主安装插件；仅使用 MCP 时请启动 veriscope-mcp，无需安装 DSH SDK。`)
    reject('SDK_INCOMPATIBLE', `无法核对 ${SDK} 的版本信息。请使用包含 ${expectedVersion} 的已验证 DSH 宿主。`)
  }
  let metadata
  try { metadata = JSON.parse(readFileSync(new URL(metadataUrl), 'utf8')) }
  catch { reject('SDK_INCOMPATIBLE', `无法读取有效的 ${SDK} 版本信息。请检查宿主安装；需要 ${expectedVersion}。`) }
  if (metadata?.name !== SDK || typeof metadata.version !== 'string' || metadata.version.length > 64 || versionPattern.exec(metadata.version)?.[0] !== metadata.version) {
    reject('SDK_INCOMPATIBLE', `${SDK} 的版本信息无效；需要 ${expectedVersion}。`)
  }
  if (metadata.version !== expectedVersion) reject('SDK_INCOMPATIBLE', `${SDK} 版本不兼容：需要 ${expectedVersion}，当前为 ${metadata.version}。请使用已验证的 DSH 宿主。`)
  let sdk
  try { sdk = await import(SDK) }
  catch { reject('SDK_LOAD_FAILED', `${SDK} 无法加载。请核对匹配的 DSH 宿主及其依赖是否完整；插件不会自动安装或切换 SDK。`) }
  if (typeof sdk.defineTool !== 'function') reject('SDK_INCOMPATIBLE', `${SDK} 缺少可用的 defineTool 接口。请检查 ${expectedVersion} 的宿主安装。`)
  return sdk
}
