import { relative, resolve, join } from 'pathe'
import consola from 'consola'
import * as rollup from 'rollup'
import fse from 'fs-extra'
import { printFSTree } from './utils/tree'
import { getRollupConfig } from './rollup/config'
import { prettyPath, writeFile, isDirectory, replaceAll, serializeTemplate } from './utils'
import { scanMiddleware } from './server/middleware'
import type { Nitro } from './types'

export async function prepare (nitro: Nitro) {
  await cleanupDir(nitro.options.output.dir)

  if (!nitro.options.output.publicDir.startsWith(nitro.options.output.dir)) {
    await cleanupDir(nitro.options.output.publicDir)
  }

  if (!nitro.options.output.serverDir.startsWith(nitro.options.output.dir)) {
    await cleanupDir(nitro.options.output.serverDir)
  }
}

async function cleanupDir (dir: string) {
  consola.info('Cleaning up', prettyPath(dir))
  await fse.emptyDir(dir)
}

export async function copyPublicAssets (nitro: Nitro) {
  consola.start('Generating public...')

  const clientDist = resolve(nitro.options.buildDir, 'dist/client')
  if (await isDirectory(clientDist)) {
    await fse.copy(clientDist, join(nitro.options.output.publicDir, nitro.options.publicPath))
  }

  const publicDir = nitro.options.publicDir
  if (await isDirectory(publicDir)) {
    await fse.copy(publicDir, nitro.options.output.publicDir)
  }

  consola.success('Generated public ' + prettyPath(nitro.options.output.publicDir))
}

export async function build (nitro: Nitro) {
  // Compile html template
  const htmlSrc = resolve(nitro.options.buildDir, 'views/app.template.html')
  const htmlTemplate = { src: htmlSrc, contents: '', dst: '' }
  htmlTemplate.dst = htmlTemplate.src.replace(/.html$/, '.mjs').replace('app.template.mjs', 'document.template.mjs')
  htmlTemplate.contents = nitro.vfs[htmlTemplate.src] || await fse.readFile(htmlTemplate.src, 'utf-8').catch(() => '')
  if (htmlTemplate.contents) {
    await nitro.hooks.callHook('nitro:document', htmlTemplate)
    const compiled = 'export default ' + serializeTemplate(htmlTemplate.contents)
    await writeFile(htmlTemplate.dst, compiled)
  }

  nitro.options.rollupConfig = getRollupConfig(nitro)
  await nitro.hooks.callHook('nitro:rollup:before', nitro)
  return nitro.options.dev ? _watch(nitro) : _build(nitro)
}

export async function writeTypes (nitro: Nitro) {
  const routeTypes: Record<string, string[]> = {}

  const middleware = [
    ...nitro.scannedMiddleware,
    ...nitro.options.middleware
  ]

  for (const mw of middleware) {
    if (typeof mw.handle !== 'string') { continue }
    const relativePath = relative(nitro.options.buildDir, mw.handle).replace(/\.[a-z]+$/, '')
    routeTypes[mw.route] = routeTypes[mw.route] || []
    routeTypes[mw.route].push(`Awaited<ReturnType<typeof import('${relativePath}').default>>`)
  }

  const lines = [
    '// Generated by nitro',
    'declare module \'nitopack\' {',
    '  type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T',
    '  interface InternalApi {',
    ...Object.entries(routeTypes).map(([path, types]) => `    '${path}': ${types.join(' | ')}`),
    '  }',
    '}',
    // Makes this a module for augmentation purposes
    'export {}'
  ]

  await writeFile(join(nitro.options.buildDir, 'nitro.d.ts'), lines.join('\n'))
}

async function _build (nitro: Nitro) {
  nitro.scannedMiddleware = await scanMiddleware(nitro.options.srcDir)
  await writeTypes(nitro)

  consola.start('Building server...')
  const build = await rollup.rollup(nitro.options.rollupConfig).catch((error) => {
    consola.error('Rollup error: ' + error.message)
    throw error
  })

  consola.start('Writing server bundle...')
  await build.write(nitro.options.rollupConfig.output)

  const rewriteBuildPaths = (input: unknown, to: string) =>
    typeof input === 'string' ? replaceAll(input, nitro.options.output.dir, to) : undefined

  // Write build info
  const nitroConfigPath = resolve(nitro.options.output.dir, 'nitro.json')
  const buildInfo = {
    date: new Date(),
    // preset: nitro.options.preset,
    commands: {
      preview: rewriteBuildPaths(nitro.options.commands.preview, '.'),
      deploy: rewriteBuildPaths(nitro.options.commands.deploy, '.')
    }
  }
  await writeFile(nitroConfigPath, JSON.stringify(buildInfo, null, 2))

  consola.success('Server built')
  await printFSTree(nitro.options.output.serverDir)
  await nitro.hooks.callHook('nitro:compiled', nitro)

  // Show deploy and preview hints
  // TODO
  // const rOutDir = relative(process.cwd(), nitro.options.output.dir)
  if (nitro.options.commands.preview) {
    // consola.info(`You can preview this build using \`${rewriteBuildPaths(nitroContext.commands.preview, rOutDir)}\``)
    // consola.info('You can preview this build using `nuxi preview`')
  }
  if (nitro.options.commands.deploy) {
    // consola.info(`You can deploy this build using \`${rewriteBuildPaths(nitro.options.commands.deploy, rOutDir)}\``)
  }

  return {
    entry: resolve(nitro.options.rollupConfig.output.dir, nitro.options.rollupConfig.output.entryFileNames as string)
  }
}

function startRollupWatcher (nitro: Nitro) {
  const watcher = rollup.watch(nitro.options.rollupConfig)
  let start: number

  watcher.on('event', (event) => {
    switch (event.code) {
      // The watcher is (re)starting
      case 'START':
        return

      // Building an individual bundle
      case 'BUNDLE_START':
        start = Date.now()
        return

      // Finished building all bundles
      case 'END':
        nitro.hooks.callHook('nitro:compiled', nitro)
        consola.success('Nitro built', start ? `in ${Date.now() - start} ms` : '')
        nitro.hooks.callHook('nitro:dev:reload')
        return

      // Encountered an error while bundling
      case 'ERROR':
        consola.error('Rollup error: ' + event.error)
      // consola.error(event.error)
    }
  })
  return watcher
}

async function _watch (nitro: Nitro) {
  let watcher = startRollupWatcher(nitro)
  nitro.scannedMiddleware = await scanMiddleware(nitro.options.srcDir,
    (middleware, event) => {
      nitro.scannedMiddleware = middleware
      if (['add', 'addDir'].includes(event)) {
        watcher.close()
        writeTypes(nitro).catch(console.error)
        watcher = startRollupWatcher(nitro)
      }
    }
  )
  await writeTypes(nitro)
}
