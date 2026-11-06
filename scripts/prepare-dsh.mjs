// Build only the editor-neutral SDK; no DSH, React, or host plugin dependencies.
import { spawnSync } from 'node:child_process'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'

const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.dsh.json'], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
const target = 'out/vendor/dsh-editor-socket'
await mkdir(`${target}/lib`, { recursive: true })
await writeFile(`${target}/package.json`, JSON.stringify({ name: 'dsh-editor-socket-sdk', type: 'module' }))
await copyFile('vendor/dsh-editor-socket/LICENSE', `${target}/LICENSE`)
for (const file of ['plug.js', 'discovery.js', 'protocol.js']) {
  await copyFile(`vendor/dsh-editor-socket/lib/${file}`, `${target}/lib/${file}`)
}
