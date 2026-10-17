import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReviewError } from './errors.js'
import { verifyContract } from './source.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const CONTRACT_FILES = Object.freeze(['scripts/gate_replay.py', 'backend/config.py', 'backend/core/gate.py', 'backend/core/types.py', 'backend/core/attribution.py', 'backend/core/regression.py', 'backend/__init__.py', 'backend/core/__init__.py'])
const PROFILE_FILES = ['contracts/upstream.json', 'contracts/upstream-lf.json']

function validate(contract, complete) {
  if (!contract || typeof contract !== 'object' || !contract.files || Array.isArray(contract.files) || !Object.keys(contract.files).length || Object.values(contract.files).some(value => typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value))) throw new ReviewError('CONTRACT_INVALID', '执行器契约缺少有效的固定文件摘要。')
  if (complete && (Object.keys(contract.files).length !== CONTRACT_FILES.length || CONTRACT_FILES.some(key => !Object.hasOwn(contract.files, key)) || typeof contract.contract !== 'string' || /^[a-zA-Z0-9._-]{1,128}$/.exec(contract.contract)?.[0] !== contract.contract)) throw new ReviewError('CONTRACT_INVALID', '执行器契约不是经过审阅的完整文件集合。')
  return contract
}

export function loadContractProfiles(options = {}) {
  if (options.contract) {
    let contract
    try { contract = JSON.parse(JSON.stringify(options.contract)) } catch { throw new ReviewError('CONTRACT_INVALID', '执行器契约无法封存。') }
    validate(contract, false)
    Object.freeze(contract.files)
    return [Object.freeze(contract)]
  }
  try {
    return PROFILE_FILES.map(relative => {
      const filename = path.join(options.pluginRoot ?? ROOT, relative), stat = fs.statSync(filename)
      if (!stat.isFile() || stat.size > 65536) throw new Error('contract file size')
      return validate(JSON.parse(fs.readFileSync(filename, 'utf8')), true)
    })
  } catch (error) {
    if (error instanceof ReviewError) throw error
    throw new ReviewError('CONTRACT_INVALID', '无法读取经过审阅的完整执行器契约；请从可信版本重新安装。')
  }
}

export function selectContract(root, options = {}) {
  if (options.selectedContract) {
    const selected = options.selectedContract
    validate(selected.contract, !options.contract)
    return { ...selected, files: verifyContract(root, selected.contract) }
  }
  const profiles = loadContractProfiles(options)
  for (const contract of profiles) {
    try {
      const files = verifyContract(root, contract)
      return { contract, contractId: contract.contract ?? 'service-override', files }
    } catch (error) { if (error.code !== 'CONTRACT_MISMATCH') throw error }
  }
  throw new ReviewError('CONTRACT_MISMATCH', '上游文件没有完整匹配任一已审阅契约；拒绝混合契约、未审阅代码或逐文件拼接。')
}
